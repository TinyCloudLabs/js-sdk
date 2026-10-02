import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, profileConfigPath, profilePath, writeJsonAtomic } from "@tinycloud/operations/state";
import { authStateDigest, writePrivateAuthJson } from "./private-storage.js";
import { installVerifiedSession, recoverVerifiedSessionInstall } from "./session-install.js";
const home = await mkdtemp(join(tmpdir(), "tc-session-install-"));
process.env.TC_HOME = home;
afterAll(() => rm(home, { recursive: true, force: true }));
const profile = { name: "test", host: "https://node.invalid", did: "did:key:synthetic" };
const key = { x: "public", d: "private" };
test("verified session installation is private, restartable and rejects context drift", async () => {
  await writeJsonAtomic(profileConfigPath("test"), profile);
  await writeJsonAtomic(join(profilePath("test"), "key.json"), key);
  const updated = { ...profile, ownerDid: "did:pkh:synthetic" };
  const session = { delegationCid: "cid", jwk: key };
  await installVerifiedSession("test", profile, key, updated, session);
  await installVerifiedSession("test", profile, key, updated, session);
  expect(await readJson<typeof updated>(profileConfigPath("test"))).toEqual(updated);
  expect(JSON.parse(await readFile(join(profilePath("test"), "session.json"), "utf8"))).toEqual(session);
  for (const file of ["session.json", "profile.json", "auth-install.json"]) expect((await stat(join(profilePath("test"), file))).mode & 0o777).toBe(0o600);
  await writeJsonAtomic(join(profilePath("test"), "key.json"), { x: "other", d: "other" });
  await expect(installVerifiedSession("test", profile, key, updated, session)).rejects.toMatchObject({ code: "AUTH_CONTEXT_CHANGED" });
});

test("recovers an interrupted verified install before asking for another approval", async () => {
  const expected = { ...profile, name: "recover" };
  const next = { ...expected, ownerDid: "did:pkh:synthetic" };
  const session = { delegationCid: "recover-cid", jwk: key };
  await writePrivateAuthJson(profileConfigPath("recover"), expected);
  await writePrivateAuthJson(join(profilePath("recover"), "key.json"), key);
  await writePrivateAuthJson(join(profilePath("recover"), "auth-install.json"), {
    formatVersion: 1, completed: false, expectedProfileDigest: authStateDigest(expected), expectedKeyDigest: authStateDigest(key),
    sessionDigest: authStateDigest(session), profile: next, session,
  });
  await recoverVerifiedSessionInstall("recover");
  expect(await readJson<typeof next>(profileConfigPath("recover"))).toEqual(next);
  expect(await readJson<typeof session>(join(profilePath("recover"), "session.json"))).toEqual(session);
  expect(await readJson<{ completed: boolean }>(join(profilePath("recover"), "auth-install.json"))).toMatchObject({ completed: true });
});
