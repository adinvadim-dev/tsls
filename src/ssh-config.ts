import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execute } from "./process.js";

export type Alias = { alias: string; hostname: string };
export const safeAlias = (value: string): boolean =>
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/.test(value);
function tokens(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}
async function expand(path: string): Promise<string[]> {
  const parts = resolve(path).split("/").filter(Boolean);
  let paths = ["/"];
  for (const part of parts) {
    const next: string[] = [];
    for (const base of paths) {
      if (!/[?*]/.test(part)) next.push(join(base, part));
      else {
        const pattern = new RegExp(
          `^${part
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".")}$`,
        );
        try {
          for (const name of (await readdir(base)).sort())
            if (pattern.test(name)) next.push(join(base, name));
        } catch {
          /* Missing optional includes are normal. */
        }
      }
      if (next.length >= 16) break;
    }
    paths = next.slice(0, 16);
  }
  return paths;
}
export async function resolveAliases(
  signal: AbortSignal,
): Promise<{ aliases: Alias[]; limited: boolean }> {
  const budget = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const names = new Set<string>();
  const seen = new Set<string>();
  let limited = false;
  async function visit(path: string, base: string): Promise<void> {
    if (budget.aborted) {
      limited = true;
      return;
    }
    if (seen.has(path)) return;
    if (seen.size >= 16 || names.size >= 100) {
      limited = true;
      return;
    }
    seen.add(path);
    let text: string;
    try {
      text = await readFile(path, { encoding: "utf8", signal: budget });
    } catch {
      return;
    }
    if (Buffer.byteLength(text) > 65536) {
      limited = true;
      return;
    }
    for (const line of text.split("\n")) {
      const match = line.match(/^\s*(Host|Include)(?:\s+|=)\s*(.+)$/i);
      if (!match?.[1] || !match[2]) continue;
      if (match[1].toLowerCase() === "host") {
        for (const name of tokens(match[2].split("#")[0] ?? "")) {
          if (!safeAlias(name)) continue;
          if (names.size < 100) names.add(name);
          else limited = true;
        }
      } else {
        for (const file of tokens(match[2].split("#")[0] ?? "")) {
          const expanded = file.startsWith("~/")
            ? join(homedir(), file.slice(2))
            : isAbsolute(file)
              ? file
              : join(base, file);
          for (const included of await expand(expanded))
            await visit(included, base);
        }
      }
    }
  }
  await visit(join(homedir(), ".ssh/config"), join(homedir(), ".ssh"));
  await visit("/etc/ssh/ssh_config", "/etc/ssh");
  const aliases: Alias[] = [];
  const list = [...names];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, list.length) }, async () => {
      while (next < list.length) {
        const name = list[next++];
        if (!name) continue;
        if (budget.aborted) {
          limited = true;
          continue;
        }
        try {
          const result = await execute({
            command: "ssh",
            args: [
              "-G",
              "-o",
              "BatchMode=yes",
              "-o",
              "StrictHostKeyChecking=yes",
              "--",
              name,
            ],
            signal: budget,
            timeoutMs: 1500,
            maxBytes: 65536,
          });
          const hostname = result.stdout
            .match(/^hostname\s+(.+)$/m)?.[1]
            ?.trim();
          if (result.code === 0 && hostname)
            aliases.push({ alias: name, hostname });
          else limited = true;
        } catch {
          limited = true;
        }
      }
    }),
  );
  // Completion order must not change alias preference.
  aliases.sort((a, b) => list.indexOf(a.alias) - list.indexOf(b.alias));
  return { aliases, limited };
}
