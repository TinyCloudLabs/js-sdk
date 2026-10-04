import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROFILE_LOCK_CHILD_NORMAL_EXIT_TIMEOUT_MS,
  PROFILE_LOCK_CHILD_SIGKILL_TIMEOUT_MS,
  PROFILE_LOCK_CHILD_SIGTERM_TIMEOUT_MS,
  PROFILE_LOCK_CHILD_STDERR_CLOSE_TIMEOUT_MS,
  PROFILE_LOCK_TEST_TIMEOUT_MS,
  signalProfileLockProtocol,
  waitForProfileLockProtocol,
} from "./test-support/profile-lock-protocol.js";
import { createAuthRuntimeFixture } from "../test-support/auth-runtime.js";

const homes: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
const IMPORT_SESSION_JWK = {
  kid: "default",
  kty: "OKP",
  crv: "Ed25519",
  x: "_-blweCZLIwOuj1KBbrF7bGGw81NLwRzmrvfi7N46cA",
  d: "scYXUfcu6A0rf1QDt7ne3yT-UmALHjnMEFB9GnKiJqE",
};
const IMPORT_SESSION_VERIFICATION_METHOD =
  "did:key:z6MkwgCDSaxUVbFokAd689S3EY5b3sxN3Ub22hZMdLBcDKPm#z6MkwgCDSaxUVbFokAd689S3EY5b3sxN3Ub22hZMdLBcDKPm";
const LEGACY_CLI_ENTRY = new URL("../../cli/src/index.ts", import.meta.url).pathname;

afterEach(async () => {
  await Promise.all(children.splice(0).map(terminateChild));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

test("tc auth import contends for the operations lock and preserves auth requests", async () => {
  const home = await mkdtemp(join(tmpdir(), "tinycloud-legacy-cli-concurrency-"));
  homes.push(home);
  const profile = "delegate";
  const heldRequest = request("req-held");
  const importedRequest = request("req-imported");
  const importedArtifactPath = join(home, "imported-request.json");
  const protocolDir = join(home, "protocol");
  const readyPath = join(protocolDir, "holder-ready");
  const releasePath = join(protocolDir, "release-holder");
  const contendedPath = join(protocolDir, "cli-contended");
  const holderFixture = new URL("../test-support/hold-profile-store-writer.ts", import.meta.url).pathname;
  const env = { ...process.env, TC_HOME: home, HOME: homedir(), NODE_ENV: "test" };
  await mkdir(protocolDir, { recursive: true });
  await writeFile(importedArtifactPath, JSON.stringify(importedRequest), "utf8");

  const holder = spawn([
    process.execPath,
    holderFixture,
    profile,
    "auth-requests",
    heldRequest.requestId,
    JSON.stringify(heldRequest),
    readyPath,
    releasePath,
  ], env);
  children.push(holder);
  await waitForChildSignal(holder, readyPath, "the operations writer to hold the profile lock");

  const legacy = Bun.spawn([
    process.execPath,
    LEGACY_CLI_ENTRY,
    "--profile",
    profile,
    "auth",
    "import",
    importedArtifactPath,
  ], {
    env: { ...env, TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH: contendedPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(legacy);

  // The signal is emitted only after the real CLI's lock mkdir saw the
  // holder's lock directory. This prevents a slow CLI startup from turning
  // the test back into a merely concurrent launch.
  // The production 2s acquisition limit intentionally remains unchanged:
  // the observed Linux delay was before this signal, while this test still
  // proves the real post-contention release and next lock poll fit that limit.
  await waitForChildSignal(legacy, contendedPath, "tc auth import to contend on the profile lock");
  expect(legacy.exitCode).toBeNull();
  await signalProfileLockProtocol(releasePath);

  await expectChildExit(holder, "operations lock holder");
  await expectChildExit(legacy, "tc auth import");
  const records = (await readStoredRecords<typeof heldRequest>(home, profile, "auth-requests"))
    .sort((left, right) => left.requestId.localeCompare(right.requestId));
  expect(records).toEqual([heldRequest, importedRequest]);
  expect(await readStoreMetadata(home, profile, "auth-requests")).toEqual({ formatVersion: 1 });
}, { timeout: PROFILE_LOCK_TEST_TIMEOUT_MS });

test("tc auth import contends for the operations lock and preserves additional delegations", async () => {
  const home = await mkdtemp(join(tmpdir(), "tinycloud-additional-delegation-concurrency-"));
  homes.push(home);
  const profile = "delegate";
  const fixture = await withTcHome(home, createAuthRuntimeFixture);
  try {
    await writeFile(
      join(home, ".tinycloud", "profiles", profile, "key.json"),
      JSON.stringify(fixture.hermetic.restorableSession.jwk),
      "utf8",
    );
    const heldDelegation = {
      delegation: await fixture.hermetic.mintDelegation(),
      permissions: [],
    };
    const appendedDelegation = await fixture.hermetic.mintDelegation();
    const storedHeldDelegation = JSON.parse(JSON.stringify(heldDelegation));
    const storedAppendedDelegation = JSON.parse(JSON.stringify(appendedDelegation));
    const importedArtifactPath = join(home, "imported-delegation.json");
    const protocolDir = join(home, "protocol");
    const readyPath = join(protocolDir, "holder-ready");
    const releasePath = join(protocolDir, "release-holder");
    const contendedPath = join(protocolDir, "cli-contended");
    const holderFixture = new URL("../test-support/hold-profile-store-writer.ts", import.meta.url).pathname;
    const env = { ...process.env, TC_HOME: home, HOME: homedir(), NODE_ENV: "test" };
    await mkdir(protocolDir, { recursive: true });
    await writeFile(importedArtifactPath, JSON.stringify(appendedDelegation), "utf8");

    const holder = spawn([
      process.execPath,
      holderFixture,
      profile,
      "additional-delegations",
      heldDelegation.delegation.cid,
      JSON.stringify(heldDelegation),
      readyPath,
      releasePath,
    ], env);
    children.push(holder);
    await waitForChildSignal(holder, readyPath, "the operations writer to hold the profile lock");

    const writer = Bun.spawn([
      process.execPath,
      LEGACY_CLI_ENTRY,
      "--profile",
      profile,
      "auth",
      "import",
      importedArtifactPath,
    ], {
      env: { ...env, TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH: contendedPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(writer);

    await waitForChildSignal(writer, contendedPath, "tc auth import to contend on the profile lock");
    expect(writer.exitCode).toBeNull();
    await signalProfileLockProtocol(releasePath);

    await expectChildExit(holder, "operations lock holder");
    await expectChildExit(writer, "tc auth import");
    const records = (await readStoredRecords<typeof heldDelegation>(home, profile, "additional-delegations"))
      .sort((left, right) => left.delegation.cid.localeCompare(right.delegation.cid));
    expect(records.map((record) => record.delegation.cid)).toEqual([
      appendedDelegation.cid,
      heldDelegation.delegation.cid,
    ].sort());
    expect(records).toContainEqual(expect.objectContaining({ delegation: storedAppendedDelegation }));
    // The CLI's first replay migrates the held record: kept, and now bound.
    expect(records).toContainEqual(expect.objectContaining(storedHeldDelegation));
    expect(await readStoreMetadata(home, profile, "additional-delegations")).toEqual({ formatVersion: 1 });
  } finally {
    fixture.hermetic.stop();
  }
}, { timeout: PROFILE_LOCK_TEST_TIMEOUT_MS });

test("tc profile delete waits for the profile lock and never removes a held lock", async () => {
  const home = await mkdtemp(join(tmpdir(), "tinycloud-profile-delete-concurrency-"));
  homes.push(home);
  const profile = "doomed";
  const profileDir = join(home, ".tinycloud", "profiles", profile);
  const session = { delegationCid: "bafy-held-session", spaceId: "space-held" };
  await mkdir(join(profileDir, "cache"), { recursive: true });
  await writeFile(join(profileDir, "profile.json"), JSON.stringify({ name: profile, host: "https://node.tinycloud.test" }), "utf8");
  await writeFile(join(profileDir, "key.json"), JSON.stringify(IMPORT_SESSION_JWK), "utf8");
  await writeFile(join(profileDir, "session.json"), JSON.stringify(session), "utf8");
  const protocolDir = join(home, "protocol");
  const holdersDir = join(home, "holders");
  const readyPath = join(protocolDir, "holder-ready");
  const releasePath = join(protocolDir, "release-holder");
  const contendedPath = join(protocolDir, "cli-contended");
  const env = { ...process.env, TC_HOME: home, HOME: homedir(), NODE_ENV: "test" };
  await mkdir(protocolDir, { recursive: true });
  await mkdir(holdersDir, { recursive: true });

  const holder = spawnLockHolder(profile, holdersDir, readyPath, releasePath, env);
  children.push(holder);
  await waitForChildSignal(holder, readyPath, "the lock holder to hold the profile lock");

  const deleter = Bun.spawn([process.execPath, LEGACY_CLI_ENTRY, "profile", "delete", profile], {
    env: { ...env, TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH: contendedPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(deleter);
  await waitForChildSignal(deleter, contendedPath, "tc profile delete to contend on the profile lock");
  expect(deleter.exitCode).toBeNull();
  // While the holder's critical section runs, its profile and its lock are intact.
  expect(await readJsonFile(join(profileDir, "session.json"))).toEqual(session);
  expect(await readJsonFile(join(profileDir, ".lock", "owner.json"))).toMatchObject({ pid: holder.pid });
  await signalProfileLockProtocol(releasePath);

  await expectChildExit(holder, "profile lock holder");
  await expectChildExit(deleter, "tc profile delete");
  expect(await readdir(holdersDir)).toEqual([]);
  await expect(readdir(profileDir)).rejects.toMatchObject({ code: "ENOENT" });
}, { timeout: PROFILE_LOCK_TEST_TIMEOUT_MS });

test("local tc auth rotate keeps the previous session when the profile changes before its commit", async () => {
  const home = await mkdtemp(join(tmpdir(), "tinycloud-local-rotate-concurrency-"));
  homes.push(home);
  const fixture = await withTcHome(home, createAuthRuntimeFixture);
  try {
    const profile = fixture.ownerProfile;
    const profileDir = join(home, ".tinycloud", "profiles", profile);
    const previousSession = await readJsonFile(join(profileDir, "session.json"));
    const updatedProfile = { ...await readJsonFile(join(profileDir, "profile.json")), defaultSpace: "photos" };
    const protocolDir = join(home, "protocol");
    const holdersDir = join(home, "holders");
    const readyPath = join(protocolDir, "holder-ready");
    const releasePath = join(protocolDir, "release-holder");
    const contendedPath = join(protocolDir, "cli-contended");
    const env = { ...process.env, TC_HOME: home, HOME: homedir(), NODE_ENV: "test" };
    await mkdir(protocolDir, { recursive: true });
    await mkdir(holdersDir, { recursive: true });

    const holder = spawnLockHolder(profile, holdersDir, readyPath, releasePath, env);
    children.push(holder);
    await waitForChildSignal(holder, readyPath, "the lock holder to hold the profile lock");

    // The rotation reads the profile, signs in with the local owner key, and
    // only then needs the lock for its compare-and-commit.
    const rotation = Bun.spawn([process.execPath, LEGACY_CLI_ENTRY, "--profile", profile, "auth", "rotate"], {
      env: { ...env, TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH: contendedPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(rotation);
    await waitForChildSignal(rotation, contendedPath, "tc auth rotate to contend on the profile lock");
    // The holder's critical section updates the profile, as `tc profile
    // set-default-space` would.
    await writeFile(join(profileDir, "profile.json"), JSON.stringify(updatedProfile), "utf8");
    await signalProfileLockProtocol(releasePath);
    await expectChildExit(holder, "profile lock holder");

    const [exitCode, stderr] = await Promise.all([
      waitForChildExit(rotation, "tc auth rotate"),
      readChildStderr(rotation),
    ]);
    expect(exitCode, stderr).toBe(1);
    expect(stderr).toContain("PROFILE_CHANGED_DURING_LOGIN");
    expect(await readJsonFile(join(profileDir, "profile.json"))).toEqual(updatedProfile);
    expect(await readJsonFile(join(profileDir, "session.json"))).toEqual(previousSession);
  } finally {
    fixture.hermetic.stop();
  }
}, { timeout: PROFILE_LOCK_TEST_TIMEOUT_MS });

/** A child that holds the profile lock (hold-profile-lock.ts) until `releasePath` appears. */
function spawnLockHolder(
  profile: string,
  holdersDir: string,
  readyPath: string,
  releasePath: string,
  env: Record<string, string | undefined>,
) {
  const fixture = new URL("../test-support/hold-profile-lock.ts", import.meta.url).pathname;
  return spawn([process.execPath, fixture, profile, holdersDir, readyPath, releasePath, "10000", "30000"], env);
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function withTcHome<T>(home: string, action: () => Promise<T>): Promise<T> {
  const previousTcHome = process.env.TC_HOME;
  process.env.TC_HOME = home;
  try {
    return await action();
  } finally {
    if (previousTcHome === undefined) delete process.env.TC_HOME;
    else process.env.TC_HOME = previousTcHome;
  }
}

function spawn(command: string[], env: Record<string, string | undefined>) {
  return Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" });
}

async function expectChildExit(child: ReturnType<typeof Bun.spawn>, name: string): Promise<void> {
  const [exitCode, stderr] = await Promise.all([
    waitForChildExit(child, name),
    readChildStderr(child),
  ]);
  expect(exitCode, `${name} failed:\n${stderr}`).toBe(0);
}

async function waitForChildSignal(
  child: ReturnType<typeof Bun.spawn>,
  signalPath: string,
  description: string,
): Promise<void> {
  const abortController = new AbortController();
  const outcome = await Promise.race([
    waitForProfileLockProtocol(signalPath, description, undefined, abortController.signal)
      .then(() => "signaled" as const),
    child.exited.then((exitCode) => ({ exitCode })),
  ]).finally(() => abortController.abort());
  if (outcome === "signaled") return;

  const stderr = await readChildStderr(child);
  throw new Error(`${description} exited early (${outcome.exitCode}):\n${stderr}`);
}

async function waitForChildExit(
  child: ReturnType<typeof Bun.spawn>,
  name: string,
  timeoutMs = PROFILE_LOCK_CHILD_NORMAL_EXIT_TIMEOUT_MS,
): Promise<number> {
  return await withTimeout(child.exited, `${name} did not exit`, timeoutMs);
}

async function terminateChild(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForChildExit(child, "test child cleanup after SIGTERM", PROFILE_LOCK_CHILD_SIGTERM_TIMEOUT_MS);
  } catch {
    if (child.exitCode === null) child.kill("SIGKILL");
    await waitForChildExit(child, "test child cleanup after SIGKILL", PROFILE_LOCK_CHILD_SIGKILL_TIMEOUT_MS);
  }
}

async function readChildStderr(child: ReturnType<typeof Bun.spawn>): Promise<string> {
  if (!(child.stderr instanceof ReadableStream)) {
    throw new Error("Expected child stderr to be piped.");
  }
  return await withTimeout(
    new Response(child.stderr).text(),
    "Child stderr did not close",
    PROFILE_LOCK_CHILD_STDERR_CLOSE_TIMEOUT_MS,
  );
}

async function withTimeout<T>(promise: Promise<T>, description: string, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${description} within ${timeoutMs}ms.`)),
      timeoutMs,
    );
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function readStoredRecords<T>(
  home: string,
  profile: string,
  store: "auth-requests" | "additional-delegations",
): Promise<T[]> {
  return JSON.parse(await readFile(profileStorePath(home, profile, store), "utf8")) as T[];
}

async function readStoreMetadata(
  home: string,
  profile: string,
  store: "auth-requests" | "additional-delegations",
): Promise<{ formatVersion: number }> {
  return JSON.parse(await readFile(`${profileStorePath(home, profile, store)}.metadata.json`, "utf8")) as {
    formatVersion: number;
  };
}

function profileStorePath(
  home: string,
  profile: string,
  store: "auth-requests" | "additional-delegations",
): string {
  return join(home, ".tinycloud", "profiles", profile, `${store}.json`);
}

function request(requestId: string): {
  kind: "tinycloud.auth.request";
  version: 1;
  requestId: string;
  createdAt: string;
  profile: string;
  posture: "delegate-session";
  operatorType: "agent";
  host: string;
  sessionDid: string;
  requested: [];
} {
  return {
    kind: "tinycloud.auth.request",
    version: 1,
    requestId,
    createdAt: "2026-07-14T12:00:00.000Z",
    profile: "delegate",
    posture: "delegate-session",
    operatorType: "agent",
    host: "https://node.tinycloud.test",
    sessionDid: "did:key:session",
    requested: [],
  };
}
