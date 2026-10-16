import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { type Host, ProbeError, type Reading } from "./model.js";
import { PROBE, parseProbe } from "./probe.js";

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
export function runProbe(
  host: Host,
  timeout: number,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ProbeError("cancelled", "Cancelled"));
    const remote = host.transport === "ssh";
    const child = spawn(
      remote ? "ssh" : "/bin/sh",
      remote ? sshArgs(host.target, timeout) : ["-s"],
      { stdio: ["pipe", "pipe", "pipe"], detached: true },
    );
    let output = "";
    let errors = "";
    let size = 0;
    let failure: ProbeError | null = null;
    const stop = (error: ProbeError): void => {
      failure ??= error;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const cancel = (): void => stop(new ProbeError("cancelled", "Cancelled"));
    const timer = setTimeout(
      () => stop(new ProbeError("timeout", "Probe exceeded the host timeout")),
      timeout * 1000,
    );
    signal.addEventListener("abort", cancel, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const collect = (data: string, stderr: boolean): void => {
      size += Buffer.byteLength(data);
      if (size > 262144) {
        stop(new ProbeError("probe", "Probe output exceeded 256 KiB"));
        return;
      }
      if (stderr) errors += data;
      else output += data;
    };
    child.stdout.on("data", (data: string) => collect(data, false));
    child.stderr.on("data", (data: string) => collect(data, true));
    child.stdin.on("error", () => {});
    child.on("error", () => {
      failure = new ProbeError(
        "transport",
        remote
          ? "Cannot start system ssh; install OpenSSH"
          : "Cannot start /bin/sh",
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          remote && code === 255
            ? transportError(errors)
            : new ProbeError(
                "probe",
                "Native probe failed; supported hosts are macOS and Linux",
              ),
        );
      else resolve(output);
    });
    child.stdin.end(PROBE);
  });
}
export async function collectHosts(
  hosts: Host[],
  options: { timeout: number; concurrency: number; signal: AbortSignal },
): Promise<Reading[]> {
  const results: Reading[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < hosts.length && !options.signal.aborted) {
      const index = next++;
      const host = hosts[index];
      if (!host) break;
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
