import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The profile store reads TC_HOME when it loads, so import it afterwards.
const home = await mkdtemp(join(tmpdir(), "tc-profile-modes-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("./profiles.js");
const { PROFILES_DIR } = await import("./constants.js");

beforeEach(async () => {
  await rm(join(home, ".tinycloud"), { recursive: true, force: true });
  await mkdir(PROFILES_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

test("loading a legacy profile tightens its directory and files without following symlinks", async () => {
  const profileDir = join(PROFILES_DIR, "legacy");
  const lockDir = join(profileDir, ".lock");
  const outsideDir = join(home, "outside");
  await mkdir(lockDir, { recursive: true, mode: 0o755 });
  await mkdir(outsideDir, { mode: 0o755 });
  await writeFile(join(profileDir, "profile.json"), JSON.stringify({
    name: "legacy",
    host: "https://node.tinycloud.test",
    chainId: 1,
    spaceName: "default",
    did: "did:key:legacy",
    createdAt: "2026-10-01T00:00:00.000Z",
  }), { mode: 0o644 });
  for (const file of ["key.json", "config.json", ".atomic.tmp"]) {
    await writeFile(join(profileDir, file), "{}", { mode: 0o644 });
  }
  const outsideFile = join(outsideDir, "external.json");
  await writeFile(outsideFile, "{}", { mode: 0o644 });
  await symlink(outsideFile, join(profileDir, "external.json"));
  await chmod(profileDir, 0o755);
  // mkdir/writeFile modes are masked by the umask; chmod is not.
  await chmod(lockDir, 0o755);
  await chmod(outsideFile, 0o644);
  for (const file of ["profile.json", "key.json", "config.json", ".atomic.tmp"]) {
    await chmod(join(profileDir, file), 0o644);
  }

  expect((await ProfileManager.getProfile("legacy")).name).toBe("legacy");

  const paths = [
    profileDir,
    join(profileDir, "profile.json"),
    join(profileDir, "key.json"),
    join(profileDir, "config.json"),
    join(profileDir, ".atomic.tmp"),
  ];
  const modes = async () => Promise.all(paths.map(async (path) => (await stat(path)).mode & 0o777));
  expect(await modes()).toEqual([0o700, 0o600, 0o600, 0o600, 0o600]);
  expect((await stat(outsideFile)).mode & 0o777).toBe(0o644);
  await ProfileManager.getProfile("legacy");
  expect(await modes()).toEqual([0o700, 0o600, 0o600, 0o600, 0o600]);
});
