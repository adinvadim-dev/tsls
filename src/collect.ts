import { performance } from "node:perf_hooks";
import { type Host, ProbeError, type Reading } from "./model.js";
import { PROBE, parseProbe } from "./probe.js";
import { execute } from "./process.js";

export function sshArgs(target: string, timeout: number): string[] {
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectionAttempts=1",
    "-o",
    `ConnectTimeout=${Math.ceil(timeout)}`,
    "-o",
    "ServerAliveInterval=1",
    "-o",
    "ServerAliveCountMax=1",
    "--",
    target,
    "sh",
    "-s",
  ];
}
function transportError(stderr: string): ProbeError {
  if (/Timeout, server .* not responding\./i.test(stderr))
    return new ProbeError("timeout", "SSH server stopped responding");
  if (
    /host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(
      stderr,
    )
  )
    return new ProbeError(
      "host_key",
      "SSH host key is missing or changed; verify it using your SSH workflow",
    );
  if (/permission denied|authentication failed/i.test(stderr))
    return new ProbeError(
      "authentication",
      "SSH authentication failed; check your existing SSH identity",
    );
  if (
    /timed out|refused|no route|could not resolve|network is unreachable|connection closed/i.test(
      stderr,
    )
  )
    return new ProbeError("unreachable", "Host is unreachable over SSH");
  return new ProbeError(
    "transport",
    "SSH failed; check the configured alias with your SSH client",
  );
}
export async function runProbe(
  host: Host,
  timeout: number,
  signal: AbortSignal,
): Promise<string> {
  const remote = host.transport === "ssh";
  const result = await execute({
    command: remote ? "ssh" : "/bin/sh",
    args: remote ? sshArgs(host.target, timeout) : ["-s"],
    input: PROBE,
    signal,
    timeoutMs: timeout * 1000,
    maxBytes: 262144,
  });
  if (result.code !== 0)
    throw remote && result.code === 255
      ? transportError(result.stderr)
      : new ProbeError(
          "probe",
          "Native probe failed; supported hosts are macOS and Linux",
        );
  return result.stdout;
}
export function skipped(
  label: string,
  code: import("./model.js").FailureCode,
  message: string,
): Reading {
  const at = new Date().toISOString();
  return {
    label,
    startedAt: at,
    finishedAt: at,
    durationMs: 0,
    status: "skipped",
    metrics: null,
    error: { code, message },
  };
}
export async function collectHosts(
  hosts: Host[],
  options: { timeout: number; concurrency: number; signal: AbortSignal },
): Promise<Reading[]> {
  const results: Reading[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < hosts.length) {
      const index = next++;
      const host = hosts[index];
      if (!host) break;
      if (options.signal.aborted) {
        results[index] = skipped(
          host.label,
          "snapshot_timeout",
          "Snapshot deadline reached before this probe",
        );
        continue;
      }
      const startedAt = new Date().toISOString();
      const start = performance.now();
      try {
        const metrics = parseProbe(
          await runProbe(host, options.timeout, options.signal),
        );
        results[index] = {
          label: host.label,
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Math.round(performance.now() - start),
          status: "ok",
          metrics,
          error: null,
        };
      } catch (error) {
        const failure =
          error instanceof ProbeError
            ? error
            : new ProbeError("probe", "Cannot collect native metrics");
        results[index] = {
          label: host.label,
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Math.round(performance.now() - start),
          status:
            failure.code === "timeout" || failure.code === "unreachable"
              ? "offline"
              : "error",
          metrics: null,
          error: { code: failure.code, message: failure.message },
        };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, hosts.length) }, worker),
  );
  return results;
}
