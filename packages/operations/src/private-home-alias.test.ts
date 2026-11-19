import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPrivateTestEnvironment } from "../test-support/private-home.mjs";

for (const mode of [
  "home-direct", "tc-home-direct", "root-direct",
  "home-ancestor", "tc-home-ancestor", "root-ancestor",
  "profile-target", "relative-chain", "parent-component", "link-loop",
  "private-direct", "private-ancestor",
]) {
  test(`private-home guard handles ${mode} without probing shared targets`, async () => {
    assertPrivateTestEnvironment();
    const home = await mkdtemp(join(tmpdir(), "tc2481-alias-guard-"));
    const env = { ...process.env, HOME: home, TC_HOME: home, USERPROFILE: home, NODE_OPTIONS: "" };
    try {
      // Actual child env stays private. The helper creates only owned aliases,
      // blocks shared-target metadata calls, and never imports profile modules.
      const child = Bun.spawn([
        process.env.NODE_BINARY ?? "node",
        new URL("../test-support/private-home-alias-probe.mjs", import.meta.url).pathname,
        mode,
      ], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual({
        status: mode.startsWith("private-") ? "admitted" : "refused",
        forbiddenProbes: 0,
      });
    } finally {
      // rm unlinks owned symlinks; it does not follow their targets.
      await rm(home, { recursive: true, force: true });
    }
  }, 10_000);
}
