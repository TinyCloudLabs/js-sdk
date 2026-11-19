import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The profile store reads TC_HOME when it loads, so import it afterwards.
const home = await mkdtemp(join(tmpdir(), "tc-profile-boundary-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("./profiles.js");
const { PROFILES_DIR } = await import("./constants.js");
const { readProfile, readSession } = await import("@tinycloud/operations/state");
const { resolveInvocationProfile } = await import("@tinycloud/operations/profile");

const NAME = "loose";
const FILES = ["profile.json", "key.json", "session.json"];
const profileDir = join(PROFILES_DIR, NAME);
const outsideFile = join(home, "outside.json");

beforeEach(async () => {
  await rm(join(home, ".tinycloud"), { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, "profile.json"), JSON.stringify({
    name: NAME,
    host: "https://node.tinycloud.test",
    chainId: 1,
    spaceName: "default",
    did: "did:key:loose",
    createdAt: "2026-10-01T00:00:00.000Z",
  }));
  await writeFile(join(profileDir, "key.json"), JSON.stringify({ kty: "OKP", crv: "Ed25519" }));
  await writeFile(join(profileDir, "session.json"), JSON.stringify({}));
  await writeFile(outsideFile, "{}");
  await symlink(outsideFile, join(profileDir, "external.json"));
  // Fixture state is set explicitly so the process umask cannot change it.
  await chmod(profileDir, 0o755);
  for (const file of FILES) await chmod(join(profileDir, file), 0o644);
  await chmod(outsideFile, 0o644);
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

// An older release, or another account on the machine, can leave a profile directory and its files readable by
// others. Whichever reader loads a profile first must tighten them, not only `getProfile`.
const readers: Record<string, () => Promise<unknown>> = {
  "ProfileManager.getProfile": () => ProfileManager.getProfile(NAME),
  "ProfileManager.getKey": () => ProfileManager.getKey(NAME),
  "ProfileManager.getSession": () => ProfileManager.getSession(NAME),
  "operations readProfile": () => readProfile(NAME),
  "operations readSession": () => readSession(NAME),
  "operations resolveInvocationProfile": () => resolveInvocationProfile({ profile: NAME }),
};

describe("loading profile state tightens the profile directory and its files", () => {
  for (const [label, read] of Object.entries(readers)) {
    test(`${label}: directory 0700, files 0600, a planted link's target untouched`, async () => {
      await read();

      expect((await stat(profileDir)).mode & 0o777).toBe(0o700);
      for (const file of FILES) expect((await stat(join(profileDir, file))).mode & 0o777).toBe(0o600);
      expect((await stat(outsideFile)).mode & 0o777).toBe(0o644);
    });
  }
});
