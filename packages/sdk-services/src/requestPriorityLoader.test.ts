import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a cold first invocation retries and reuses its loaded module promise", () => {
  const directory = mkdtempSync(join(tmpdir(), "sdk-cold-priority-"));
  const privateHome = join(directory, "home");
  const privateTcHome = join(directory, "tc");
  mkdirSync(privateHome);
  mkdirSync(privateTcHome);
  const fixture = join(directory, "cold.ts");
  writeFileSync(fixture, `
import assert from "node:assert/strict";
import { ServiceContext } from ${JSON.stringify(new URL("./context.ts", import.meta.url).href)};
import { loadRequestPriority } from ${JSON.stringify(new URL("./requestPriorityLoader.ts", import.meta.url).href)};

const lanesKey = Symbol.for("@tinycloud/sdk-services/request-lanes");
assert.equal(globalThis[lanesKey], undefined);
let attempts = 0;
let builds = 0;
const context = new ServiceContext({
  hosts: ["https://cold-priority.invalid"],
  invoke: () => ({}),
  retryPolicy: { maxAttempts: 2, maxTotalMs: 1000 },
  fetch: async () => ++attempts === 1
    ? new Response("sql_busy: begin: database is locked", { status: 503, headers: { "retry-after": "0" } })
    : new Response("ok"),
});
const pending = context.invokeWithRetry("https://cold-priority.invalid/invoke", () => {
  builds++;
  return { method: "POST" };
});
const loading = loadRequestPriority();
assert.equal(loadRequestPriority(), loading);
const response = await pending;
assert.equal(await response.text(), "ok");
assert.equal(attempts, 2);
assert.equal(builds, 2);
assert.equal(response.retry?.attempts, 2);
assert.equal(loadRequestPriority(), loading);
assert.notEqual(globalThis[lanesKey], undefined);
console.log("cold dispatch and cached loader verified");
`, { mode: 0o600 });
  try {
    const output = execFileSync(process.execPath, [fixture], {
      env: { ...process.env, HOME: privateHome, TC_HOME: privateTcHome },
      timeout: 10_000,
      encoding: "utf8",
    });
    expect(output).toContain("cold dispatch and cached loader verified");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
