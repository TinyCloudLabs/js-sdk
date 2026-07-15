import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  createOrReusePermissionRequest,
  findPermissionRequest,
  listPermissionRequests,
} from "./artifacts.js";
import {
  authRequestsPath,
  profilePath,
  profileStoreMetadataPath,
} from "./state.js";
import {
  signalProfileLockProtocol,
  waitForProfileLockProtocol,
} from "../test-support/profile-lock-protocol.js";

const homes: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
const originalTcHome = process.env.TC_HOME;
const originalHome = process.env.HOME;
const now = new Date("2026-07-14T12:00:00.000Z");

afterEach(async () => {
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
  }));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function isolatedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "tinycloud-operations-artifacts-"));
  homes.push(home);
  process.env.TC_HOME = home;
  process.env.HOME = homedir();
  return home;
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    profile: "delegate",
    posture: "delegate-session" as const,
    operatorType: "agent" as const,
    host: "https://node.tinycloud.test",
    sessionDid: "did:key:session",
    ...overrides,
  };
}

function capability(action = "tinycloud.kv/get") {
  return {
    service: "tinycloud.kv",
    space: "secrets",
    path: "vault/secrets/API_KEY",
    actions: [action],
  };
}

function requestInput(overrides: Record<string, unknown> = {}) {
  return {
    ...context(),
    missing: [capability()],
    granted: [],
    now: () => now,
    createRequestId: () => "req_one",
    ...overrides,
  };
}

test("reuses an unresolved exact request and explicitly replaces it when requested", async () => {
  await isolatedHome();
  const first = await createOrReusePermissionRequest(requestInput());
  const reused = await createOrReusePermissionRequest(requestInput({ createRequestId: () => "req_two" }));

  expect(first).toMatchObject({ reused: false, request: { requestId: "req_one" } });
  expect(reused).toMatchObject({ reused: true, request: { requestId: "req_one" } });

  const replacement = await createOrReusePermissionRequest(requestInput({
    replace: true,
    createRequestId: () => "req_three",
  }));
  expect(replacement).toMatchObject({ reused: false, request: { requestId: "req_three" } });
  expect((await listPermissionRequests("delegate")).map((item) => item.requestId)).toEqual(["req_three"]);
});

test("does not reuse a stale-session request and prunes it while holding the format-1 store lock", async () => {
  await isolatedHome();
  await createOrReusePermissionRequest(requestInput());
  expect(await findPermissionRequest("delegate", "req_one", {
    sessionDid: "did:key:rotated",
    host: "https://node.tinycloud.test",
  })).toBeNull();

  const rotated = await createOrReusePermissionRequest(requestInput({
    ...context({ sessionDid: "did:key:rotated" }),
    createRequestId: () => "req_rotated",
  }));

  expect(rotated).toMatchObject({ reused: false, request: { requestId: "req_rotated" } });
  expect(await findPermissionRequest("delegate", "req_one", {
    sessionDid: "did:key:rotated",
    host: "https://node.tinycloud.test",
  })).toBeNull();
  expect((await listPermissionRequests("delegate")).map((item) => item.requestId)).toEqual(["req_rotated"]);
});

test("supersedes a partially granted request with its exact remaining subset", async () => {
  await isolatedHome();
  await createOrReusePermissionRequest(requestInput({
    missing: [capability("tinycloud.kv/get"), capability("tinycloud.kv/put")],
    createRequestId: () => "req_full",
  }));

  const remaining = await createOrReusePermissionRequest(requestInput({
    missing: [capability("tinycloud.kv/put")],
    granted: [capability("tinycloud.kv/get")],
    createRequestId: () => "req_remaining",
  }));

  expect(remaining).toMatchObject({ reused: false, request: { requestId: "req_remaining" } });
  expect((await listPermissionRequests("delegate")).map((item) => item.requestId)).toEqual(["req_remaining"]);
});

test("does not persist an empty request when the required capability is already granted", async () => {
  await isolatedHome();
  const result = await createOrReusePermissionRequest(requestInput({
    granted: [capability()],
  }));

  expect(result).toEqual({ status: "satisfied", reused: false });
  expect(await listPermissionRequests("delegate")).toEqual([]);
});

test("prunes only records strictly older than 30 days and removes covered records", async () => {
  await isolatedHome();
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000);
  await createOrReusePermissionRequest(requestInput({
    now: () => new Date(cutoff.getTime() - 1),
    createRequestId: () => "req_expired_retention",
  }));
  await createOrReusePermissionRequest(requestInput({
    now: () => cutoff,
    createRequestId: () => "req_at_retention_boundary",
    missing: [capability("tinycloud.kv/put")],
  }));
  await createOrReusePermissionRequest(requestInput({
    missing: [capability("tinycloud.kv/del")],
    createRequestId: () => "req_covered",
  }));

  await createOrReusePermissionRequest(requestInput({
    missing: [capability("tinycloud.kv/list")],
    granted: [capability("tinycloud.kv/del")],
    createRequestId: () => "req_live",
  }));

  expect((await listPermissionRequests("delegate")).map((item) => item.requestId)).toEqual([
    "req_at_retention_boundary",
    "req_live",
  ]);
});

test("preserves the CLI's v1 array layout and refuses an unsupported store format", async () => {
  await isolatedHome();
  await mkdir(profilePath("delegate"), { recursive: true });
  const legacy = {
    kind: "tinycloud.auth.request",
    version: 1,
    requestId: "req_legacy",
    createdAt: now.toISOString(),
    profile: "delegate",
    posture: "delegate-session",
    operatorType: "agent",
    host: "https://node.tinycloud.test",
    sessionDid: "did:key:session",
    requested: [capability("tinycloud.kv/put")],
  };
  await writeFile(authRequestsPath("delegate"), `${JSON.stringify([legacy], null, 2)}\n`);

  await createOrReusePermissionRequest(requestInput({ createRequestId: () => "req_new" }));
  const text = await readFile(authRequestsPath("delegate"), "utf8");
  expect(text).toBe(`${JSON.stringify([
    legacy,
    {
      kind: "tinycloud.auth.request",
      version: 1,
      requestId: "req_new",
      createdAt: now.toISOString(),
      profile: "delegate",
      posture: "delegate-session",
      operatorType: "agent",
      host: "https://node.tinycloud.test",
      sessionDid: "did:key:session",
      requested: [capability()],
    },
  ], null, 2)}\n`);
  expect(await readFile(profileStoreMetadataPath("delegate", "auth-requests"), "utf8")).toBe(
    '{\n  "formatVersion": 1\n}\n',
  );

  await writeFile(profileStoreMetadataPath("delegate", "auth-requests"), '{"formatVersion":2}\n');
  await expect(createOrReusePermissionRequest(requestInput({ createRequestId: () => "req_rejected" })))
    .rejects.toThrow('Unsupported store format for "auth-requests".');
});

test("separate artifact writers contend on the existing deterministic lock hook without losing either request", async () => {
  const home = await isolatedHome();
  const profile = "delegate";
  const protocolDirectory = join(home, "protocol");
  const readyPath = join(protocolDirectory, "holder-ready");
  const releasePath = join(protocolDirectory, "release-holder");
  const contendedPath = join(protocolDirectory, "artifact-contended");
  const holder = new URL("../test-support/hold-profile-store-writer.ts", import.meta.url).pathname;
  const writer = new URL("../test-support/create-artifact-request.ts", import.meta.url).pathname;
  await mkdir(protocolDirectory, { recursive: true });

  const held = requestRecord("req_held", now);
  const env = { ...process.env, TC_HOME: home, HOME: homedir(), NODE_ENV: "test" };
  const holderChild = Bun.spawn([
    process.execPath,
    holder,
    profile,
    "auth-requests",
    held.requestId,
    JSON.stringify(held),
    readyPath,
    releasePath,
  ], { env, stdout: "pipe", stderr: "pipe" });
  children.push(holderChild);
  await waitForProfileLockProtocol(readyPath, "the store holder to acquire the profile lock");

  const writerChild = Bun.spawn([
    process.execPath,
    writer,
    profile,
    "req_writer",
    now.toISOString(),
  ], {
    env: { ...env, TC_TEST_PROFILE_LOCK_CONTENTION_SIGNAL_PATH: contendedPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(writerChild);

  await waitForProfileLockProtocol(contendedPath, "the artifact writer to contend on the profile lock");
  expect(writerChild.exitCode).toBeNull();
  await signalProfileLockProtocol(releasePath);

  const [holderExit, writerExit, holderError, writerError] = await Promise.all([
    holderChild.exited,
    writerChild.exited,
    new Response(holderChild.stderr).text(),
    new Response(writerChild.stderr).text(),
  ]);
  expect(holderExit, holderError).toBe(0);
  expect(writerExit, writerError).toBe(0);
  expect((await listPermissionRequests(profile)).map((item) => item.requestId).sort()).toEqual([
    "req_held",
    "req_writer",
  ]);
});

function requestRecord(requestId: string, createdAt: Date) {
  return {
    kind: "tinycloud.auth.request" as const,
    version: 1 as const,
    requestId,
    createdAt: createdAt.toISOString(),
    profile: "delegate",
    posture: "delegate-session" as const,
    operatorType: "agent" as const,
    host: "https://node.tinycloud.test",
    sessionDid: "did:key:session",
    requested: [capability()],
  };
}
