#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { collectHosts, skipped } from "./collect.js";
import { bounded, defaultPath, loadConfig } from "./config.js";
import {
  type Discovery,
  discover,
  type Item,
  MAX_PROBES,
  SNAPSHOT_MS,
} from "./discovery.js";
import { type Reading, UsageError } from "./model.js";
import { renderHuman, renderPlain } from "./output.js";

export const VERSION = "0.2.0";
const HELP = `tsls ${VERSION} — free RAM and available disk across your machines

Usage: tsls [host-label...] [options]
       tsls init [--config /absolute/path.json]

Examples:
  tsls                       Local + Tailscale, or explicit user config
  tsls laptop buildbox       Select configured labels
  tsls --discover            Bypass tsls config; local + Tailscale discovery
  tsls --strict              Fail when coverage is incomplete
  tsls --json                Versioned JSON snapshot, byte units
  tsls --plain               Stable TSV, empty means unknown
  tsls --timeout 3 --concurrency 4
  tsls init                  Create a local-only config without overwriting

Options:
  --config PATH              Explicit host set, absolute path (or TSLS_CONFIG)
  --discover                 Ignore tsls config; use Tailscale discovery
  --strict                   Require complete coverage
  --timeout SECONDS          Per-host budget, integer 1–120 (default 5)
  --concurrency COUNT        Parallel probes, integer 1–32 (default 8)
  --json                     Machine-readable schemaVersion: 2
  --plain                    Stable TSV with a header
  --no-color                 Disable color (output currently uses no ANSI)
  -h, --help                 Show help, ignoring other arguments
  --version                  Print version

Config: $XDG_CONFIG_HOME/tsls/config.json or ~/.config/tsls/config.json
Precedence: flags > TSLS_TIMEOUT/TSLS_CONCURRENCY > config > defaults.
Config is optional. Without it: local + Tailscale discovery. No project config.
--discover ignores TSLS_CONFIG/default config; incompatible with --config.
Limits: 32 probes, 30s snapshot; Tailscale 3s/4MiB, SSH mapping 5s/100 aliases.
Offline/unsupported peers are skipped; SSH access is separate from visibility.
No password prompts. SSH uses your existing aliases, keys and known_hosts.
Exit: 0 useful discovery/all explicit hosts ok; 1 required coverage failure;
      2 usage/config error; 130 Ctrl-C. --strict requires complete discovery.
Docs: https://github.com/adinvadim-dev/tsls#readme
`;
const SAMPLE = {
  version: 1,
  timeout: 5,
  concurrency: 8,
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
        discover: { type: "boolean" },
        strict: { type: "boolean" },
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
  if (values.discover && values.config)
    throw new UsageError("Choose --discover or --config");
  if (values.json && values.plain)
    throw new UsageError("Choose either --json or --plain");
  if (parsed.positionals[0] === "init") {
    if (
      parsed.positionals.length !== 1 ||
      values.json ||
      values.plain ||
      values.timeout ||
      values.concurrency ||
      values.discover ||
      values.strict
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
  const config = values.discover
    ? null
    : await loadConfig(configPath, !values.config && !process.env.TSLS_CONFIG);
  const timeout = integer(
    typeof values.timeout === "string"
      ? values.timeout
      : process.env.TSLS_TIMEOUT,
    config?.timeout ?? 5,
    "timeout",
    120,
  );
  const concurrency = integer(
    typeof values.concurrency === "string"
      ? values.concurrency
      : process.env.TSLS_CONCURRENCY,
    config?.concurrency ?? 8,
    "concurrency",
    32,
  );
  const controller = new AbortController();
  const deadline = AbortSignal.timeout(SNAPSHOT_MS);
  const signal = AbortSignal.any([controller.signal, deadline]);
  const cancel = (): void => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const startedAt = new Date().toISOString();
  try {
    const plan: { items: Item[]; discovery: Discovery } = config
      ? {
          items: config.hosts.map((host) => ({ host, peer: null, skip: null })),
          discovery: {
            source: "config",
            status: "ok",
            message: null,
            aliasesLimited: false,
            duplicatesIgnored: 0,
          },
        }
      : await discover(signal);
    if (controller.signal.aborted) {
      process.stderr.write("tsls: cancelled\n");
      return 130;
    }
    const labels = new Set(parsed.positionals);
    for (const label of labels)
      if (!plan.items.some((item) => item.host.label === label))
        throw new UsageError(`Unknown host label: ${label}`);
    const items = labels.size
      ? plan.items.filter((item) => labels.has(item.host.label))
      : plan.items;
    // Apply the cap after explicit selection, so a chosen peer is never silently omitted.
    let allowed = 0;
    for (const item of items) {
      if (item.skip?.code === "probe_limit") item.skip = null;
      if (!item.skip && ++allowed > MAX_PROBES)
        item.skip = {
          code: "probe_limit",
          message: "Snapshot probe limit reached",
        };
    }
    const results = await collectHosts(
      items.filter((item) => !item.skip).map((item) => item.host),
      { timeout, concurrency, signal },
    );
    if (controller.signal.aborted) {
      process.stderr.write("tsls: cancelled\n");
      return 130;
    }
    const byLabel = new Map(results.map((result) => [result.label, result]));
    const readings = items.map((item) => {
      let result: Reading;
      if (item.skip)
        result = skipped(item.host.label, item.skip.code, item.skip.message);
      else {
        const found = byLabel.get(item.host.label);
        if (!found) throw new Error("Missing probe result");
        result = found;
        if (result.error?.code === "cancelled" && deadline.aborted)
          result = {
            ...result,
            status: "error",
            metrics: null,
            error: {
              code: "snapshot_timeout",
              message: "Snapshot deadline interrupted the probe",
            },
          };
      }
      return {
        ...result,
        peerId: item.peer?.id ?? null,
        tailscaleOs: item.peer?.os ?? null,
        transport: item.host.transport,
        online: item.peer?.online ?? null,
        lastSeen: item.peer?.lastSeen ?? null,
      };
    });
    const succeeded = readings.filter((host) => host.status === "ok").length;
    const skippedCount = readings.filter(
      (host) => host.status === "skipped",
    ).length;
    const coverage = {
      seen: plan.items.length,
      remoteCount:
        plan.discovery.source === "tailscale" ? plan.items.length - 1 : null,
      selected: items.length,
      attempted: readings.length - skippedCount,
      succeeded,
      failed: readings.length - skippedCount - succeeded,
      skipped: skippedCount,
      complete:
        succeeded === readings.length &&
        plan.discovery.status === "ok" &&
        !plan.discovery.aliasesLimited,
      limits: {
        maxProbes: MAX_PROBES,
        snapshotMs: SNAPSHOT_MS,
        perHostMs: timeout * 1000,
        concurrency,
      },
    };
    const snapshot = {
      schemaVersion: 2,
      startedAt,
      finishedAt: new Date().toISOString(),
      discovery: plan.discovery,
      coverage,
      hosts: readings,
    };
    const reasons = new Map<string, number>();
    for (const host of readings)
      if (host.error)
        reasons.set(host.error.code, (reasons.get(host.error.code) ?? 0) + 1);
    const summary = `${succeeded}/${readings.length} readings; ${[...reasons].map(([reason, count]) => `${reason}: ${count}`).join(", ") || "no skipped/failed hosts"}`;
    process.stdout.write(
      values.json
        ? `${JSON.stringify(snapshot, null, 2)}\n`
        : values.plain
          ? renderPlain(readings)
          : renderHuman(
              config || labels.size
                ? readings
                : readings.filter((host) => host.status === "ok"),
            ) + `${summary}\n`,
    );
    if (plan.discovery.message)
      process.stderr.write(`tsls: ${plan.discovery.message}\n`);
    if (reasons.size) process.stderr.write(`tsls: ${summary}\n`);
    const requireAll = Boolean(config || labels.size || values.strict);
    const localFailed = items.some(
      (item, i) =>
        item.host.transport === "local" && readings[i]?.status !== "ok",
    );
    return localFailed ||
      (requireAll &&
        (!readings.every((host) => host.status === "ok") ||
          (values.strict && !coverage.complete)))
      ? 1
      : 0;
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
