import { spawn } from "node:child_process";
import { ProbeError } from "./model.js";

export function execute(options: {
  command: string;
  args: string[];
  signal: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
  input?: string;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted)
      return reject(new ProbeError("cancelled", "Cancelled"));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SSH_ASKPASS_REQUIRE: "never",
    };
    delete env.SSH_ASKPASS;
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    const child = spawn(options.command, options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env,
    });
    let stdout = "";
    let stderr = "";
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
      () => stop(new ProbeError("timeout", "Command exceeded its timeout")),
      options.timeoutMs,
    );
    options.signal.addEventListener("abort", cancel, { once: true });
    const collect = (data: string, errors: boolean): void => {
      size += Buffer.byteLength(data);
      if (size > options.maxBytes) {
        stop(new ProbeError("probe", "Command output exceeded its limit"));
        return;
      }
      if (errors) stderr += data;
      else stdout += data;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => collect(data, false));
    child.stderr.on("data", (data: string) => collect(data, true));
    child.stdin.on("error", () => {});
    child.on("error", () => {
      failure = new ProbeError(
        "transport",
        "Cannot start required system command",
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", cancel);
      if (failure) reject(failure);
      else resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input ?? "");
  });
}
