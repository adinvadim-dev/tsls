import { type Bytes, type Metrics, ProbeError } from "./model.js";

// Identical local/remote program. Configuration never enters the shell source.
export const PROBE = `set -eu
LC_ALL=C
export LC_ALL
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
printf '__TSLS_OS__\\n'
uname -s
printf '__TSLS_MEM__\\n'
case "$(uname -s)" in
  Linux) cat /proc/meminfo; mount=/ ;;
  Darwin) sysctl -n hw.memsize; vm_stat; mount=/System/Volumes/Data ;;
  *) printf 'Unsupported operating system\\n' >&2; exit 3 ;;
esac
printf '__TSLS_DISK__\\n'
df -Pk "$mount"
printf '__TSLS_END__\\n'
`;

function fail(): never {
  throw new ProbeError("probe", "Invalid or incomplete native metrics output");
}
function bytes(value: number | null, source: string): Bytes {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) fail();
  return {
    bytes: value,
    source,
    quality: value === null ? "unknown" : "reported",
  };
}
function counter(text: string, pattern: RegExp, scale = 1): number {
  const value = text.match(pattern)?.[1];
  if (value === undefined) fail();
  const number = Number(value) * scale;
  if (!Number.isSafeInteger(number) || number < 0) fail();
  return number;
}
export function parseProbe(output: string): Metrics {
  const match = output.match(
    /^__TSLS_OS__\n(Linux|Darwin)\n__TSLS_MEM__\n([\s\S]+?)\n__TSLS_DISK__\n([\s\S]+?)\n__TSLS_END__\n?$/,
  );
  if (!match) fail();
  const [, os, memoryText, diskText] = match;
  if (!memoryText || !diskText) fail();
  let memory: Metrics["memory"];
  if (os === "Linux") {
    const source = "/proc/meminfo";
    const available = memoryText.match(/^MemAvailable:\s+(\d+) kB$/m);
    memory = {
      total: bytes(
        counter(memoryText, /^MemTotal:\s+(\d+) kB$/m, 1024),
        `${source}:MemTotal`,
      ),
      free: bytes(
        counter(memoryText, /^MemFree:\s+(\d+) kB$/m, 1024),
        `${source}:MemFree`,
      ),
      available: bytes(
        available ? Number(available[1]) * 1024 : null,
        `${source}:MemAvailable`,
      ),
    };
  } else {
    const pageSize = counter(memoryText, /page size of (\d+) bytes/);
    if (pageSize === 0) fail();
    memory = {
      total: bytes(counter(memoryText, /^(\d+)\n/), "sysctl:hw.memsize"),
      free: bytes(
        counter(memoryText, /^Pages free:\s+(\d+)\.$/m, pageSize),
        "vm_stat:Pages free*pageSize",
      ),
      available: bytes(null, "macos:no-native-equivalent-to-MemAvailable"),
    };
  }
  const diskLine = diskText.split("\n").slice(1).join(" ");
  const diskMatch = diskLine.match(
    /^.+?\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/,
  );
  if (!diskMatch?.[1] || !diskMatch[3] || !diskMatch[4]) fail();
  const disk = {
    mount: diskMatch[4].trim(),
    total: bytes(Number(diskMatch[1]) * 1024, "df -Pk:1024-blocks"),
    free: bytes(null, "df -Pk:free-blocks-not-reported"),
    available: bytes(Number(diskMatch[3]) * 1024, "df -Pk:Available"),
  };
  const total = memory.total.bytes;
  if (
    total === null ||
    total === 0 ||
    (memory.free.bytes ?? 0) > total ||
    (memory.available.bytes ?? 0) > total
  )
    fail();
  if (
    disk.total.bytes === 0 ||
    (disk.available.bytes ?? 0) > (disk.total.bytes ?? 0)
  )
    fail();
  return { os: os === "Linux" ? "linux" : "macos", memory, disk };
}
