export type Bytes = {
  bytes: number | null;
  source: string;
  quality: "reported" | "unknown";
};
export type Metrics = {
  os: "linux" | "macos";
  memory: { total: Bytes; free: Bytes; available: Bytes };
  disk: { mount: string; total: Bytes; free: Bytes; available: Bytes };
};
export type Host =
  | { label: string; transport: "local" }
  | { label: string; transport: "ssh"; target: string };
export type Config = {
  hosts: Host[];
  timeout: number;
  concurrency: number;
};
export type FailureCode =
  | "timeout"
  | "unreachable"
  | "host_key"
  | "authentication"
  | "transport"
  | "probe"
  | "cancelled";
export type Reading = {
  label: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
} & (
  | { status: "ok"; metrics: Metrics; error: null }
  | {
      status: "offline" | "error";
      metrics: null;
      error: { code: FailureCode; message: string };
    }
);
export class UsageError extends Error {}
export class ProbeError extends Error {
  constructor(
    public readonly code: FailureCode,
    message: string,
  ) {
    super(message);
  }
}
