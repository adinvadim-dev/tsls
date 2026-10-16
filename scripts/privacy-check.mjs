import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "--cached", "-z"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
const forbidden = [
  /tail\d+\.ts\.net/i,
  /(?<![\d.])(?!(?:192\.0\.2\.|198\.51\.100\.|203\.0\.113\.))(?:\d{1,3}\.){3}\d{1,3}\b/,
  /\/Users\/[a-z]+\//,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|ops_[A-Za-z0-9_-]{30,})/,
  /-----BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY-----/,
];
let count = 0;
for (const file of files) {
  if (file === "scripts/privacy-check.mjs") continue;
  const data = readFileSync(file, "utf8");
  if (forbidden.some((pattern) => pattern.test(data)))
    throw new Error(`Private-looking data in ${file}; inspect locally`);
  count++;
}
process.stdout.write(
  `Public staged-file privacy check passed (${count} files).\n`,
);
