import type { Reading } from "./model.js";

export function humanBytes(
  value: number | null,
  unit: "GB" | "GiB" = "GB",
): string {
  if (value === null) return "-";
  const divisor = unit === "GiB" ? 1_073_741_824 : 1_000_000_000;
  return `${(value / divisor).toFixed(1)} ${unit}`;
}
export function renderHuman(hosts: Reading[]): string {
  const rows = [
    [
      "MACHINE",
      "RAM FREE / TOTAL",
      "RAM AVAIL",
      "DISK AVAIL / TOTAL",
      "STATUS",
    ],
    ...hosts.map((host) => [
      host.label,
      host.metrics
        ? `${humanBytes(host.metrics.memory.free.bytes, "GiB")} / ${humanBytes(host.metrics.memory.total.bytes, "GiB")}`
        : "-",
      humanBytes(host.metrics?.memory.available.bytes ?? null, "GiB"),
      host.metrics
        ? `${humanBytes(host.metrics.disk.available.bytes)} / ${humanBytes(host.metrics.disk.total.bytes)}`
        : "-",
      host.status,
    ]),
  ];
  const widths = [0, 1, 2, 3].map((column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  const notes = [
    "RAM: GiB = 1,073,741,824 bytes. Disk: GB = 1,000,000,000 bytes. - = unknown.",
  ];
  if (hosts.some((host) => host.metrics?.os === "macos"))
    notes.push(
      "macOS: RAM FREE excludes reclaimable memory; RAM AVAIL is unknown (no native MemAvailable counter).",
    );
  return `${rows
    .map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n")}\n${notes.join("\n")}\n`;
}
export function renderPlain(hosts: Reading[]): string {
  const rows = [
    [
      "label",
      "status",
      "ram_free_bytes",
      "ram_available_bytes",
      "ram_total_bytes",
      "disk_available_bytes",
      "disk_total_bytes",
      "error_code",
    ],
    ...hosts.map((host) => [
      host.label,
      host.status,
      host.metrics?.memory.free.bytes,
      host.metrics?.memory.available.bytes,
      host.metrics?.memory.total.bytes,
      host.metrics?.disk.available.bytes,
      host.metrics?.disk.total.bytes,
      host.error?.code,
    ]),
  ];
  return `${rows.map((row) => row.map((value) => value ?? "").join("\t")).join("\n")}\n`;
}
