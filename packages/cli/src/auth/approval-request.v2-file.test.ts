import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { NodeWasmBindings } from "@tinycloud/node-sdk";
import {
  APPROVAL_FILE,
  LEGACY_APPROVAL_FILE,
  discardApprovalFiles,
  loadApprovalFiles,
  serializeApprovalFile,
  signerFromJwk,
  type ApprovalFilesInput,
  type Ed25519PrivateJwk,
} from "@tinycloud/share-envelope/links";

// TC-2377: the v2 pending-approval file has its own name, `approval-pending.v2.json`. This CLI (the published one, until it adopts
// the requester machine) knows only `approval-pending.json`. After a newer reader has migrated its v1 file into the v2 file, this
// CLI must degrade safely: no crash, at worst a fresh approval link, and the v2 file left alone. The newer reader then merges what
// this CLI wrote. No network: every request is answered in process.

const environmentKeys = ["HOME", "TC_HOME", "COURIER_HOME", "BUN_INSTALL_CACHE_DIR"] as const;
const snapshotEnvironment = () => Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
function restoreEnvironment(snapshot: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
const original = snapshotEnvironment();
const home = mkdtempSync("/var/tmp/TC2377-v2-file-");
chmodSync(home, 0o700);
const fixtureEnvironment = { HOME: home, TC_HOME: join(home, "tc"), COURIER_HOME: join(home, "courier"), BUN_INSTALL_CACHE_DIR: join(home, "bun-cache") };
Object.assign(process.env, fixtureEnvironment);
// The profile store reads TC_HOME when it loads, so these modules are imported after the fixture environment is set.
const { ProfileManager } = await import("../config/profiles.js");
const { profilePath } = await import("@tinycloud/operations/state");
const { acquireApprovalRequest } = await import("./approval-request.js");
const { clearProfileCredentials } = await import("../lib/logout-pending.js");
restoreEnvironment(original);
let caseEnvironment = original;

const wasm = new NodeWasmBindings();
const key = JSON.parse(wasm.createSessionManager().jwk("default")!) as Ed25519PrivateJwk;
const did = signerFromJwk(key).did;
const ownerDid = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";
const host = "https://node.example";
const requested = [{ service: "tinycloud.kv", space: "applications", path: "", actions: ["tinycloud.kv/list"] }];
const PROFILE = "approval";
const v1Path = () => join(profilePath(PROFILE), LEGACY_APPROVAL_FILE);
const v2Path = () => join(profilePath(PROFILE), APPROVAL_FILE);

// ---- the links API and OpenKey, answered in process ----
const created: string[] = [];
async function answer(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === "https://api.tinycloud.xyz" && url.pathname === "/v1/links") {
    const record = JSON.parse(String(init?.body)) as { header: { expiresAt: string } };
    const id = Array.from(randomBytes(26), (byte) => String.fromCharCode(97 + byte % 26)).join("");
    created.push(id);
    return Response.json({ id, expiresAt: record.header.expiresAt }, { status: 201 });
  }
  if (url.origin === "https://openkey-api.example") return new Response(null, { status: 202 });
  throw new Error(`unexpected request: ${url.origin}`);
}
let fetchSpy: Mock<typeof fetch> | undefined;

/** One run of this CLI's sign-in: it leaves once the link is shown (the entry is saved before that). */
class LinkShown extends Error {}
async function runThisCli(): Promise<string> {
  let shown = "";
  try {
    await acquireApprovalRequest(did, {
      profileName: PROFILE, jwk: key, host, permissions: requested, expectedOwner: ownerDid, expiry: "1h",
      openkeyHost: "https://openkey.example", openkeyApiHost: "https://openkey-api.example", noPopup: true,
      onApprovalRequest: ({ requestId }: { requestId: string }) => { shown = requestId; throw new LinkShown(); },
    });
  } catch (error) {
    if (!(error instanceof LinkShown)) throw error;
  }
  return shown;
}

/** A newer reader (the requester machine's adapter): load both names, then apply the file operations in order. */
function runNewerReader(): readonly string[] {
  const read = (path: string): unknown => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  const input: ApprovalFilesInput = {
    ...(existsSync(v2Path()) ? { v2: read(v2Path()) } : {}),
    ...(existsSync(v1Path()) ? { v1: read(v1Path()) } : {}),
  };
  const loaded = loadApprovalFiles(input, { now: Date.now() });
  if (loaded.kind !== "ok") throw new Error(`load: ${loaded.kind}`);
  for (const op of loaded.ops) {
    if (op.op === "write") {
      writeFileSync(`${v2Path()}.tmp`, serializeApprovalFile(loaded.file), { mode: 0o600 });
      renameSync(`${v2Path()}.tmp`, v2Path());
    } else rmSync(join(profilePath(PROFILE), op.name), { force: true });
  }
  return loaded.file.entries.map((entry) => entry.requestId);
}
const v1Ids = (): string[] => (JSON.parse(readFileSync(v1Path(), "utf8")) as { requestId: string }[]).map((entry) => entry.requestId);

beforeEach(async () => {
  caseEnvironment = snapshotEnvironment();
  Object.assign(process.env, fixtureEnvironment);
  created.length = 0;
  rmSync(v1Path(), { force: true });
  rmSync(v2Path(), { force: true });
  await ProfileManager.setProfile(PROFILE, { name: PROFILE, did, sessionDid: did, ownerDid, host, chainId: 1, spaceName: "applications", createdAt: new Date().toISOString(), authMethod: "openkey", posture: "owner-openkey" });
  await ProfileManager.setKey(PROFILE, key);
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(answer, { preconnect: globalThis.fetch.preconnect }));
});
afterEach(() => {
  fetchSpy?.mockRestore();
  restoreEnvironment(caseEnvironment);
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("this CLI after a newer reader migrated its file to approval-pending.v2.json", () => {
  test("migration: the v1 request moves into the v2 file and approval-pending.json is gone", async () => {
    const first = await runThisCli();
    expect(v1Ids()).toEqual([first]);
    expect(runNewerReader()).toEqual([first]);
    expect(existsSync(v1Path())).toBe(false);
    expect(existsSync(v2Path())).toBe(true);
  });

  test("this CLI does not crash; it makes a fresh link, and leaves the v2 file byte for byte", async () => {
    const first = await runThisCli();
    runNewerReader();
    const v2Before = readFileSync(v2Path(), "utf8");
    const second = await runThisCli();
    expect(created).toEqual([first, second]);
    expect(second).not.toBe(first);
    expect(v1Ids()).toEqual([second]);
    expect(readFileSync(v2Path(), "utf8")).toBe(v2Before);
    // A second run resumes its own v1 request: no further link.
    expect(await runThisCli()).toBe(second);
    expect(created).toHaveLength(2);
  });

  test("the newer reader merges what this CLI wrote meanwhile, then deletes approval-pending.json", async () => {
    const first = await runThisCli();
    runNewerReader();
    const second = await runThisCli();
    expect(runNewerReader()).toEqual([first, second]);
    expect(existsSync(v1Path())).toBe(false);
  });

  test("the newer reader's logout deletes both files; this CLI's logout deletes only approval-pending.json", async () => {
    const first = await runThisCli();
    runNewerReader();
    await runThisCli();
    await clearProfileCredentials(PROFILE);
    expect(existsSync(v1Path())).toBe(false);
    // Left for the newer reader: its keys are purged by its sweep at the entry's purge time, or by its logout.
    expect(JSON.parse(readFileSync(v2Path(), "utf8")).entries.map((entry: { requestId: string }) => entry.requestId)).toEqual([first]);
    const discarded = discardApprovalFiles({ v2: JSON.parse(readFileSync(v2Path(), "utf8")) }, { now: Date.now() });
    for (const op of discarded.ops) rmSync(join(profilePath(PROFILE), op.name), { force: true });
    expect(discarded.requestIds).toEqual([first]);
    expect(existsSync(v2Path())).toBe(false);
    expect(existsSync(v1Path())).toBe(false);
  });

  test("why the name differs: v2 content under approval-pending.json makes this CLI fail on every run", async () => {
    const first = await runThisCli();
    runNewerReader();
    writeFileSync(v1Path(), readFileSync(v2Path(), "utf8"), { mode: 0o600 });
    // Node words it "items is not iterable"; Bun "Spread syntax requires ...iterable[Symbol.iterator] to be a function".
    await expect(runThisCli()).rejects.toThrow(TypeError);
    await expect(runThisCli()).rejects.toThrow(TypeError);
    expect(created).toHaveLength(3);
    expect(created[0]).toBe(first);
  });
});
