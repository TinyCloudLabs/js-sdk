import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPrivateTestEnvironment } from "../test-support/private-home.mjs";

for (const mode of ["missing-home", "missing-tc-home", "real-home", "real-tc-home", "both-real", "profile-root", "private"] as const) {
  test(`profile fixture guard ${mode}: refuse before I/O or admit a private temporary fixture`, async () => {
    assertPrivateTestEnvironment();
    const home = await mkdtemp(join(tmpdir(), "tc2481-home-guard-"));
    const marker = join(home, "after-guard");
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, TC_HOME: home, USERPROFILE: home };
    for (const key of Object.keys(env)) {
      if ((key.startsWith("TC_") && key !== "TC_HOME") || key.startsWith("COURIER_")) delete env[key];
    }
    try {
      // Even negative guard probes START private. The helper supplies only
      // synthetic unsafe strings to the guard before importing profile code.
      const child = Bun.spawn([process.execPath, "--no-env-file", new URL("../test-support/private-home-probe.ts", import.meta.url).pathname, mode, marker], {
        env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      if (mode === "private") {
        expect(JSON.parse(stdout)).toEqual({ status: "admitted", profileFilesPresent: true });
        expect(await Bun.file(marker).text()).toBe("admitted\n");
      } else {
        expect(JSON.parse(stdout)).toEqual({ status: "refused" });
        expect(await Bun.file(marker).exists()).toBe(false);
        expect(await Bun.file(join(home, ".tinycloud", "profiles", "owner", "profile.json")).exists()).toBe(false);
        expect(await Bun.file(join(home, ".tinycloud", "profiles", "delegate", "session.json")).exists()).toBe(false);
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  }, 15_000);
}
