import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type Config, type Host, UsageError } from "./model.js";

export const defaultPath = (): string =>
  join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "tsls",
    "config.json",
  );
export function bounded(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new UsageError(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseConfig(input: unknown): Config {
  if (
    !record(input) ||
    input.version !== 1 ||
    !Array.isArray(input.hosts) ||
    input.hosts.length === 0 ||
    input.hosts.length > 100
  )
    throw new UsageError("Config requires version: 1 and 1–100 hosts");
  const labels = new Set<string>();
  const hosts: Host[] = input.hosts.map((host: unknown) => {
    if (
      !record(host) ||
      typeof host.label !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(host.label) ||
      host.label === "init"
    )
      throw new UsageError(
        "Invalid host label; use 1–64 letters, digits, dot, underscore or hyphen, excluding init",
      );
    if (labels.has(host.label))
      throw new UsageError(`Duplicate host label: ${host.label}`);
    labels.add(host.label);
    if (host.transport === "local") {
      if (host.target !== undefined)
        throw new UsageError("Local hosts cannot have an SSH target");
      return { label: host.label, transport: "local" };
    }
    if (
      host.transport !== "ssh" ||
      typeof host.target !== "string" ||
      !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(
        host.target,
      ) ||
      host.target.length > 253
    )
      throw new UsageError(
        "SSH target must be a hostname or SSH alias, optionally user@host",
      );
    return { label: host.label, transport: "ssh", target: host.target };
  });
  return {
    hosts,
    timeout: bounded(input.timeout ?? 5, "timeout", 1, 120),
    concurrency: bounded(input.concurrency ?? 4, "concurrency", 1, 32),
  };
}
export async function loadConfig(path: string): Promise<Config> {
  if (!isAbsolute(path)) throw new UsageError("Config path must be absolute");
  try {
    const contents = await readFile(path, "utf8");
    if (Buffer.byteLength(contents) > 65536)
      throw new UsageError("Config exceeds 64 KiB");
    const input: unknown = JSON.parse(contents);
    return parseConfig(input);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    if (error instanceof SyntaxError)
      throw new UsageError("Config is not valid JSON");
    throw new UsageError(
      "Cannot read config. Run tsls init, or pass --config /absolute/path.json",
    );
  }
}
