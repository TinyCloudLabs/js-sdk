// TC-3070: the window of a login's one-tap approval link. `--request-expires` reaches the link the CLI creates, the default is the
// link service's one hour, and the limits (more than 1 h needs the pinned owner, at most 12 h) hold where the link is created.
// The links API here is a loopback server; nothing reaches the real service.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { NodeWasmBindings } from "@tinycloud/node-sdk";
import { checkLinkRecord, signerFromJwk, type Ed25519PrivateJwk } from "@tinycloud/share-envelope/links";

const environmentKeys = ["HOME", "TC_HOME", "COURIER_HOME", "BUN_INSTALL_CACHE_DIR", "TC_LINKS_API_ORIGIN"] as const;
const snapshotEnvironment = () => Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
function restoreEnvironment(snapshot: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
const original = snapshotEnvironment();
const home = mkdtempSync("/var/tmp/TC3070-window-test-");
chmodSync(home, 0o700);
const fixtureEnvironment = { HOME: home, TC_HOME: join(home, "tc"), COURIER_HOME: join(home, "courier"), BUN_INSTALL_CACHE_DIR: join(home, "bun-cache") };
Object.assign(process.env, fixtureEnvironment);
// Import without touching a real profile, then restore the importing process immediately.
const { ProfileManager } = await import("../config/profiles.js");
const { profilePath } = await import("@tinycloud/operations/state");
const { readJson } = await import("../config/storage.js");
const { acquireApprovalRequest } = await import("./approval-request.js");
restoreEnvironment(original);
let caseEnvironment = original;

const wasm = new NodeWasmBindings();
const manager = wasm.createSessionManager();
const key = JSON.parse(manager.jwk("default")!) as Ed25519PrivateJwk;
const did = signerFromJwk(key).did;
const ownerDid = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";
const host = "https://node.example";
const requested = [{ service: "tinycloud.kv", space: "applications", path: "", actions: ["tinycloud.kv/list", "tinycloud.kv/get"] }];
const created: Array<{ issuedAt: string; expiresAt: string }> = [];
const LINKS_ORIGIN = "https://links.window-test.invalid";
const realFetch = globalThis.fetch;

/** The links API: records each link's header and answers 201. Any other request fails the test; nothing reaches a real service. */
const linksApi = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = input instanceof Request ? input.url : String(input);
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (url !== `${LINKS_ORIGIN}/v1/links` || method !== "POST") throw new Error(`unexpected request ${method} ${url}`);
  const checked = await checkLinkRecord(JSON.parse(String(init?.body)), Date.now());
  created.push({ issuedAt: checked.header.issuedAt, expiresAt: checked.header.expiresAt });
  const id = Array.from(randomBytes(26), (byte) => String.fromCharCode(97 + byte % 26)).join("");
  return Response.json({ id, expiresAt: checked.header.expiresAt }, { status: 201 });
}) as typeof fetch;

const PENDING = () => join(profilePath("window"), "approval-pending.json");
const entries = async () => await readJson<Array<{ requestExpiresAt: string }>>(PENDING());

beforeEach(async () => {
  caseEnvironment = snapshotEnvironment();
  Object.assign(process.env, fixtureEnvironment, { TC_LINKS_API_ORIGIN: LINKS_ORIGIN });
  globalThis.fetch = linksApi;
  created.length = 0;
  await rm(PENDING(), { force: true });
  await ProfileManager.setProfile("window", { name: "window", did, sessionDid: did, ownerDid, host, chainId: 1, spaceName: "applications", createdAt: new Date().toISOString(), authMethod: "openkey" } as never);
  await ProfileManager.setKey("window", key);
  await ProfileManager.clearSession("window");
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  try { await rm(PENDING(), { force: true }); } finally { restoreEnvironment(caseEnvironment); }
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

/** A new request under `--timeout` ends at once with the link pending, so only the creation is exercised. */
const ask = (extra: { requestExpiresMs?: number; expectedOwner?: string }) => acquireApprovalRequest(did, {
  profileName: "window", jwk: key, host, permissions: requested, expiry: "1h",
  openkeyHost: "https://openkey.example", openkeyApiHost: "https://openkey-api.window-test.invalid", noPopup: true, onApprovalRequest: () => undefined,
  approvalWait: { deadlineMs: Date.now() + 60_000, step: 1, of: 1 },
  ...extra,
});
/** The link header keeps whole seconds and truncates the expiry toward the past, so a window of N seconds lands in (N-1, N]. */
const expectWindow = (link: { issuedAt: string; expiresAt: string }, seconds: number) => {
  const lived = (Date.parse(link.expiresAt) - Date.parse(link.issuedAt)) / 1000;
  expect(lived).toBeGreaterThan(seconds - 1);
  expect(lived).toBeLessThanOrEqual(seconds);
};

describe("the window of a login's approval link", () => {
  test("with no window asked for, the link keeps the link service's one-hour default", async () => {
    await expect(ask({ expectedOwner: ownerDid })).rejects.toMatchObject({ code: "APPROVAL_PENDING" });
    expect(created).toHaveLength(1);
    expectWindow(created[0]!, 3600);
  });

  test("a window under an hour reaches the created link and the saved request, with no pinned owner", async () => {
    await expect(ask({ requestExpiresMs: 30 * 60_000 })).rejects.toMatchObject({ code: "APPROVAL_PENDING" });
    expectWindow(created[0]!, 1800);
    expect((await entries())![0]!.requestExpiresAt).toBe(created[0]!.expiresAt);
  });

  test("with the owner pinned, a window of twelve hours reaches the created link", async () => {
    await expect(ask({ requestExpiresMs: 12 * 3_600_000, expectedOwner: ownerDid })).rejects.toMatchObject({ code: "APPROVAL_PENDING" });
    expectWindow(created[0]!, 12 * 3600);
    expect((await entries())![0]!.requestExpiresAt).toBe(created[0]!.expiresAt);
  });
});

describe("the limits hold where the link is created", () => {
  test("more than an hour with no pinned owner is refused before any link is created or saved", async () => {
    await expect(ask({ requestExpiresMs: 3_600_001 })).rejects.toMatchObject({ code: "REQUEST_EXPIRES_NEEDS_OWNER" });
    expect(created).toEqual([]);
    expect(await entries()).toBeNull();
  });

  test("more than twelve hours is refused, pinned or not, before any link is created or saved", async () => {
    for (const expectedOwner of [ownerDid, undefined]) {
      await expect(ask({ requestExpiresMs: 12 * 3_600_000 + 1, expectedOwner })).rejects.toMatchObject({ code: "REQUEST_EXPIRES_TOO_LONG" });
    }
    expect(created).toEqual([]);
    expect(await entries()).toBeNull();
  });
});
