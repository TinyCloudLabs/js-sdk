import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { profileConfigPath, tinycloudConfigPath, writeJsonAtomic } from "./state.js";
import { resolveInvocationContext } from "./profile.js";

const originalTcHome = process.env.TC_HOME;
const originalHome = process.env.HOME;
const homes: string[] = [];

afterEach(async () => {
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function isolatedHome(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "tinycloud-operations-profile-"));
  homes.push(home);
  process.env.TC_HOME = home;
  process.env.HOME = homedir();
}

test("returns PROFILE_NOT_FOUND for a deleted pinned profile and never falls back", async () => {
  await isolatedHome();
  await writeJsonAtomic(tinycloudConfigPath(), { defaultProfile: "fallback", version: 1 });
  await writeJsonAtomic(profileConfigPath("fallback"), {
    host: "https://fallback.tinycloud.test",
    did: "did:key:fallback",
  });

  const result = await resolveInvocationContext({ profile: "deleted" });

  expect(result).toEqual({
    ok: false,
    error: {
      code: "PROFILE_NOT_FOUND",
      message: 'Profile "deleted" is not available.',
      retryable: false,
    },
  });
});

test("returns safe profile identity without profile or invocation private-key material", async () => {
  await isolatedHome();
  await writeJsonAtomic(profileConfigPath("delegate"), {
    host: "https://node.tinycloud.test",
    did: "did:pkh:eip155:1:0xowner#controller",
    sessionDid: "did:key:session#key-1",
    ownerDid: "did:pkh:eip155:1:0xowner#owner",
    spaceId: "tinycloud:pkh:eip155:1:0xowner:secrets",
    posture: "delegate-session",
    operatorType: "agent",
    privateKey: "profile-private-key-canary",
  });

  const result = await resolveInvocationContext({
    profile: "delegate",
    privateKey: "invocation-private-key-canary",
  });

  expect(result).toEqual({
    ok: true,
    context: {
      profile: "delegate",
      host: "https://node.tinycloud.test",
      posture: "delegate-session",
      operatorType: "agent",
      principalDid: "did:pkh:eip155:1:0xowner",
      sessionDid: "did:key:session",
      ownerDid: "did:pkh:eip155:1:0xowner",
      space: "tinycloud:pkh:eip155:1:0xowner:secrets",
    },
  });
  expect(JSON.stringify(result)).not.toContain("private-key-canary");
});
