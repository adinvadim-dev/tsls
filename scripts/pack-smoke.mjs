import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temp = mkdtempSync(join(tmpdir(), "tsls-pack-"));
function run(command, args, cwd = process.cwd(), env = process.env) {
  const r = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(
    r.status,
    0,
    `${command} ${args.join(" ")}\n${r.stdout}\n${r.stderr}`,
  );
  return r.stdout;
}
const pack = JSON.parse(
  run("npm", ["pack", "--json", "--pack-destination", temp]),
)[0];
const names = pack.files.map((file) => file.path);
assert.ok(names.includes("dist/cli.js"));
assert.ok(names.includes("docs/assets/hero.svg"));
assert.ok(
  names.every((name) =>
    /^(dist\/|docs\/cli.md$|docs\/assets\/hero.svg$|README.md$|LICENSE$|package.json$)/.test(
      name,
    ),
  ),
  names.join("\n"),
);
run("npm", [
  "install",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--prefix",
  temp,
  join(temp, pack.filename),
]);
const bin = join(temp, "node_modules", ".bin", "tsls");
assert.match(run(bin, ["--help"]), /Usage: tsls/);
assert.equal(
  run(bin, ["--version"]).trim(),
  JSON.parse(readFileSync("package.json", "utf8")).version,
);
const config = join(temp, "config.json");
writeFileSync(
  config,
  JSON.stringify({
    version: 1,
    hosts: [{ label: "local", transport: "local" }],
  }),
);
assert.equal(
  JSON.parse(run(bin, ["--config", config, "--json"])).hosts[0].status,
  "ok",
);
mkdirSync(join(temp, "empty"));
run(
  "npm",
  ["exec", "--offline", "--prefix", temp, "--", "tsls", "--version"],
  join(temp, "empty"),
);
const runtimeFile = readFileSync(resolve("dist/cli.js"), "utf8");
assert.ok(!runtimeFile.includes(process.cwd()));
process.stdout.write(
  `Pack/install/bin/local JSON/npm exec smoke passed (${names.length} files). Tarball: ${join(temp, pack.filename)}\n`,
);
