import type { Reading } from "./model.js";

export function humanBytes(value: number | null): string {
  if (value === null) return "-";
  return `${(value / 1_000_000_000).toFixed(1)} GB`;
}
export function renderHuman(hosts: Reading[]): string {
  const rows = [
    ["MACHINE", "RAM FREE / TOTAL", "DISK AVAIL / TOTAL", "STATUS"],
    ...hosts.map((host) => [
      host.label,
      host.metrics
        ? `${humanBytes(host.metrics.memory.free.bytes)} / ${humanBytes(host.metrics.memory.total.bytes)}`
        : "-",
      host.metrics
        ? `${humanBytes(host.metrics.disk.available.bytes)} / ${humanBytes(host.metrics.disk.total.bytes)}`
        : "-",
      host.status,
    ]),
  ];
  const widths = [0, 1, 2].map((column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  return `${rows
    .map((row) =>
      row
        .map((cell, i) => cell.padEnd(widths[i] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n")}\n`;
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
