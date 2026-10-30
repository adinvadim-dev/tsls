import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sshArgs } from "../dist/collect.js";
import { parseConfig } from "../dist/config.js";
import { humanBytes, renderHuman, renderPlain } from "../dist/output.js";
import { parseProbe } from "../dist/probe.js";

const linux = readFileSync(
  new URL("./fixtures/linux.txt", import.meta.url),
  "utf8",
);
const macos = readFileSync(
  new URL("./fixtures/macos.txt", import.meta.url),
  "utf8",
);
test("Linux kB are KiB; available is distinct from free", () => {
  const metrics = parseProbe(linux);
  assert.equal(metrics.memory.total.bytes, 8 * 1024 ** 3);
  assert.equal(metrics.memory.free.bytes, 1024 ** 3);
  assert.equal(metrics.memory.available.bytes, 4 * 1024 ** 3);
  assert.equal(metrics.disk.mount, "/");
  assert.equal(metrics.disk.available.bytes, 67772160 * 1024);
  assert.equal(metrics.disk.free.bytes, null);
});
test("Apple 16 KiB pages; inactive/compressor are not available", () => {
  const m = parseProbe(macos);
  assert.equal(m.memory.free.bytes, 100000 * 16384);
  assert.equal(m.memory.available.bytes, null);
  assert.equal(m.memory.available.quality, "unknown");
  assert.equal(m.disk.mount, "/System/Volumes/Data");
});
test("Intel page size is read too", () =>
  assert.equal(
    parseProbe(macos.replace("16384 bytes", "4096 bytes")).memory.free.bytes,
    409600000,
  ));
test("human readings distinguish free RAM from available RAM and explain units", () => {
  const output = renderHuman([
    { label: "linux", status: "ok", metrics: parseProbe(linux) },
    { label: "mac", status: "ok", metrics: parseProbe(macos) },
    { label: "failed", status: "error", metrics: null },
  ]);
  const [header, linuxRow, macRow, failedRow] = output.split("\n");
  assert.match(header, /RAM AVAIL/);
  assert.match(linuxRow, /1\.0 GiB \/ 8\.0 GiB\s+4\.0 GiB/);
  assert.match(macRow, /1\.5 GiB \/ 36\.0 GiB\s+-\s+409\.6 GB/);
  assert.match(failedRow, /^failed\s+-\s+-\s+-\s+error$/);
  assert.match(output, /RAM: GiB = 1,073,741,824 bytes/);
  assert.match(output, /Disk: GB = 1,000,000,000 bytes/);
  assert.match(output, /macOS.*RAM FREE.*reclaimable/);
});
test("Linux-only human output omits macOS-specific explanation", () => {
  const output = renderHuman([
    { label: "linux", status: "ok", metrics: parseProbe(linux) },
  ]);
  assert.doesNotMatch(output, /macOS/);
});
test("missing Linux MemAvailable is unknown", () =>
  assert.equal(
    parseProbe(linux.replace(/^MemAvailable:.*\n/m, "")).memory.available.bytes,
    null,
  ));
test("df handles spaces in filesystem and mount", () => {
  const m = parseProbe(
    linux
      .replace("/dev/demo", "demo filesystem")
      .replace("60% /", "60% /demo mount"),
  );
  assert.equal(m.disk.mount, "/demo mount");
});
for (const [name, raw] of Object.entries({
  missing: macos.replace(/^Pages free:.*\n/m, ""),
  unsupported: linux.replace("Linux", "FreeBSD"),
  localized: linux.replace("67772160", "67,772,160"),
  negative: linux.replace("1048576 kB", "-1 kB"),
  zeroPages: macos.replace("16384 bytes", "0 bytes"),
  truncated: linux.replace("__TSLS_END__", ""),
  missingTotal: linux.replace(/^MemTotal:.*\n/m, ""),
  oversized: linux.replace("8388608 kB", "9999999999999999999999 kB"),
  invalidFree: linux.replace("1048576 kB", "999999999 kB"),
})) {
  test(`rejects malformed native output: ${name}`, () =>
    assert.throws(() => parseProbe(raw)));
}
const valid = {
  version: 1,
  hosts: [
    { label: "laptop", transport: "local" },
    { label: "builder", transport: "ssh", target: "dev@builder" },
  ],
};
test("config defaults and safe SSH aliases", () =>
  assert.deepEqual(parseConfig(valid), {
    hosts: valid.hosts,
    timeout: 5,
    concurrency: 4,
  }));
for (const target of [
  "-oProxyCommand=bad",
  "host;touch /tmp/bad",
  "$(id)",
  "a b",
  "a\nb",
  "a`id`",
  "user@-host",
  "a/b",
  "a:22",
])
  test(`rejects unsafe SSH target ${JSON.stringify(target)}`, () =>
    assert.throws(() =>
      parseConfig({
        version: 1,
        hosts: [{ label: "safe", transport: "ssh", target }],
      }),
    ));
for (const input of [
  null,
  {},
  { ...valid, version: 2 },
  { ...valid, hosts: [] },
  { ...valid, hosts: [valid.hosts[0], valid.hosts[0]] },
  { ...valid, timeout: 0 },
  { ...valid, concurrency: 33 },
  { ...valid, hosts: [{ label: "bad\nlabel", transport: "local" }] },
  { ...valid, hosts: [{ label: "local", transport: "local", target: "oops" }] },
])
  test("invalid config is rejected", () =>
    assert.throws(() => parseConfig(input)));
test("SSH cannot prompt or learn keys; system alias is unchanged", () => {
  const args = sshArgs("builder", 3);
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.ok(args.includes("BatchMode=yes"));
  assert.ok(args.includes("ConnectTimeout=3"));
  assert.deepEqual(args.slice(-4), ["--", "builder", "sh", "-s"].slice(-4));
});
test("decimal GB, unknown remains unknown", () => {
  assert.equal(humanBytes(1_000_000_000), "1.0 GB");
  assert.equal(humanBytes(null), "-");
  assert.ok(
    !renderPlain([
      {
        label: "demo",
        status: "offline",
        metrics: null,
        error: { code: "timeout" },
      },
    ]).includes("\x1b"),
  );
});
