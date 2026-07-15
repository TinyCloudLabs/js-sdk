import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  signalProfileLockProtocol,
  waitForProfileLockProtocol,
} from "./test-support/profile-lock-protocol.js";

const homes: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
  }));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

test("tc auth import waits on the operations lock and preserves both shared stores", async () => {
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
  const legacyCliEntry = new URL("../../cli/src/index.ts", import.meta.url).pathname;
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
  await waitForProfileLockProtocol(readyPath, "the operations writer to hold the profile lock");

  const legacy = Bun.spawn([
    process.execPath,
    legacyCliEntry,
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
  await waitForContention(legacy, contendedPath, "tc auth import to contend on the profile lock");
  expect(legacy.exitCode).toBeNull();
  await signalProfileLockProtocol(releasePath);

  await expectChildExit(holder, "operations lock holder");
  await expectChildExit(legacy, "tc auth import");
  const records = (await readStoredRecords<typeof heldRequest>(home, profile, "auth-requests"))
    .sort((left, right) => left.requestId.localeCompare(right.requestId));
  expect(records).toEqual([heldRequest, importedRequest]);
  expect(await readStoreMetadata(home, profile, "auth-requests")).toEqual({ formatVersion: 1 });

  await verifyAdditionalDelegationContention();
});

async function verifyAdditionalDelegationContention(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "tinycloud-additional-delegation-concurrency-"));
  homes.push(home);
  const profile = "delegate";
  const heldDelegation = additionalDelegation("bafy-held");
  const appendedDelegation = additionalDelegation("bafy-appended");
  const importedArtifactPath = join(home, "imported-delegation.json");
  const protocolDir = join(home, "protocol");
  const readyPath = join(protocolDir, "holder-ready");
  const releasePath = join(protocolDir, "release-holder");
  const contendedPath = join(protocolDir, "cli-contended");
  const holderFixture = new URL("../test-support/hold-profile-store-writer.ts", import.meta.url).pathname;
  const legacyCliEntry = new URL("../../cli/src/index.ts", import.meta.url).pathname;
  const env = { ...process.env, TC_HOME: home, HOME: homedir(), NODE_ENV: "test" };
  await mkdir(protocolDir, { recursive: true });
  await writeDelegationImportProfile(home, profile);
  await writeFile(importedArtifactPath, JSON.stringify(appendedDelegation.delegation), "utf8");

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
  await waitForProfileLockProtocol(readyPath, "the operations writer to hold the profile lock");

  const writer = Bun.spawn([
    process.execPath,
    legacyCliEntry,
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

  await waitForContention(writer, contendedPath, "tc auth import to contend on the profile lock");
  expect(writer.exitCode).toBeNull();
  await signalProfileLockProtocol(releasePath);

  await expectChildExit(holder, "operations lock holder");
  await expectChildExit(writer, "tc auth import");
  const records = (await readStoredRecords<typeof heldDelegation>(home, profile, "additional-delegations"))
    .sort((left, right) => left.delegation.cid.localeCompare(right.delegation.cid));
  expect(records.map((record) => record.delegation.cid)).toEqual(["bafy-appended", "bafy-held"]);
  expect(records[0]).toEqual(expect.objectContaining({ delegation: appendedDelegation.delegation }));
  expect(records[1]).toEqual(heldDelegation);
  expect(await readStoreMetadata(home, profile, "additional-delegations")).toEqual({ formatVersion: 1 });
}

function spawn(command: string[], env: Record<string, string | undefined>) {
  return Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" });
}

async function expectChildExit(child: ReturnType<typeof Bun.spawn>, name: string): Promise<void> {
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    readChildStderr(child),
  ]);
  expect(exitCode, `${name} failed:\n${stderr}`).toBe(0);
}

async function waitForContention(
  child: ReturnType<typeof Bun.spawn>,
  signalPath: string,
  description: string,
): Promise<void> {
  const outcome = await Promise.race([
    waitForProfileLockProtocol(signalPath, description).then(() => "contended" as const),
    child.exited.then((exitCode) => ({ exitCode })),
  ]);
  if (outcome === "contended") return;

  const stderr = await readChildStderr(child);
  throw new Error(`${description} exited early (${outcome.exitCode}):\n${stderr}`);
}

async function readChildStderr(child: ReturnType<typeof Bun.spawn>): Promise<string> {
  if (!(child.stderr instanceof ReadableStream)) {
    throw new Error("Expected child stderr to be piped.");
  }
  return new Response(child.stderr).text();
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

async function writeDelegationImportProfile(home: string, profile: string): Promise<void> {
  const profileDir = join(home, ".tinycloud", "profiles", profile);
  await mkdir(profileDir, { recursive: true });
  await Promise.all([
    writeFile(join(profileDir, "profile.json"), JSON.stringify({
      name: profile,
      host: "https://node.tinycloud.test",
      chainId: 1,
      spaceName: "secrets",
      did: "did:key:session",
      sessionDid: "did:key:session",
      createdAt: "2026-07-14T12:00:00.000Z",
      posture: "delegate-session",
      operatorType: "agent",
      authMethod: "openkey",
    }), "utf8"),
    writeFile(join(profileDir, "session.json"), JSON.stringify({
      delegationHeader: { Authorization: "Bearer existing-session" },
      delegationCid: "bafy-existing-session",
      spaceId: "tinycloud:pkh:eip155:1:0xOwner:secrets",
      jwk: { d: "test-private-key" },
      verificationMethod: "did:key:session",
    }), "utf8"),
    writeFile(join(profileDir, "key.json"), JSON.stringify({ d: "test-private-key" }), "utf8"),
  ]);
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

function additionalDelegation(cid: string): {
  delegation: {
    cid: string;
    spaceId: string;
    path: string;
    actions: string[];
    delegateDID: string;
    ownerAddress: string;
    chainId: number;
    expiry: string;
    delegationHeader: { Authorization: string };
  };
  permissions: [];
} {
  return {
    delegation: {
      cid,
      spaceId: "tinycloud:pkh:eip155:1:0xOwner:secrets",
      path: "vault/secrets/KEY",
      actions: ["tinycloud.kv/get"],
      delegateDID: "did:pkh:eip155:1:0xAgent",
      ownerAddress: "0xOwner",
      chainId: 1,
      expiry: "2099-01-01T00:00:00.000Z",
      delegationHeader: { Authorization: "Bearer delegation" },
    },
    permissions: [],
  };
}
