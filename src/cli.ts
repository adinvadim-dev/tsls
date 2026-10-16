#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { collectHosts } from "./collect.js";
import { bounded, defaultPath, loadConfig } from "./config.js";
import { UsageError } from "./model.js";
import { renderHuman, renderPlain } from "./output.js";

export const VERSION = "0.1.1";
const HELP = `tsls ${VERSION} — free RAM and available disk across your machines

Usage: tsls [host-label...] [options]
       tsls init [--config /absolute/path.json]

Examples:
  tsls                       All configured hosts, in config order
  tsls laptop buildbox       Select configured labels
  tsls --json                Versioned JSON snapshot, byte units
  tsls --plain               Stable TSV, empty means unknown
  tsls --timeout 3 --concurrency 4
  tsls init                  Create a local-only config without overwriting

Options:
  --config PATH              Absolute config path (or TSLS_CONFIG)
  --timeout SECONDS          Per-host budget, integer 1–120 (default 5)
  --concurrency COUNT        Parallel probes, integer 1–32 (default 4)
  --json                     Machine-readable schemaVersion: 1
  --plain                    Stable TSV with a header
  --no-color                 Disable color (output currently uses no ANSI)
  -h, --help                 Show help, ignoring other arguments
  --version                  Print version

Config: $XDG_CONFIG_HOME/tsls/config.json or ~/.config/tsls/config.json
Precedence: flags > TSLS_TIMEOUT/TSLS_CONCURRENCY > config > defaults.
Only explicit configured hosts are queried. No project config or discovery.
No password prompts. SSH uses your existing aliases, keys and known_hosts.
Exit: 0 all ok; 1 runtime/partial failure; 2 usage/config error; 130 Ctrl-C.
Docs: https://github.com/adinvadim-dev/tsls#readme
`;
const SAMPLE = {
  version: 1,
  timeout: 5,
  concurrency: 4,
  hosts: [{ label: "laptop", transport: "local" }],
};
function integer(
  value: string | undefined,
  fallback: number,
  name: string,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new UsageError(`${name} must be an integer`);
  return bounded(Number(value), name, 1, max);
}
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.includes("--version")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error(
      "tsls clients support macOS and Linux; Windows is not yet supported",
    );
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: "string" },
        timeout: { type: "string" },
        concurrency: { type: "string" },
        json: { type: "boolean" },
        plain: { type: "boolean" },
        "no-color": { type: "boolean" },
      },
    });
  } catch {
    throw new UsageError("Invalid arguments. Run tsls --help");
  }
  const values = parsed.values;
  const configPath =
    typeof values.config === "string"
      ? values.config
      : process.env.TSLS_CONFIG || defaultPath();
  if (values.json && values.plain)
    throw new UsageError("Choose either --json or --plain");
  if (parsed.positionals[0] === "init") {
    if (
      parsed.positionals.length !== 1 ||
      values.json ||
      values.plain ||
      values.timeout ||
      values.concurrency
    )
      throw new UsageError("Usage: tsls init [--config /absolute/path.json]");
    if (!configPath.startsWith("/"))
      throw new UsageError("Config path must be absolute");
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    try {
      await writeFile(configPath, `${JSON.stringify(SAMPLE, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new UsageError(
          "Cannot create config; an existing file is never overwritten",
        );
      }
      throw error;
    }
    process.stderr.write(
      `Created ${configPath}. Run tsls or add SSH hosts using the README example.\n`,
    );
    return 0;
  }
  const config = await loadConfig(configPath);
  const timeout = integer(
    typeof values.timeout === "string"
      ? values.timeout
      : process.env.TSLS_TIMEOUT,
    config.timeout,
    "timeout",
    120,
  );
  const concurrency = integer(
    typeof values.concurrency === "string"
      ? values.concurrency
      : process.env.TSLS_CONCURRENCY,
    config.concurrency,
    "concurrency",
    32,
  );
  const labels = new Set(parsed.positionals);
  for (const label of labels)
    if (!config.hosts.some((host) => host.label === label))
      throw new UsageError(`Unknown host label: ${label}`);
  const hosts = labels.size
    ? config.hosts.filter((host) => labels.has(host.label))
    : config.hosts;
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const startedAt = new Date().toISOString();
  try {
    const readings = await collectHosts(hosts, {
      timeout,
      concurrency,
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      process.stderr.write("tsls: cancelled\n");
      return 130;
    }
    const snapshot = {
      schemaVersion: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      hosts: readings,
    };
    process.stdout.write(
      values.json
        ? `${JSON.stringify(snapshot, null, 2)}\n`
        : values.plain
          ? renderPlain(readings)
          : renderHuman(readings),
    );
    for (const host of readings)
      if (host.error)
        process.stderr.write(`tsls: ${host.label}: ${host.error.message}\n`);
    return readings.every((host) => host.status === "ok") ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  else process.exit(1);
});
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `tsls: ${error instanceof UsageError ? error.message : "Cannot complete snapshot; check system access and configuration"}\n`,
    );
    process.exitCode = error instanceof UsageError ? 2 : 1;
  },
);
