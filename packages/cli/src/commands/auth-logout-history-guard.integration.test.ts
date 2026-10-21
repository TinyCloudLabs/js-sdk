import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileConfigPath, profilePath, sessionPath, withTinyCloudStateRoot, writeJsonAtomic } from "@tinycloud/operations/state";

const PROFILE = "owner";
const PRINCIPAL = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";
const cliEntry = join(import.meta.dir, "../index.ts");
const CHILD_TIMEOUT_MS = 30_000;
const SESSION_KEY = JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "private-session-key" });
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

// The child gets only what it needs: an isolated home and PATH. Inheriting the
// parent environment would let host profile, token, or proxy settings leak in.
async function run(home: string, args: string[]) {
  const child = Bun.spawn([process.execPath, cliEntry, "--quiet", "--json", "--profile", PROFILE, ...args], {
    env: { HOME: home, TC_HOME: home, PATH: process.env.PATH ?? "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
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
    await writeFile(key, SESSION_KEY);
    const history = join(directory, "cache", "share-history-v2.json");
    if (historyBytes !== undefined) {
      await mkdir(join(directory, "cache"), { recursive: true });
      await writeFile(history, historyBytes);
    }
    return { history, key, session: sessionPath(PROFILE) };
  });
}

async function scratchHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  homes.push(home);
  return home;
}

test("logout refuses unreadable sender history without changing the session, key, or history bytes", async () => {
  const home = await scratchHome("tc1669-logout-guard-refuse-");
  const paths = await seedOpenKeyProfile(home, "not-json-history");
  const refused = await run(home, ["auth", "logout"]);
  expect(refused.exitCode).toBe(5);
  expect(refused.stderr).toContain("SHARE_HISTORY_UNAVAILABLE");
  expect(await readFile(paths.session, "utf8")).toContain("bafy-session");
  expect(await readFile(paths.key, "utf8")).toBe(SESSION_KEY);
  expect(await readFile(paths.history, "utf8")).toBe("not-json-history");
}, CHILD_TIMEOUT_MS);

test("logout with --force proceeds and never quarantines or rewrites the history file", async () => {
  const home = await scratchHome("tc1669-logout-guard-force-");
  const paths = await seedOpenKeyProfile(home, "not-json-history");
  const forced = await run(home, ["auth", "logout", "--force"]);
  expect(forced.exitCode).toBe(0);
  expect(await readFile(paths.history, "utf8")).toBe("not-json-history");
  const cacheEntries = await withTinyCloudStateRoot(home, async () => readdir(join(profilePath(PROFILE), "cache")));
  expect(cacheEntries.filter((name) => name.includes(".unreadable-"))).toEqual([]);
}, CHILD_TIMEOUT_MS);

test("logout proceeds when the profile has no sender history", async () => {
  const home = await scratchHome("tc1669-logout-guard-none-");
  await seedOpenKeyProfile(home);
  const plain = await run(home, ["auth", "logout"]);
  expect(plain.exitCode).toBe(0);
}, CHILD_TIMEOUT_MS);

test("rotate refuses unreadable sender history before generating a key, leaving the key and history unchanged", async () => {
  const home = await scratchHome("tc1669-rotate-guard-refuse-");
  const paths = await seedOpenKeyProfile(home, "not-json-history");
  const refused = await run(home, ["auth", "rotate"]);
  expect(refused.exitCode).toBe(5);
  expect(refused.stderr).toContain("SHARE_HISTORY_UNAVAILABLE");
  expect(await readFile(paths.key, "utf8")).toBe(SESSION_KEY);
  expect(await readFile(paths.history, "utf8")).toBe("not-json-history");
}, CHILD_TIMEOUT_MS);

test("replica-enabled login refuses unreadable sender history before replacing the stored session key", async () => {
  const home = await scratchHome("tc1669-login-guard-refuse-");
  const paths = await seedOpenKeyProfile(home, "not-json-history");
  const refused = await run(home, ["auth", "login", "--method", "openkey", "--owner", PRINCIPAL, "--replication-prefix", "app/", "--paste"]);
  expect(refused.exitCode).toBe(5);
  expect(refused.stderr).toContain("SHARE_HISTORY_UNAVAILABLE");
  expect(await readFile(paths.key, "utf8")).toBe(SESSION_KEY);
  expect(await readFile(paths.history, "utf8")).toBe("not-json-history");
}, CHILD_TIMEOUT_MS);

test("replica-enabled login with --force is not refused by the share history check and leaves the stored key untouched", async () => {
  const home = await scratchHome("tc1669-login-guard-force-");
  const paths = await seedOpenKeyProfile(home, "not-json-history");
  const forced = await run(home, ["auth", "login", "--method", "openkey", "--owner", PRINCIPAL, "--replication-prefix", "app/", "--paste", "--force"]);
  expect(forced.stderr).not.toContain("SHARE_HISTORY_");
  expect(forced.exitCode).not.toBe(5);
  expect(await readFile(paths.key, "utf8")).toBe(SESSION_KEY);
  expect(await readFile(paths.history, "utf8")).toBe("not-json-history");
}, CHILD_TIMEOUT_MS);
