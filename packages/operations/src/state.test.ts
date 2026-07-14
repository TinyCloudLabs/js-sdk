import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProfileLockTimeoutError,
  additionalDelegationsPath,
  authRequestsPath,
  profileLockMetadataPath,
  profileLockPath,
  profilePath,
  profileStoreMetadataPath,
  readAdditionalDelegations,
  readProfileStore,
  readSession,
  readStoreMetadata,
  removeSession,
  sessionPath,
  tinycloudHomePath,
  upsertProfileRecord,
  writeJsonAtomic,
  writeSession,
} from "./state.js";

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

async function isolatedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "tinycloud-operations-state-"));
  homes.push(home);
  process.env.TC_HOME = home;
  process.env.HOME = homedir();
  return home;
}

function request(requestId: string, revision = 1): { requestId: string; revision: number } {
  return { requestId, revision };
}

test("reads unversioned format-1 stores and writes format metadata without changing JSON layout", async () => {
  await isolatedHome();
  const profile = "delegate";
  await mkdir(profilePath(profile), { recursive: true });
  await writeFile(
    authRequestsPath(profile),
    '[\n  {\n    "requestId": "req-old",\n    "revision": 1\n  }\n]\n',
    "utf8",
  );

  expect(await readStoreMetadata(profile, "auth-requests")).toEqual({ formatVersion: 1 });
  expect(await readProfileStore<{ requestId: string; revision: number }>(profile, "auth-requests")).toEqual({
    formatVersion: 1,
    records: [request("req-old")],
  });

  await upsertProfileRecord(
    profile,
    "auth-requests",
    "req-new",
    request("req-new"),
    (candidate) => candidate.requestId,
  );

  expect(await readFile(authRequestsPath(profile), "utf8")).toBe(
    '[\n  {\n    "requestId": "req-old",\n    "revision": 1\n  },\n  {\n    "requestId": "req-new",\n    "revision": 1\n  }\n]\n',
  );
  expect(await readFile(profileStoreMetadataPath(profile, "auth-requests"), "utf8")).toBe(
    '{\n  "formatVersion": 1\n}\n',
  );
});

test("atomically appends records and replaces duplicate explicit keys", async () => {
  await isolatedHome();
  const profile = "delegate";

  await upsertProfileRecord(
    profile,
    "additional-delegations",
    "bafy-one",
    { delegation: { cid: "bafy-one" }, revision: 1 },
    (candidate) => candidate.delegation.cid,
  );
  await upsertProfileRecord(
    profile,
    "additional-delegations",
    "bafy-two",
    { delegation: { cid: "bafy-two" }, revision: 1 },
    (candidate) => candidate.delegation.cid,
  );
  await upsertProfileRecord(
    profile,
    "additional-delegations",
    "bafy-one",
    { delegation: { cid: "bafy-one" }, revision: 2 },
    (candidate) => candidate.delegation.cid,
  );

  const text = await readFile(additionalDelegationsPath(profile), "utf8");
  expect(text.endsWith("\n")).toBe(true);
  expect(await readAdditionalDelegations(profile)).toEqual([
    { delegation: { cid: "bafy-two" }, revision: 1 },
    { delegation: { cid: "bafy-one" }, revision: 2 },
  ]);
  expect(JSON.parse(text)).toEqual([
    { delegation: { cid: "bafy-two" }, revision: 1 },
    { delegation: { cid: "bafy-one" }, revision: 2 },
  ]);
});

test("writes and removes sessions under the profile lock with legacy JSON bytes", async () => {
  await isolatedHome();
  const profile = "delegate";
  await writeSession(profile, { authMethod: "openkey", verificationMethod: "did:key:session" });

  expect(await readFile(sessionPath(profile), "utf8")).toBe(
    '{\n  "authMethod": "openkey",\n  "verificationMethod": "did:key:session"\n}\n',
  );
  expect(await readSession(profile)).toEqual({
    authMethod: "openkey",
    verificationMethod: "did:key:session",
  });
  expect(await readStoreMetadata(profile, "session")).toEqual({ formatVersion: 1 });

  await removeSession(profile);
  await expect(readFile(sessionPath(profile), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("recovers a stale profile lock only after its owner is gone", async () => {
  await isolatedHome();
  const profile = "delegate";
  await mkdir(profileLockPath(profile), { recursive: true });
  await writeJsonAtomic(profileLockMetadataPath(profile), {
    pid: 999_999_999,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  });

  await upsertProfileRecord(
    profile,
    "auth-requests",
    "req-stale",
    request("req-stale"),
    (candidate) => candidate.requestId,
    { staleAfterMs: 1, retryMs: 1 },
  );

  expect((await readProfileStore<{ requestId: string; revision: number }>(profile, "auth-requests")).records)
    .toEqual([request("req-stale")]);
  await expect(readFile(profileLockMetadataPath(profile), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("times out rather than reclaiming a lock held by a live process", async () => {
  await isolatedHome();
  const profile = "delegate";
  await mkdir(profileLockPath(profile), { recursive: true });
  await writeJsonAtomic(profileLockMetadataPath(profile), {
    pid: process.pid,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  });

  await expect(upsertProfileRecord(
    profile,
    "auth-requests",
    "req-timeout",
    request("req-timeout"),
    (candidate) => candidate.requestId,
    { timeoutMs: 30, retryMs: 2, staleAfterMs: 1 },
  )).rejects.toBeInstanceOf(ProfileLockTimeoutError);
});

test("two child processes append distinct records without losing either update", async () => {
  const home = await isolatedHome();
  const fixture = new URL("../test-support/append-profile-record.ts", import.meta.url).pathname;
  const env = { ...process.env, TC_HOME: home, HOME: homedir() };
  const first = Bun.spawn([
    process.execPath,
    fixture,
    "delegate",
    "req-first",
    JSON.stringify(request("req-first")),
  ], { env, stdout: "pipe", stderr: "pipe" });
  const second = Bun.spawn([
    process.execPath,
    fixture,
    "delegate",
    "req-second",
    JSON.stringify(request("req-second")),
  ], { env, stdout: "pipe", stderr: "pipe" });
  const [firstExit, secondExit, firstError, secondError] = await Promise.all([
    first.exited,
    second.exited,
    new Response(first.stderr).text(),
    new Response(second.stderr).text(),
  ]);

  expect(firstExit, firstError).toBe(0);
  expect(secondExit, secondError).toBe(0);
  const records = (await readProfileStore<{ requestId: string; revision: number }>(
    "delegate",
    "auth-requests",
  )).records.sort((left, right) => left.requestId.localeCompare(right.requestId));
  expect(records).toEqual([request("req-first"), request("req-second")]);
});

test("uses TC_HOME as a home root and never resolves test state from the developer home", async () => {
  const home = await isolatedHome();
  await writeSession("isolated", { value: "only-in-test-home" });

  expect(tinycloudHomePath()).toBe(join(home, ".tinycloud"));
  expect(profilePath("isolated").startsWith(join(homedir(), ".tinycloud"))).toBe(false);
  expect(await readFile(sessionPath("isolated"), "utf8")).toContain("only-in-test-home");
});
