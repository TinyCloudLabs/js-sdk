import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { resolveInvocationContext } from "./profile.js";
import { profileConfigPath, writeJsonAtomic } from "./state.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(`${tmpdir()}/tinycloud-operations-profile-`);
  process.env.TC_HOME = home;
});

afterEach(async () => {
  delete process.env.TC_HOME;
  await rm(home, { recursive: true, force: true });
});

test("keeps a same-owner delegate profile in delegate posture", async () => {
  await profile("delegate", {
    did: "did:pkh:eip155:1:0xOwner",
    ownerDid: "did:pkh:eip155:1:0xOwner",
    sessionDid: "did:key:delegate#key-1",
    posture: "delegate-session",
  });

  await expect(resolveInvocationContext({ profile: "delegate" })).resolves.toEqual({
    ok: true,
    context: {
      profile: "delegate",
      host: "https://node.example",
      posture: "delegate-session",
      operatorType: "agent",
      principalDid: "did:pkh:eip155:1:0xOwner",
      sessionDid: "did:key:delegate",
      ownerDid: "did:pkh:eip155:1:0xOwner",
    },
  });
});

test("a missing explicit profile never selects the configured fallback", async () => {
  await profile("fallback", { did: "did:key:fallback" });
  await writeJsonAtomic(`${home}/.tinycloud/config.json`, { defaultProfile: "fallback" });

  await expect(resolveInvocationContext({ profile: "deleted" })).resolves.toEqual({
    ok: false,
    error: {
      code: "PROFILE_NOT_FOUND",
      message: 'Profile "deleted" is not available.',
      retryable: false,
    },
  });
});

async function profile(name: string, overrides: Record<string, unknown>): Promise<void> {
  await writeJsonAtomic(profileConfigPath(name), {
    name,
    host: "https://node.example",
    chainId: 1,
    spaceName: "secrets",
    createdAt: "2026-07-14T12:00:00.000Z",
    operatorType: "agent",
    ...overrides,
  });
}
