// TC-2301: OpenKey consumes a short code on the first GET, so a `--paste` redeem that is not saved before
// the caller's slow work loses the owner's approval. These tests run the real paste flow against a local
// fake OpenKey code server that, like the real one, answers 404 to a code it has already handed out.
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, readFile, readdir, rename, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { NodeWasmBindings, PrivateKeySigner, type PermissionEntry } from "@tinycloud/node-sdk";

const originalTcHome = process.env.TC_HOME;
const originalApiHost = process.env.TC_OPENKEY_API_HOST;
const home = await mkdtemp(join(tmpdir(), "tc-pending-code-"));
process.env.TC_HOME = home;
const { ProfileManager } = await import("../config/profiles.js");
const { startAuthFlow } = await import("./browser-auth.js");
const { completeApprovalResult } = await import("./approval-request.js");
const { refreshOpenKeySession } = await import("../commands/auth.js");
const { profilePath } = await import("@tinycloud/operations/state");

const host = "https://node.example.test";
const CODE = "abcd-efgh";
const OTHER_CODE = "wxyz-2345";
const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const spaceId = wasm.makeSpaceId(address, 1, "applications");
const manager = wasm.createSessionManager();
const key = JSON.parse(manager.jwk("default")!);
const did = manager.getDID("default");
const stranger = wasm.createSessionManager();
const strangerKey = JSON.parse(stranger.jwk("default")!);
const requested: PermissionEntry[] = [{ service: "tinycloud.kv", space: "applications", path: "example/", actions: ["tinycloud.kv/get"] }];

/** A real owner-signed session for `signingKey`'s public key. */
async function proof(signingKey: Record<string, unknown> = key, lifetimeMs = 3600_000) {
  const now = Date.now();
  const prepared = wasm.prepareSession({
    abilities: { kv: { "example/": ["tinycloud.kv/get"] } },
    address, chainId: 1, domain: "cli.example.test", spaceId, jwk: signingKey,
    issuedAt: new Date(now - 60_000).toISOString(),
    expirationTime: new Date(now + lifetimeMs).toISOString(),
  });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return { ...session, jwk: { kty: signingKey.kty, crv: signingKey.crv, x: signingKey.x }, verificationMethod: manager.getDID("default"),
    address, chainId: 1, spaceId, ownerDid, siwe: prepared.siwe, signature };
}

let api: { server: Server; url: string; hits: string[]; codes: Map<string, unknown> };
async function fakeOpenKey(): Promise<typeof api> {
  const hits: string[] = [];
  const codes = new Map<string, unknown>();
  const server = createServer((req, res) => {
    hits.push(req.url!);
    const code = req.url!.split("/").pop()!;
    const delegation = codes.get(code);
    codes.delete(code);
    res.writeHead(delegation ? 200 : 404, { "Content-Type": "application/json" })
      .end(JSON.stringify(delegation ? { delegation } : { error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, hits, codes };
}

/** Run `fn` with the code piped to stdin, as `tc ... --paste` reads it. */
let stderrLines: string[] = [];
async function pasting<T>(code: string, fn: () => Promise<T>): Promise<T> {
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", { configurable: true, value: Readable.from([`${code}\n`]) });
  stderrLines = [];
  const stderr = spyOn(console, "error").mockImplementation((...args: unknown[]) => { stderrLines.push(args.join(" ")); });
  try {
    return await fn();
  } finally {
    stderr.mockRestore();
    if (stdin) Object.defineProperty(process, "stdin", stdin);
  }
}

const pendingPath = (profile = "scoped") => join(profilePath(profile), "pending-delegation-code.json");
const flow = (profileName: string | null = "scoped", jwk: object = key) =>
  startAuthFlow(did, { paste: true, profileName: profileName ?? undefined, jwk, host, openkeyHost: "https://openkey.test", permissions: requested });
const exists = (path: string) => stat(path).then(() => true, () => false);

beforeEach(async () => {
  api = await fakeOpenKey();
  process.env.TC_OPENKEY_API_HOST = api.url;
  await ProfileManager.ensureConfigDir();
  for (const name of ["scoped", "other"]) {
    await ProfileManager.setKey(name, key);
    await ProfileManager.setProfile(name, { name, host, did, sessionDid: did, chainId: 1, spaceName: "default", createdAt: new Date().toISOString() });
    await ProfileManager.clearSession(name);
    await rm(pendingPath(name), { force: true });
  }
});
afterEach(async () => {
  setSystemTime();
  await new Promise((resolve) => api.server.close(resolve));
});
afterAll(async () => {
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  if (originalApiHost === undefined) delete process.env.TC_OPENKEY_API_HOST;
  else process.env.TC_OPENKEY_API_HOST = originalApiHost;
  await rm(home, { recursive: true, force: true });
});

describe("a redeemed --paste short code is saved before the caller's work", () => {
  test("login --paste killed after the redeem finishes with the same code and one redeem", async () => {
    const delegation = await proof();
    api.codes.set(CODE, delegation);
    // The process dies once the redeem has returned: nothing was verified or committed.
    const killed = new Error("killed after the redeem");
    await expect(pasting(CODE, () => refreshOpenKeySession("scoped", host, {
      paste: true, permissions: requested, expiry: "1h",
      openKeyAcquisition: async (acquireDid, options) => { await startAuthFlow(acquireDid, options); throw killed; },
    }))).rejects.toBe(killed);
    expect(api.hits).toHaveLength(1);
    expect(await ProfileManager.getSession("scoped")).toBeNull();

    const result = await pasting(CODE, () => refreshOpenKeySession("scoped", host, { paste: true, permissions: requested, expiry: "1h" }));
    expect(api.hits).toHaveLength(1);
    const saved = await ProfileManager.getSession("scoped") as Record<string, unknown>;
    expect(saved.delegationCid).toBe(delegation.delegationCid);
    expect(saved.jwk).toMatchObject({ d: key.d });
    expect(result.profile.ownerDid).toBe(ownerDid);
    expect(await exists(pendingPath())).toBe(false);
  });

  test("the record is on disk, 0600 and public-only, by the time the flow returns", async () => {
    api.codes.set(CODE, await proof());
    await pasting(CODE, () => flow());
    const info = await stat(pendingPath());
    expect(info.mode & 0o777).toBe(0o600);
    expect((await stat(profilePath("scoped"))).mode & 0o077).toBe(0);
    const text = await readFile(pendingPath(), "utf8");
    expect(text.includes(key.d)).toBe(false);
    expect(/"(d|p|q|dp|dq|qi|oth|k)":/.test(text)).toBe(false);
    expect(await readdir(profilePath("scoped"))).not.toContain(expect.stringMatching(/\.tmp$/));
    // The same code is answered locally, bound to the same key: no second request.
    const again = await pasting(CODE.toUpperCase(), () => flow());
    expect(api.hits).toHaveLength(1);
    expect(again.delegationCid).toBeTruthy();
  });

  test("a record is cleared only when the commit reports its delegation, and only that one", async () => {
    const first = await proof();
    const second = await proof();
    api.codes.set(CODE, first);
    api.codes.set(OTHER_CODE, second);
    await pasting(CODE, () => flow());
    await pasting(OTHER_CODE, () => flow());
    // `auth grant --paste` reports the stored grant by its portable `cid`.
    await completeApprovalResult("scoped", { cid: first.delegationCid });
    const left = JSON.parse(await readFile(pendingPath(), "utf8"));
    expect(JSON.stringify(left)).not.toContain(first.delegationCid);
    expect(JSON.stringify(left)).toContain(second.delegationCid);
    await completeApprovalResult("scoped", { cid: "bafy-unrelated" });
    expect(JSON.stringify(JSON.parse(await readFile(pendingPath(), "utf8")))).toContain(second.delegationCid);
    await completeApprovalResult("scoped", { delegationCid: second.delegationCid });
    expect(await exists(pendingPath())).toBe(false);
  });

  test("another code is not satisfied by a pending record and does not disturb it", async () => {
    const first = await proof();
    const second = await proof();
    api.codes.set(CODE, first);
    api.codes.set(OTHER_CODE, second);
    await pasting(CODE, () => flow());
    expect((await pasting(OTHER_CODE, () => flow())).delegationCid).toBe(second.delegationCid);
    expect(api.hits).toHaveLength(2);
    expect((await pasting(CODE, () => flow())).delegationCid).toBe(first.delegationCid);
    expect(api.hits).toHaveLength(2);
    await expect(pasting("qqqq-qqqq", () => flow())).rejects.toMatchObject({
      status: 404, message: "Delegation code not found or expired. Use the full code shown in OpenKey instead.",
    });
  });

  test("a record for another profile is never used", async () => {
    api.codes.set(CODE, await proof());
    await pasting(CODE, () => flow("scoped"));
    await expect(pasting(CODE, () => flow("other"))).rejects.toMatchObject({ status: 404 });
    expect(api.hits).toHaveLength(2);
  });

  test("a record bound to another key is refused, nothing is returned and the record is removed", async () => {
    api.codes.set(CODE, await proof());
    await pasting(CODE, () => flow("scoped", key));
    await expect(pasting(CODE, () => flow("scoped", strangerKey))).rejects.toThrow("Delegation is bound to a different CLI key.");
    expect(api.hits).toHaveLength(1);
    expect(await exists(pendingPath())).toBe(false);
  });

  test("a record whose delegation has expired is ignored and removed", async () => {
    api.codes.set(CODE, await proof(key, 3600_000));
    await pasting(CODE, () => flow());
    expect(await exists(pendingPath())).toBe(true);
    setSystemTime(new Date(Date.now() + 2 * 3600_000));
    await expect(pasting(CODE, () => flow())).rejects.toMatchObject({ status: 404 });
    expect(api.hits).toHaveLength(2);
    expect(await exists(pendingPath())).toBe(false);
  });

  test("an unknown code with nothing pending keeps the existing error and writes nothing", async () => {
    await expect(pasting(CODE, () => flow())).rejects.toMatchObject({
      status: 404, message: "Delegation code not found or expired. Use the full code shown in OpenKey instead.",
    });
    expect(await exists(pendingPath())).toBe(false);
  });

  test("a delegation bound to another key is refused at redeem and nothing is stored", async () => {
    api.codes.set(CODE, await proof(strangerKey));
    await expect(pasting(CODE, () => flow())).rejects.toThrow("Delegation is bound to a different CLI key.");
    expect(await exists(pendingPath())).toBe(false);
  });

  test("a flow without a profile (no durable state to protect) writes no record", async () => {
    api.codes.set(CODE, await proof());
    await pasting(CODE, () => flow(null));
    expect(await exists(pendingPath())).toBe(false);
  });

  test("a delegation bound to a key this profile has not saved is not kept, and the user is told to approve again", async () => {
    // First sign-in on a profile with no key.json: the candidate key exists only in memory, so a record could never be finished.
    await ProfileManager.setProfile("keyless", { name: "keyless", host, did, sessionDid: did, chainId: 1, spaceName: "default", createdAt: new Date().toISOString() });
    const delegation = await proof();
    api.codes.set(CODE, delegation);
    expect((await pasting(CODE, () => flow("keyless"))).delegationCid).toBe(delegation.delegationCid);
    expect(await exists(pendingPath("keyless"))).toBe(false);
    expect(stderrLines.join("\n")).toMatch(/approve again/);
    // The re-run is the plain consumed-code answer, not a confusing binding error.
    await expect(pasting(CODE, () => flow("keyless"))).rejects.toMatchObject({
      status: 404, message: "Delegation code not found or expired. Use the full code shown in OpenKey instead.",
    });
    expect(api.hits).toHaveLength(2);
    // A profile that has saved its key prints no such note.
    api.codes.set(OTHER_CODE, await proof());
    await pasting(OTHER_CODE, () => flow("scoped"));
    expect(stderrLines.join("\n")).not.toMatch(/approve again/);
  });

  test("a failure to remove the record after the commit never fails the committed login", async () => {
    const delegation = await proof();
    api.codes.set(CODE, delegation);
    await pasting(CODE, () => flow());
    await chmod(profilePath("scoped"), 0o500);
    try {
      const warnings: string[] = [];
      const stderr = spyOn(console, "error").mockImplementation((...args: unknown[]) => { warnings.push(args.join(" ")); });
      try {
        await completeApprovalResult("scoped", { delegationCid: delegation.delegationCid });
      } finally {
        stderr.mockRestore();
      }
      expect(warnings.join("\n")).toMatch(/saved delegation code/);
    } finally {
      await chmod(profilePath("scoped"), 0o700);
    }
    // The record survives (it expires on its own) and is still removable once the directory is writable again.
    expect(await exists(pendingPath())).toBe(true);
    await completeApprovalResult("scoped", { delegationCid: delegation.delegationCid });
    expect(await exists(pendingPath())).toBe(false);
  });

  test("a record with a loose mode is repaired to 0600 and used, never deleted", async () => {
    const delegation = await proof();
    api.codes.set(CODE, delegation);
    await pasting(CODE, () => flow());
    await chmod(pendingPath(), 0o644);
    expect((await pasting(CODE, () => flow())).delegationCid).toBe(delegation.delegationCid);
    expect(api.hits).toHaveLength(1);
    expect((await stat(pendingPath())).mode & 0o777).toBe(0o600);
  });

  test("a record path that is not a regular file is not trusted and not deleted", async () => {
    api.codes.set(CODE, await proof());
    await pasting(CODE, () => flow());
    const real = join(profilePath("scoped"), "elsewhere.json");
    await rename(pendingPath(), real);
    await symlink(real, pendingPath());
    await expect(pasting(CODE, () => flow())).rejects.toMatchObject({ status: 404 });
    expect(api.hits).toHaveLength(2);
    expect(await exists(real)).toBe(true);
    await rm(pendingPath(), { force: true });
    await rm(real, { force: true });
  });
});
