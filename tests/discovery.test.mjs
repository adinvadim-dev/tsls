import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { collectHosts } from "../dist/collect.js";
import { labelName, parseStatus } from "../dist/discovery.js";

const bin = resolve("dist/cli.js");
const linux = readFileSync("tests/fixtures/linux.txt", "utf8");
const node = (id, name, os = "linux", online = true) => ({
  ID: id,
  HostName: name,
  DNSName: `${name}.example`,
  OS: os,
  Online: online,
  LastSeen: null,
  TailscaleIPs: [],
});
const self = node("self", "workstation", "macOS");
function status(peers = []) {
  return {
    BackendState: "Running",
    Self: self,
    Peer: Object.fromEntries(peers.map((p, i) => [i, p])),
  };
}
function fixture(input, mode = "ok") {
  const root = mkdtempSync(join(tmpdir(), "tsls-discovery-"));
  const home = join(root, "home");
  const fake = join(root, "bin");
  mkdirSync(home);
  mkdirSync(fake);
  mkdirSync(join(home, ".ssh"));
  const statusFile = join(root, "status.json");
  writeFileSync(
    statusFile,
    typeof input === "string" ? input : JSON.stringify(input),
  );
  const trace = join(root, "trace");
  writeFileSync(trace, "");
  const tailscale = join(fake, "tailscale");
  writeFileSync(
    tailscale,
    `#!${process.execPath}
if(process.env.DISCOVERY_MODE==='missing')process.exit(127);
if(process.env.DISCOVERY_MODE==='hang')setInterval(()=>{},1000);
else if(process.env.DISCOVERY_MODE==='huge')process.stdout.write('x'.repeat(5*1024*1024));
else process.stdout.write(require('fs').readFileSync(process.env.DISCOVERY_FIXTURE,'utf8'));
`,
  );
  chmodSync(tailscale, 0o755);
  const ssh = join(fake, "ssh");
  writeFileSync(
    ssh,
    `#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2),target=args.includes('-G')?args.at(-1):args.at(-3);
fs.appendFileSync(process.env.DISCOVERY_TRACE,JSON.stringify({args,target,time:Date.now(),event:'start',safe:process.env.SSH_ASKPASS_REQUIRE==='never'&&!process.env.DISPLAY&&!process.env.SSH_ASKPASS})+'\\n');
process.stdin.resume();
if(args.includes('-G')) { if(target==='jump-alias')process.stdout.write('hostname builder.example\\nuser operator\\n');else process.stdout.write('hostname '+target+'\\nuser default-login\\n'); }
else if(target==='denied.example'){process.stderr.write('Permission denied PRIVATE_ERROR');process.exitCode=255;}
else if(target==='slow.example')setInterval(()=>{},1000);
else setTimeout(()=>{process.stdout.write(${JSON.stringify(linux)});fs.appendFileSync(process.env.DISCOVERY_TRACE,JSON.stringify({event:'end',target,time:Date.now()})+'\\n');},70);
`,
  );
  chmodSync(ssh, 0o755);
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PATH: fake + ":" + process.env.PATH,
    DISCOVERY_FIXTURE: statusFile,
    DISCOVERY_MODE: mode,
    DISCOVERY_TRACE: trace,
    SSH_ASKPASS_REQUIRE: "force",
    SSH_ASKPASS: "/demo/askpass",
    DISPLAY: ":99",
  };
  const run = (args = [], overrides = {}) =>
    spawnSync(process.execPath, [bin, ...args], {
      env: { ...env, ...overrides },
      encoding: "utf8",
      timeout: 15000,
    });
  return { root, home, fake, env, trace, run };
}
function json(f, args = []) {
  const r = f.run(["--json", ...args]);
  assert.ok(r.status === 0 || r.status === 1, r.stderr);
  return { r, s: JSON.parse(r.stdout) };
}
function calls(f) {
  return readFileSync(f.trace, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
}
test("Self ID dedup; nullable peer map; terminal-safe labels", () => {
  const s = parseStatus(
    status([self, node("b", "same"), node("b", "duplicate")]),
  );
  assert.equal(s.peers.length, 1);
  assert.equal(s.duplicatesIgnored, 2);
  assert.equal(parseStatus({ ...status(), Peer: null }).peers.length, 0);
  assert.equal(labelName("\u001b[31mhello\nthere"), "31mhello-there");
});
for (const [title, input] of Object.entries({
  null: null,
  incomplete: { BackendState: "Running" },
  badId: { ...status(), Self: { ID: "-bad ID" } },
  badPeer: { ...status(), Peer: { bad: null } },
}))
  test(`malformed discovery is rejected: ${title}`, () =>
    assert.throws(() => parseStatus(input)));
test("no available Tailscale: useful local-only first run, no init or config writes", () => {
  const f = fixture(status(), "missing");
  const { r, s } = json(f);
  assert.equal(r.status, 0);
  assert.equal(s.hosts.length, 1);
  assert.equal(s.hosts[0].status, "ok");
  assert.equal(s.discovery.source, "local");
  assert.equal(s.coverage.complete, false);
  assert.equal(s.coverage.remoteCount, null);
  assert.match(r.stderr, /Tailscale/);
  assert.equal(existsSync(join(f.home, ".config")), false);
  assert.deepEqual(calls(f), []);
});
for (const [title, input] of Object.entries({
  invalid: "{",
  incomplete: { BackendState: "Running" },
  off: { BackendState: "Stopped", Self: self, Peer: null },
}))
  test(`${title} Tailscale status keeps local metrics`, () => {
    const f = fixture(input);
    const { r, s } = json(f);
    assert.equal(r.status, 0);
    assert.equal(s.hosts[0].status, "ok");
    assert.notEqual(s.discovery.status, "ok");
    assert.deepEqual(calls(f), []);
  });
test("bounded discovery output, and status timeout keep local useful", () => {
  for (const mode of ["huge", "hang"]) {
    const f = fixture(status(), mode);
    const start = Date.now();
    const { r, s } = json(f);
    assert.equal(r.status, 0);
    assert.ok(Date.now() - start < 5000);
    assert.equal(s.hosts[0].status, "ok");
    assert.notEqual(s.discovery.status, "ok");
  }
});
test("tailnet mixed OS/offline/unknown/null DNS; every peer retained, strict access and IDs", () => {
  const peers = [
    self,
    node("a", "builder", "macOS"),
    node("b", "phone", "iOS"),
    node("c", "offline", "linux", false),
    node("d", "mystery", null),
    {
      ...node("e", "ip-only"),
      DNSName: null,
      HostName: null,
      TailscaleIPs: ["192.0.2.10"],
    },
    node("f", "denied"),
  ];
  const f = fixture(status(peers));
  const { r, s } = json(f);
  assert.equal(r.status, 0);
  assert.equal(s.hosts.length, 7);
  assert.equal(s.discovery.duplicatesIgnored, 1);
  assert.equal(s.coverage.succeeded, 3);
  assert.equal(s.coverage.skipped, 3);
  assert.equal(s.coverage.failed, 1);
  assert.equal(s.coverage.complete, false);
  assert.equal(
    s.hosts.find((h) => h.peerId === "b").error.code,
    "unsupported_os",
  );
  assert.equal(
    s.hosts.find((h) => h.peerId === "c").error.code,
    "offline_peer",
  );
  assert.equal(
    s.hosts.find((h) => h.peerId === "f").error.code,
    "authentication",
  );
  assert.equal(s.hosts.find((h) => h.peerId === "e").status, "ok");
  assert.ok(
    calls(f)
      .filter((c) => c.event === "start")
      .every((c) => c.safe),
  );
  assert.ok(
    calls(f)
      .filter((c) => c.event === "start" && !c.args.includes("-G"))
      .every(
        (c) =>
          c.args.includes("BatchMode=yes") &&
          c.args.includes("StrictHostKeyChecking=yes") &&
          c.args.includes("UpdateHostKeys=no"),
      ),
  );
  assert.doesNotMatch(r.stdout + r.stderr, /PRIVATE_ERROR/);
  assert.equal(json(f, ["--strict"]).r.status, 1);
  assert.equal(json(f, ["denied"]).r.status, 1);
});
test("unsafe targets cannot become SSH options or commands", () => {
  const f = fixture(
    status([
      {
        ...node("a", "bad"),
        DNSName: "-oProxyCommand=bad",
        HostName: "$(whoami)",
      },
      {
        ...node("b", "missing"),
        DNSName: null,
        HostName: null,
        TailscaleIPs: null,
      },
    ]),
  );
  const { s } = json(f);
  assert.equal(s.hosts[1].error.code, "invalid_target");
  assert.equal(s.hosts[2].error.code, "invalid_target");
  assert.deepEqual(calls(f), []);
  assert.ok(s.hosts.every((h) => !/[\u0000-\u001f]/.test(h.label)));
});
test("same names disambiguate without duplicating Self ID", () => {
  const f = fixture(
    status([node("a", "workstation"), node("b", "workstation")]),
  );
  const { s } = json(f);
  assert.equal(new Set(s.hosts.map((h) => h.label)).size, 3);
  assert.equal(new Set(s.hosts.map((h) => h.peerId)).size, 3);
});
test("existing SSH aliases and Includes map independently of OS or tailnet owner", () => {
  const f = fixture(
    status([{ ...node("a", "builder"), TailscaleIPs: ["192.0.2.24"] }]),
  );
  mkdirSync(join(f.home, ".ssh", "conf.d"));
  writeFileSync(join(f.home, ".ssh/config"), "Include conf.d/*.conf\n");
  writeFileSync(
    join(f.home, ".ssh/conf.d", "dev.conf"),
    "Host jump-alias\n HostName builder.example\n User operator\n",
  );
  const { r, s } = json(f);
  assert.equal(r.status, 0);
  assert.equal(s.hosts[1].status, "ok");
  assert.ok(
    calls(f).some((c) => c.target === "jump-alias" && !c.args.includes("-G")),
  );
  assert.ok(
    !calls(f).some(
      (c) => c.target === "builder.example" && !c.args.includes("-G"),
    ),
  );
});
test("SSH mapping cap is disclosed", () => {
  const f = fixture(status([node("a", "builder")]));
  writeFileSync(
    join(f.home, ".ssh/config"),
    Array.from({ length: 105 }, (_, i) => "Host alias" + i).join("\n"),
  );
  const { s } = json(f);
  assert.equal(s.discovery.aliasesLimited, true);
  assert.equal(s.coverage.complete, false);
  assert.ok(calls(f).filter((c) => c.args?.includes("-G")).length <= 100);
});
test("large tailnet has explicit probe limit and all skipped rows", () => {
  const f = fixture(
    status(
      Array.from({ length: 39 }, (_, i) =>
        node("p" + String(i).padStart(2, "0"), "peer" + i),
      ),
    ),
  );
  const { s } = json(f, ["--concurrency", "4"]);
  assert.equal(s.hosts.length, 40);
  assert.equal(s.coverage.attempted, 32);
  assert.equal(s.coverage.skipped, 8);
  assert.equal(
    s.hosts.filter((h) => h.error?.code === "probe_limit").length,
    8,
  );
  let running = 0,
    max = 0;
  for (const c of calls(f).filter((c) => !c.args?.includes("-G"))) {
    running += c.event === "start" ? 1 : -1;
    max = Math.max(max, running);
  }
  assert.ok(max <= 4);
  assert.equal(running, 0);
});
test("explicit selection can select a peer beyond the default probe cap", () => {
  const f = fixture(
    status(
      Array.from({ length: 40 }, (_, i) =>
        node("p" + String(i).padStart(2, "0"), "peer" + i),
      ),
    ),
  );
  const { s } = json(f, ["peer39"]);
  assert.equal(s.hosts.length, 1);
  assert.equal(s.hosts[0].status, "ok");
});
test("optional config keeps explicit fleet; --discover bypasses it and TSLS_CONFIG", () => {
  const f = fixture(status([node("a", "builder")]));
  mkdirSync(join(f.home, ".config/tsls"), { recursive: true });
  const path = join(f.home, ".config/tsls/config.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      hosts: [{ label: "only-this", transport: "local" }],
    }),
  );
  const before = readFileSync(path, "utf8");
  assert.equal(json(f).s.discovery.source, "config");
  assert.deepEqual(
    json(f).s.hosts.map((h) => h.label),
    ["only-this"],
  );
  assert.equal(json(f, ["--discover"]).s.discovery.source, "tailscale");
  assert.equal(json(f, ["--discover"]).s.hosts.length, 2);
  assert.equal(readFileSync(path, "utf8"), before);
  const r = f.run(["--discover", "--json"], {
    TSLS_CONFIG: "/missing-explicit.json",
  });
  assert.equal(r.status, 0);
  assert.equal(f.run(["--config", "/missing-explicit.json"]).status, 2);
  assert.equal(f.run(["--discover", "--config", path]).status, 2);
  writeFileSync(path, "{");
  assert.equal(f.run().status, 2);
  assert.equal(f.run(["--discover"]).status, 0);
});
test("unknown selection and invalid timing fail usage, explicit failures remain errors", () => {
  const f = fixture(status([node("a", "slow")]));
  assert.equal(f.run(["not-a-host"]).status, 2);
  assert.equal(f.run(["--timeout", "bad"]).status, 2);
  assert.equal(json(f, ["slow", "--timeout", "1"]).r.status, 1);
  assert.equal(json(f, ["--timeout", "1"]).r.status, 0);
});
test("plain retains all records and has no ANSI; human summarizes expected skips", () => {
  const f = fixture(status([node("a", "phone", "iOS")]));
  const r = f.run(["--plain"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim().split("\n").length, 3);
  assert.ok(r.stdout.includes("unsupported_os"));
  assert.ok(!r.stdout.includes(String.fromCharCode(27)));
  const human = f.run();
  assert.match(human.stdout, /unsupported_os: 1/);
  assert.match(human.stdout, /RAM FREE/);
});
test("deadline represents unstarted probes rather than dropping hosts", async () => {
  const c = new AbortController();
  c.abort();
  const r = await collectHosts(
    [
      { label: "a", transport: "ssh", target: "unused" },
      { label: "b", transport: "local" },
    ],
    { timeout: 1, concurrency: 1, signal: c.signal },
  );
  assert.equal(r.length, 2);
  assert.ok(
    r.every(
      (h) =>
        h.status === "skipped" &&
        h.error.code === "snapshot_timeout" &&
        h.metrics === null,
    ),
  );
});
test("Ctrl-C cancels discovery promptly before any SSH", async () => {
  const f = fixture(status(), "hang");
  const p = spawn(process.execPath, [bin, "--discover"], {
    env: f.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await delay(150);
  const at = Date.now();
  p.kill("SIGINT");
  assert.equal(await new Promise((resolve) => p.on("close", resolve)), 130);
  assert.ok(Date.now() - at < 1500);
  assert.deepEqual(calls(f), []);
});

test("shared short hostnames never map distinct peer IDs to the same SSH alias", () => {
  const a = { ...node("a", "builder"), DNSName: "builder-a.example" };
  const b = { ...node("b", "builder"), DNSName: "builder-b.example" };
  const f = fixture(status([a, b]));
  writeFileSync(
    join(f.home, ".ssh/config"),
    "Host builder\n HostName builder\n",
  );
  const { s } = json(f, ["--strict"]);
  assert.equal(s.coverage.succeeded, 3);
  assert.deepEqual(
    calls(f)
      .filter((c) => c.event === "start" && !c.args.includes("-G"))
      .map((c) => c.target)
      .sort(),
    ["builder-a.example", "builder-b.example"],
  );
});
test("ambiguous sole destinations are skipped instead of duplicating one machine", () => {
  const f = fixture(
    status([
      { ...node("a", "builder"), DNSName: null },
      { ...node("b", "builder"), DNSName: null },
    ]),
  );
  const { s } = json(f);
  assert.equal(s.coverage.succeeded, 1);
  assert.equal(s.coverage.skipped, 2);
  assert.ok(s.hosts.slice(1).every((h) => h.error.code === "invalid_target"));
  assert.deepEqual(calls(f), []);
});
test("intermediate Include glob truncation discloses incomplete mapping", () => {
  const f = fixture(status([node("b", "builder")]));
  const dir = join(f.home, ".ssh/conf.d");
  mkdirSync(dir);
  for (let i = 0; i < 17; i++) mkdirSync(join(dir, String(i).padStart(2, "0")));
  writeFileSync(
    join(dir, "16/alias.conf"),
    "Host jump-alias\n HostName builder.example\n",
  );
  writeFileSync(join(f.home, ".ssh/config"), "Include conf.d/*/*.conf\n");
  const { r, s } = json(f, ["--strict"]);
  assert.equal(s.discovery.aliasesLimited, true);
  assert.equal(s.coverage.complete, false);
  assert.equal(r.status, 1);
});

test("reserved init names select metrics without writing configuration", () => {
  assert.equal(labelName("init"), "init-host");
  for (const input of [
    status([node("a", "init")]),
    { ...status(), Self: node("self", "init", "macOS") },
  ]) {
    const f = fixture(input);
    const { s } = json(f);
    assert.ok(s.hosts.some((h) => h.label === "init-host"));
    const selected = json(f, ["init-host"]);
    assert.equal(selected.r.status, 0);
    assert.equal(selected.s.hosts.length, 1);
    assert.equal(selected.s.hosts[0].status, "ok");
    assert.equal(existsSync(join(f.home, ".config")), false);
  }
});

test("direct discovery uses Tailscale IP without depending on MagicDNS", () => {
  const f = fixture(
    status([{ ...node("a", "unresolvable"), TailscaleIPs: ["192.0.2.23"] }]),
  );
  const { s } = json(f);
  assert.equal(s.hosts[1].status, "ok");
  const probes = calls(f).filter(
    (c) => c.event === "start" && !c.args.includes("-G"),
  );
  assert.deepEqual(
    probes.map((c) => c.target),
    ["192.0.2.23"],
  );
});

test("SSH Host and Include accept whitespace around equals separators", () => {
  for (const separator of [" =", "= ", " = "]) {
    const f = fixture(status([node("a", "builder")]));
    mkdirSync(join(f.home, ".ssh/conf.d"));
    writeFileSync(
      join(f.home, ".ssh/config"),
      `Include${separator}conf.d/*.conf\n`,
    );
    writeFileSync(
      join(f.home, ".ssh/conf.d/alias.conf"),
      `Host${separator}jump-alias\n HostName builder.example\n`,
    );
    const { s } = json(f);
    assert.equal(s.hosts[1].status, "ok");
    assert.ok(
      calls(f).some(
        (c) =>
          c.event === "start" &&
          !c.args.includes("-G") &&
          c.target === "jump-alias",
      ),
    );
  }
});
