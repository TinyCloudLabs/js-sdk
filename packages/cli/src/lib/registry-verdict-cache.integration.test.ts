import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const mode of ["timeout", "503", "404"] as const) {
  test(`CLI SDK and canonical operations share registry retry/cache for ${mode}`, async () => {
    const home = await mkdtemp(join(tmpdir(), "tc4373-registry-"));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, TC_HOME: home };
      for (const key of Object.keys(env)) {
        if ((key.startsWith("TC_") && key !== "TC_HOME") || key.startsWith("COURIER_") || key === "TINYCLOUD_RETRY") delete env[key];
      }
      const child = Bun.spawn([process.execPath, "--no-env-file", "run",
        new URL("../../test-support/registry-verdict-cache-smoke.ts", import.meta.url).pathname, mode], {
        env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      const result = JSON.parse(stdout);
      if (mode === "503") {
        expect(result).toEqual({ code: "REGISTRY_UNAVAILABLE",
          message: "Couldn't reach your storage settings, and none are saved on this computer yet, so this didn't run. Try again in a few minutes.",
          v2: 3, v1: 3, reads: 0 });
      } else {
        const attempts = mode === "timeout" ? 2 : 1;
        expect(result).toEqual({ completed: 140, canonical: "ok", v2: attempts, v1: attempts });
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  }, 30_000);
}
