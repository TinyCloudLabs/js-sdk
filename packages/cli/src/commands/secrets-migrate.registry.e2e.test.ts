import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same real-node integration boundary as secrets-per-secret-keys.e2e.test.ts.
const nodeBinary = process.env.TC_NAMED_KEYS_E2E_NODE_BIN;
test.skipIf(!nodeBinary)("140-secret CLI migrate finishes for an unregistered owner with one registry pair per TTL", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc4373-full-migrate-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, TC_HOME: home };
    for (const key of Object.keys(env)) {
      if ((key.startsWith("TC_") && key !== "TC_HOME") || key.startsWith("COURIER_") || key.startsWith("TINYCLOUD_")) delete env[key];
    }
    const child = Bun.spawn([process.execPath, "--no-env-file", "run",
      new URL("../../test-support/secrets-migrate-registry-smoke.ts", import.meta.url).pathname, nodeBinary!], {
      env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ exitCode: 0, total: 140, moved: 140, verified: 140 });
    expect(result.v2).toBeGreaterThanOrEqual(1);
    expect(result.v2).toBeLessThanOrEqual(1 + Math.floor(result.elapsedMs / 60_000));
    expect(result.v1).toBe(result.v2);
    console.log(`TC-4373 full migration: ${stdout.trim()}`);
  } finally { await rm(home, { recursive: true, force: true }); }
}, 300_000);
