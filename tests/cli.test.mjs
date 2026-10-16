import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const dir = mkdtempSync(join(tmpdir(), "tsls-tests-"));
const bin = resolve("dist/cli.js");
const linux = readFileSync("tests/fixtures/linux.txt", "utf8");
const trace = join(dir, "trace");
const fake = join(dir, "ssh");
writeFileSync(
  fake,
  `#!/usr/bin/env node
const fs=require('fs');
const args=process.argv.slice(2); const target=args.at(-3);
fs.appendFileSync(process.env.TSLS_TEST_TRACE,JSON.stringify({event:'start',target,time:Date.now(),args})+'\\n');
process.stdin.resume();
if(target==='slow') { const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(process.env.TSLS_TEST_CHILD,String(c.pid)); setInterval(()=>{},1000); }
else if(target==='huge') { process.stdout.write('x'.repeat(300000)); }
else if(target==='key') { process.stderr.write('REMOTE HOST IDENTIFICATION HAS CHANGED SECRET_SENTINEL');process.exitCode=255; }
else if(target==='auth') {process.stderr.write('Permission denied SECRET_SENTINEL');process.exitCode=255;}
else if(target==='offline') {process.stderr.write('Connection refused SECRET_SENTINEL');process.exitCode=255;}
else {setTimeout(()=>{process.stdout.write(${JSON.stringify(linux)}); fs.appendFileSync(process.env.TSLS_TEST_TRACE,JSON.stringify({event:'end',target,time:Date.now()})+'\\n');},100);}
`,
);
chmodSync(fake, 0o755);
const env = {
  ...process.env,
  PATH: `${dir}:${process.env.PATH}`,
  TSLS_TEST_TRACE: trace,
  TSLS_TEST_CHILD: join(dir, "child"),
  TSLS_TIMEOUT: "",
  TSLS_CONCURRENCY: "",
};
delete env.TSLS_TIMEOUT;
delete env.TSLS_CONCURRENCY;
delete env.TSLS_CONFIG;
function config(targets, name = "config") {
  const path = join(dir, `${name}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      timeout: 1,
      concurrency: 4,
      hosts: targets.map((target) => ({
        label: target,
        transport: "ssh",
        target,
      })),
    }),
  );
  return path;
}
function run(args, extra = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    env: { ...env, ...extra },
    encoding: "utf8",
    timeout: 10000,
  });
}
test("help overrides unknown arguments and broken config", () => {
  const r = run(["--bad", "--help", "--config", "/missing"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: tsls/);
  assert.equal(r.stderr, "");
});
test("version matches package", () =>
  assert.equal(
    run(["--version"]).stdout.trim(),
    JSON.parse(readFileSync("package.json", "utf8")).version,
  ));
for (const args of [
  ["--bad"],
  ["--timeout", "NaN"],
  ["--concurrency", "33"],
  ["--timeout", "0"],
  ["--json", "--plain"],
  ["unknown"],
])
  test(`usage errors ${args.join(" ")}`, () => {
    const r = run(["--config", config(["ok"]), ...args]);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.doesNotMatch(r.stderr, /SECRET_SENTINEL/);
  });
test("JSON partial success, offline=null and stderr privacy", () => {
  const r = run([
    "--config",
    config(["ok", "offline", "key", "auth"]),
    "--json",
  ]);
  assert.equal(r.status, 1);
  const s = JSON.parse(r.stdout);
  assert.equal(s.schemaVersion, 1);
  assert.equal(s.hosts.length, 4);
  assert.equal(s.hosts[0].status, "ok");
  assert.equal(s.hosts[1].status, "offline");
  assert.equal(s.hosts[1].metrics, null);
  assert.equal(s.hosts[2].error.code, "host_key");
  assert.equal(s.hosts[3].error.code, "authentication");
  for (const h of s.hosts) {
    assert.ok(Date.parse(h.startedAt));
    assert.ok(Date.parse(h.finishedAt));
    assert.ok(h.durationMs >= 0);
  }
  assert.doesNotMatch(r.stdout + r.stderr, /SECRET_SENTINEL/);
});
test("plain is stable TSV and NO_COLOR is respected", () => {
  const r = run(["--config", config(["ok"]), "--plain", "--no-color"], {
    NO_COLOR: "1",
    TERM: "dumb",
  });
  assert.equal(r.status, 0);
  assert.equal(
    r.stdout.split("\n")[0],
    "label\tstatus\tram_free_bytes\tram_available_bytes\tram_total_bytes\tdisk_available_bytes\tdisk_total_bytes\terror_code",
  );
  assert.ok(!r.stdout.includes(String.fromCharCode(27)));
});
test("human output states RAM free and disk available", () => {
  const r = run(["--config", config(["ok"])]);
  assert.match(r.stdout, /RAM FREE \/ TOTAL/);
  assert.match(r.stdout, /DISK AVAIL \/ TOTAL/);
});
test("timeout bounds offline host and reaps process group", () => {
  const start = Date.now();
  const r = run(["--config", config(["slow", "ok"]), "--json"]);
  assert.ok(Date.now() - start < 2500);
  assert.equal(r.status, 1);
  const s = JSON.parse(r.stdout);
  assert.equal(s.hosts[0].error.code, "timeout");
  assert.equal(s.hosts[1].status, "ok");
  const pid = Number(readFileSync(env.TSLS_TEST_CHILD, "utf8"));
  assert.throws(() => process.kill(pid, 0));
});
test("bounded output", () => {
  const r = run(["--config", config(["huge"]), "--json"]);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).hosts[0].error.code, "probe");
  assert.ok(r.stdout.length < 5000);
});
test("concurrency cap is enforced", () => {
  writeFileSync(trace, "");
  const r = run([
    "--config",
    config(["a", "b", "c", "d"]),
    "--concurrency",
    "2",
    "--json",
  ]);
  assert.equal(r.status, 0);
  let running = 0,
    max = 0;
  for (const entry of readFileSync(trace, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse)) {
    running += entry.event === "start" ? 1 : -1;
    max = Math.max(max, running);
  }
  assert.equal(max, 2);
  assert.equal(running, 0);
});
test("flags override env and config", () =>
  assert.equal(
    run(["--config", config(["ok"]), "--timeout", "1"], { TSLS_TIMEOUT: "bad" })
      .status,
    0,
  ));
test("init creates private local-only config; repeat never overwrites", () => {
  const path = join(dir, "init", "config.json");
  const first = run(["init", "--config", path]);
  assert.equal(first.status, 0);
  assert.equal(first.stdout, "");
  const before = readFileSync(path, "utf8");
  assert.equal(JSON.parse(before).hosts[0].transport, "local");
  assert.equal(run(["init", "--config", path]).status, 2);
  assert.equal(readFileSync(path, "utf8"), before);
});
test("config is read-only unless init", () => {
  const path = join(dir, "absent.json");
  assert.equal(run(["--config", path]).status, 2);
  assert.equal(existsSync(path), false);
});
test("Ctrl-C stops promptly and kills descendant", async () => {
  const child = spawn(
    process.execPath,
    [bin, "--config", config(["slow"], "cancel"), "--timeout", "10"],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  await delay(350);
  const start = Date.now();
  child.kill("SIGINT");
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 130);
  assert.ok(Date.now() - start < 1500);
  const pid = Number(readFileSync(env.TSLS_TEST_CHILD, "utf8"));
  assert.throws(() => process.kill(pid, 0));
});
