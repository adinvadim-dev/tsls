import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { execute } from "../dist/process.js";

for (const abort of [false, true]) {
  test(`${abort ? "abort" : "timeout"} closes inherited pipes after the direct child exits`, async () => {
    const root = mkdtempSync(join(tmpdir(), "tsls-pipe-"));
    const file = join(root, "holder.pid");
    const controller = new AbortController();
    const timer = abort ? setTimeout(() => controller.abort(), 200) : null;
    const started = performance.now();
    try {
      await assert.rejects(
        execute({
          command: process.execPath,
          args: [
            "-e",
            `const {spawn}=require('child_process'); const child=spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{detached:true,stdio:['ignore',1,2]}); require('fs').writeFileSync(process.argv[1],String(child.pid)); child.unref(); process.exit(0);`,
            file,
          ],
          timeoutMs: abort ? 3000 : 200,
          maxBytes: 1024,
          signal: controller.signal,
        }),
        (error) => error.code === (abort ? "cancelled" : "timeout"),
      );
      assert.ok(
        performance.now() - started < 2000,
        "inherited pipes must not defeat the budget",
      );
    } finally {
      if (timer) clearTimeout(timer);
      if (existsSync(file)) {
        const pid = Number(readFileSync(file, "utf8"));
        assert.ok(Number.isSafeInteger(pid) && pid > 1);
        try {
          process.kill(-pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    }
  });
}
