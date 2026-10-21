import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileConfigPath, profilePath, sessionPath, withTinyCloudStateRoot, writeJsonAtomic } from "@tinycloud/operations/state";

const PROFILE = "owner";
const PRINCIPAL = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";
const cliEntry = join(import.meta.dir, "../index.ts");
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function run(home: string, args: string[] = []) {
  const child = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE, "auth", "logout", ...args], {
    env: { ...process.env, HOME: home, TC_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function seedOpenKeyProfile(home: string, historyBytes?: string): Promise<{ history: string; key: string; session: string }> {
  return withTinyCloudStateRoot(home, async () => {
    await writeJsonAtomic(profileConfigPath(PROFILE), {
      name: PROFILE, host: "https://node.example.test", chainId: 1, spaceName: "default",
      did: PRINCIPAL, ownerDid: PRINCIPAL, createdAt: "2026-10-01T00:00:00.000Z",
    });
    await writeJsonAtomic(sessionPath(PROFILE), { ownerDid: PRINCIPAL, delegationCid: "bafy-session" });
    const directory = profilePath(PROFILE);
    const key = join(directory, "key.json");
    await writeFile(key, "private-session-key");
    const history = join(directory, "cache", "share-history-v2.json");
    if (historyBytes !== undefined) {
      await mkdir(join(directory, "cache"), { recursive: true });
      await writeFile(history, historyBytes);
    }
    return { history, key, session: sessionPath(PROFILE) };
  });
}

test("logout refuses unreadable sender history without changing the session, key, or history bytes", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc1669-logout-guard-refuse-"));
  homes.push(home);
  const paths = await seedOpenKeyProfile(home, "not-json-history");
  const refused = await run(home);
  expect(refused.exitCode).toBe(5);
  expect(refused.stderr).toContain("SHARE_HISTORY_UNAVAILABLE");
  expect(await readFile(paths.session, "utf8")).toContain("bafy-session");
  expect(await readFile(paths.key, "utf8")).toBe("private-session-key");
  expect(await readFile(paths.history, "utf8")).toBe("not-json-history");
});

test("logout with --force proceeds and never quarantines or rewrites the history file", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc1669-logout-guard-force-"));
  homes.push(home);
  const paths = await seedOpenKeyProfile(home, "not-json-history");
  const forced = await run(home, ["--force"]);
  expect(forced.exitCode).toBe(0);
  expect(await readFile(paths.history, "utf8")).toBe("not-json-history");
  const cacheEntries = await withTinyCloudStateRoot(home, async () => readdir(join(profilePath(PROFILE), "cache")));
  expect(cacheEntries.filter((name) => name.includes(".unreadable-"))).toEqual([]);
});

test("logout proceeds when the profile has no sender history", async () => {
  const home = await mkdtemp(join(tmpdir(), "tc1669-logout-guard-none-"));
  homes.push(home);
  await seedOpenKeyProfile(home);
  const plain = await run(home);
  expect(plain.exitCode).toBe(0);
});
