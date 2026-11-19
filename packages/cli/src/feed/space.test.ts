import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Separate process: the real profile/resolver modules must not inherit sibling
// tests' global mock.module replacements or modify the user's selected profile.
test("an imported delegate session routes its signed primary name without a wallet address", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc2205-feed-space-"));
  const primary = "tinycloud:pkh:eip155:1:0x1234567890123456789012345678901234567890:owner_inbox";
  const applications = primary.replace(":owner_inbox", ":applications");
  const explicit = primary.replace(":owner_inbox", ":explicit");
  try {
    const modulePath = new URL("./space.ts", import.meta.url).pathname;
    const profilesPath = new URL("../config/profiles.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, "--eval", `
      import { resolveFeedSpace } from ${JSON.stringify(modulePath)};
      import { ProfileManager } from ${JSON.stringify(profilesPath)};
      await ProfileManager.setProfile('imported', {
        name: 'imported', host: 'http://127.0.0.1:1', chainId: 1,
        posture: 'delegate-session', operator: 'agent', authMethod: 'delegation',
      });
      await ProfileManager.setSession('imported', { spaceId: ${JSON.stringify(primary)} });
      const session = await ProfileManager.getSession('imported');
      const inputs = [
        [session.spaceId, 'owner_inbox'],
        [${JSON.stringify(applications)}, 'applications'],
        [session.spaceId, ${JSON.stringify(explicit)}],
        [session.spaceId, 'inbox'],
        [session.spaceId, 'other'],
        [undefined, 'applications'],
      ];
      const results = [];
      for (const [primary, requested] of inputs) {
        try { results.push(await resolveFeedSpace(primary, requested, 'imported')); }
        catch (error) { results.push({ code: error.code }); }
      }
      console.log(JSON.stringify(results));
    `], { env: { ...process.env, TC_HOME: home }, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect({ exit: await child.exited, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual([
      primary, applications, explicit,
      { code: "ADDRESS_UNKNOWN" }, { code: "ADDRESS_UNKNOWN" }, { code: "ADDRESS_UNKNOWN" },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
