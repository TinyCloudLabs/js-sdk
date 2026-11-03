/**
 * A signed local OpenKey for the TC-2377 CLI adoption tests: a real wasm session key (the exact `{ crv, d, kid, kty, x }` shape
 * the CLI keeps), the links API and OpenKey's three requester calls on one local server, a virtual clock, and builders for
 * pending-approval files in the v1 (array) and v2 shapes. Nothing here reaches the network.
 *
 * Call `createApprovalFixture` once per test file (it points HOME/TC_HOME at a temp directory before the CLI modules load),
 * `fixture.enter()` in `beforeEach` and `fixture.leave()` in `afterEach`.
 */
import { chmodSync, mkdtempSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { createCipheriv, createECDH, createHash, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { join } from "node:path";
import { spyOn, type Mock } from "bun:test";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { buildShortLink, prepareLinkRecord, signerFromJwk, type ApprovalEntry, type Ed25519PrivateJwk, type LinkRecord, type OpenKeyApprovalRequestV1 } from "@tinycloud/share-envelope/links";

const environmentKeys = ["HOME", "TC_HOME", "COURIER_HOME", "BUN_INSTALL_CACHE_DIR", "TC_LINKS_API_ORIGIN"] as const;
const snapshotEnvironment = () => Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
function restoreEnvironment(snapshot: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

export type OpenKeyAction = "discover" | "fetch" | "ack";
/** A pending approval as CLI 1.6.x wrote it (`PendingApproval`): only the fields the tests read are named. */
export interface LegacyV1Entry {
  version: 1;
  requestId: string;
  relayPrivateKey: string;
  resultEnvelope?: unknown;
  [field: string]: unknown;
}
/** Return a Response to answer the call yourself; return undefined to let the signed fixture answer. */
export type OpenKeyOverride = (action: OpenKeyAction, url: URL, init?: RequestInit) => Response | undefined | Promise<Response | undefined>;

export const SYNTHETIC_ACK_ID = "synthetic-durable-ack-123456789";

export async function createApprovalFixture(label: string) {
  const original = snapshotEnvironment();
  const home = mkdtempSync(`/var/tmp/${label}-`);
  chmodSync(home, 0o700);
  const fixtureEnvironment = { HOME: home, TC_HOME: join(home, "tc"), COURIER_HOME: join(home, "courier"), BUN_INSTALL_CACHE_DIR: join(home, "bun-cache") };
  Object.assign(process.env, fixtureEnvironment);
  // Dynamic imports on purpose: the CLI modules compute their paths from HOME/TC_HOME at load, so the environment must point at the
  // temp directory first (a static import would load them against the real profile). The importing process is restored right after.
  const { ProfileManager } = await import("../../config/profiles.js");
  const { profilePath } = await import("@tinycloud/operations/state");
  const { readJson, writeJsonDurable } = await import("../../config/storage.js");
  const { relayPublicJwkOf } = await import("../device-auth.js");
  const { readProfileSnapshot, commitLogin } = await import("../login-commit.js");
  const { verifyScopedLogin } = await import("../scoped-login.js");
  const { CLIError } = await import("../../output/errors.js");
  restoreEnvironment(original);
  let caseEnvironment = original;

  const wasm = new NodeWasmBindings();
  const manager = wasm.createSessionManager();
  /** The CLI's real session key: `TCWSessionManager.jwk()` emits `{ crv, d, kid, kty, x }`. */
  const key = JSON.parse(manager.jwk("default")!) as Ed25519PrivateJwk;
  const did = signerFromJwk(key).did;
  const wallet = new PrivateKeySigner(randomBytes(32).toString("hex"));
  const address = await wallet.getAddress();
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const host = "https://node.example";
  const spaceId = wasm.makeSpaceId(address, 1, "applications");
  const requested = [{ service: "tinycloud.kv", space: "applications", path: "", actions: ["tinycloud.kv/list"] }];
  const pendingPath = () => join(profilePath("approval"), "approval-pending.json");

  // ---- the OpenKey fixture ----
  const results = new Map<string, { resultRef: string; expiresAt: string; relay: unknown }>();
  const counters = { linkPosts: 0, discover: 0, fetch: 0, ack: 0 };
  let acks: Array<{ ackId: string; resultRef: string }> = [];
  let override: OpenKeyOverride | undefined;

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/v1/links") {
      counters.linkPosts++;
      const record = await request.json() as { header: { expiresAt: string } };
      const id = Array.from(randomBytes(26), (byte) => String.fromCharCode(97 + byte % 26)).join("");
      return Response.json({ id, expiresAt: record.header.expiresAt }, { status: 201 });
    }
    const body = await request.json() as { requestId?: string; bodyCid: string; ackId?: string };
    const [header, payload, signature] = (request.headers.get("OpenKey-Session-Proof") ?? "").split(".");
    if (!header || !payload || !signature || !verify(null, Buffer.from(`${header}.${payload}`),
      createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x }, format: "jwk" }), Buffer.from(signature, "base64url"))) {
      return Response.json({ error: "Requester proof is invalid", code: "invalid_proof" }, { status: 401 });
    }
    const discover = path.match(/^\/api\/approval-requests\/([a-z]{26})\/result$/);
    if (discover) {
      counters.discover++;
      const result = results.get(discover[1]!);
      if (!result) return Response.json({ status: "pending" }, { status: 202 });
      return Response.json({ status: "approved", resultRef: result.resultRef, expiresAt: result.expiresAt });
    }
    const delivery = path.match(/^\/api\/approval-results\/([A-Za-z0-9_-]+)\/(fetch|ack)$/);
    const found = delivery ? [...results.entries()].find(([, value]) => value.resultRef === delivery[1]) : undefined;
    if (!delivery || !found) return Response.json({ error: "not found", code: "not_found" }, { status: 404 });
    const [requestId, result] = found;
    if (delivery[2] === "fetch") {
      counters.fetch++;
      return Response.json({ requestId, bodyCid: body.bodyCid, resultRef: result.resultRef, expiresAt: result.expiresAt, relay: result.relay });
    }
    counters.ack++;
    acks.push({ ackId: body.ackId!, resultRef: result.resultRef });
    return Response.json({ ackId: body.ackId, status: "acknowledged" });
  } });

  // ---- the virtual clock ----
  let clock = Date.now();
  let sleeps: number[] = [];
  let onTick: (now: number) => Promise<void> | void = () => undefined;
  /** Local clock minus the server's: what the `Date` header of every reply says relative to the virtual clock. */
  let skewMs = 0;
  const virtual = {
    now: () => clock,
    sleep: async (ms: number) => { sleeps.push(ms); clock += ms; await onTick(clock); },
  };
  let networkFault: (url: URL) => boolean = () => false;
  let openkeyCalls = 0;
  let calls: Array<{ action: OpenKeyAction; at: number; path: string }> = [];
  const send = globalThis.fetch;
  let fetchSpy: Mock<typeof fetch> | undefined;

  const httpDate = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toUTCString();
  async function route(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://api.tinycloud.xyz" && url.pathname === "/v1/links") return send(server.url.origin + url.pathname, init);
    if (url.origin !== server.url.origin) throw new Error("Only the owned fixture may receive requests");
    openkeyCalls++;
    const action: OpenKeyAction = url.pathname.endsWith("/result") ? "discover" : url.pathname.endsWith("/fetch") ? "fetch" : "ack";
    calls.push({ action, at: clock, path: url.pathname });
    if (networkFault(url)) throw new TypeError("fetch failed");
    const forced = await override?.(action, url, init);
    const response = forced ?? await send(input, init);
    const headers = new Headers(response.headers);
    headers.set("date", httpDate(clock - skewMs));
    return new Response(response.body, { status: response.status, headers });
  }
  const routed = Object.assign(route, { preconnect: send.preconnect });

  // ---- sealed results ----
  async function signedDelegation(lifetimeSeconds = 3600) {
    const prepared = wasm.prepareSession({ abilities: { kv: { "": ["tinycloud.kv/list"] } }, address, chainId: 1,
      domain: "cli.example", spaceId, jwk: key, issuedAt: new Date(Date.now() - 1000).toISOString(), expirationTime: new Date(Date.now() + lifetimeSeconds * 1000).toISOString() });
    const signature = await wallet.signMessage(prepared.siwe);
    const session = wasm.completeSessionSetup({ ...prepared, signature });
    return { ...session, jwk: { kty: key.kty, crv: key.crv, x: key.x }, verificationMethod: did,
      address, chainId: 1, spaceId, ownerDid, siwe: prepared.siwe, signature };
  }

  /** What OpenKey would hand the requester after an approval: the owner-signed result encrypted to the request's relay key. */
  async function sealResult(entry: { requestId: string; bodyCid: string; request: { resultEncryptionPublicJwk: { x: string; y: string } } }, delegation?: Record<string, unknown>) {
    const signed = delegation ?? await signedDelegation();
    const recipient = entry.request.resultEncryptionPublicJwk;
    const ephemeral = createECDH("prime256v1"); ephemeral.generateKeys();
    const shared = ephemeral.computeSecret(Buffer.concat([Buffer.from([4]), Buffer.from(recipient.x, "base64url"), Buffer.from(recipient.y, "base64url")]));
    const extracted = createHmac("sha256", Buffer.from(entry.requestId)).update(shared).digest();
    const encryptionKey = createHmac("sha256", extracted).update("openkey-device-relay-v1").update(Buffer.from([1])).digest();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
    cipher.setAAD(Buffer.from(entry.requestId));
    const delegationExpiresAt = new Date((signed.siwe as string).match(/^Expiration Time:\s*(.+)$/m)![1]!).toISOString();
    const plaintext = { resultVersion: 1, requestId: entry.requestId, requestDigest: entry.bodyCid, requesterDid: did,
      ownerDid, targetDid: did, delegationExpiresAt, delegation: signed };
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final(), cipher.getAuthTag()]);
    return { delegation: signed, opened: plaintext, relay: { version: 1, algorithm: "ECDH-P256-A256GCM", ephemeralPublicJwk: relayPublicJwkOf(ephemeral),
      nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url") } };
  }

  type StoredEntry = ApprovalEntry;
  const readState = async () => await readJson<{ version: number; entries: StoredEntry[]; unrecognized: unknown[] } | unknown[]>(pendingPath());
  /** The entries of the v2 file; throws when the file is missing or not v2. */
  async function entries(): Promise<StoredEntry[]> {
    const state = await readState();
    if (!state || Array.isArray(state) || state.version !== 2) throw new Error("approval-pending.json is not a version 2 file");
    return state.entries;
  }

  /** The owner approves the request: an encrypted, owner-signed result appears at OpenKey. */
  async function approve(entry?: StoredEntry): Promise<{ resultRef: string; delegation: Record<string, unknown> }> {
    const target = entry ?? (await entries()).at(-1);
    if (!target) throw new Error("No pending request to approve");
    const sealed = await sealResult(target);
    const resultRef = randomBytes(24).toString("base64url");
    results.set(target.requestId, { resultRef, expiresAt: new Date(clock + 600_000).toISOString(), relay: sealed.relay });
    return { resultRef, delegation: sealed.delegation };
  }

  /** OpenKey holds the owner's result for an entry that already knows its reference (phase `discovered` or later): the same reference and retention expiry. */
  async function offerResult(entry: StoredEntry, delegation?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sealed = await sealResult(entry, delegation);
    results.set(entry.requestId, { resultRef: entry.resultRef!, expiresAt: entry.resultExpiresAt!, relay: sealed.relay });
    return sealed.delegation;
  }

  // ---- request builders (no network): the pieces of a pending approval ----
  const ORIGINS = { apiOrigin: server.url.origin, linkApiOrigin: "https://api.tinycloud.xyz", openkeyOrigin: "https://openkey.example" };
  async function buildRequest(options: { requestId?: string; expiresInMs?: number; shortRelayKey?: boolean; grantLifetimeSeconds?: number } = {}) {
    const relay = createECDH("prime256v1");
    // `shortRelayKey` makes the 1-in-256 key whose leading byte is zero, deterministically.
    if (options.shortRelayKey) relay.setPrivateKey(Buffer.concat([Buffer.alloc(1), randomBytes(31)])); else relay.generateKeys();
    const legacyKey = relay.getPrivateKey();
    const requestId = options.requestId ?? Array.from(randomBytes(26), (byte) => String.fromCharCode(97 + byte % 26)).join("");
    const request = { issuer: did, requestVersion: 1 as const, targetDid: did,
      targetPublicJwk: { kty: key.kty, crv: key.crv, x: key.x }, nodeOrigin: host, permissions: requested,
      grantLifetimeSeconds: options.grantLifetimeSeconds ?? 3600, resultEncryptionPublicJwk: relayPublicJwkOf(relay) };
    const prepared = await prepareLinkRecord({ type: "openkey-approval-request", plaintext: new TextEncoder().encode(JSON.stringify(request)),
      issuerKey: signerFromJwk(key), apiOrigin: "https://api.tinycloud.xyz", expiresAt: new Date(clock + (options.expiresInMs ?? 3600_000)) });
    return {
      requestId, bodyCid: prepared.bodyCid, request, record: prepared.record,
      relayPrivateKey: Buffer.concat([Buffer.alloc(32 - legacyKey.length), legacyKey]).toString("base64url"),
      /** The key as CLI 1.6.x stored it: Node's ECDH drops a leading zero byte, so one key in 256 is 31 bytes. */
      legacyRelayPrivateKey: legacyKey.toString("base64url"),
      approvalUrl: buildShortLink({ origin: "https://openkey.example", type: "openkey-approval-request", id: requestId, key: prepared.key, bodyCid: prepared.bodyCid }),
      requestExpiresAt: prepared.record.header.expiresAt,
    };
  }
  interface Built {
    requestId: string; bodyCid: string; request: OpenKeyApprovalRequestV1; record: LinkRecord;
    relayPrivateKey: string; legacyRelayPrivateKey: string; approvalUrl: string; requestExpiresAt: string;
  }
  /** The CID of a signed delegation the fixture made. */
  const cidOf = (delegation: Record<string, unknown>): string => {
    if (typeof delegation.delegationCid !== "string") throw new Error("The delegation has no CID");
    return delegation.delegationCid;
  };

  interface EntryOptions {
    phase?: "open" | "discovered" | "fetched" | "committed";
    /** Hold the session key in the entry (a first sign-in or a rotation that staged it). */
    stagedKey?: Ed25519PrivateJwk;
    expectedOwner?: string;
    commandIntent?: string;
    resultExpiresAt?: string;
    resultRef?: string;
    delegation?: Record<string, unknown>;
  }
  const RESULT_REF = "synthetic-result-reference-123456";

  /** A version 2 entry, as the machine writes it. */
  async function v2Entry(built: Built, options: EntryOptions = {}): Promise<StoredEntry> {
    const phase = options.phase ?? "open";
    const sealed = phase === "fetched" || phase === "committed" ? await sealResult(built, options.delegation) : undefined;
    const owner = "expectedOwner" in options ? options.expectedOwner : ownerDid;
    const ext = { ...(owner === undefined ? {} : { expectedOwner: owner }),
      ...(options.commandIntent === undefined ? {} : { commandIntent: options.commandIntent }) };
    return {
      requestId: built.requestId, bodyCid: built.bodyCid, approvalUrl: built.approvalUrl, request: built.request, record: built.record,
      ...ORIGINS,
      keys: { relayPrivateKey: built.relayPrivateKey, ...(options.stagedKey && phase !== "committed" ? { stagedSigningKey: options.stagedKey } : {}) },
      phase,
      ...(phase === "open" ? {} : { resultRef: options.resultRef ?? RESULT_REF, resultExpiresAt: options.resultExpiresAt ?? new Date(clock + 600_000).toISOString() }),
      ...(sealed ? { resultEnvelope: sealed.relay } : {}),
      ackId: SYNTHETIC_ACK_ID, createdAt: built.record.header.issuedAt,
      ext: Object.keys(ext).length === 0 ? {} : { cli: ext },
    } as StoredEntry;
  }

  /**
   * A command entry after its acknowledgement, as the machine keeps it until the child grant expires: key-free (no keys, no link, no
   * sealed body), with the saved child and the opened parent the CLI keeps beside it (`ext.cli.command`) so a repeated command can
   * prove the child is bound to the approval without asking OpenKey again.
   */
  async function ackedCommandEntry(built: Built, options: { commandIntent: string; delegation?: Record<string, unknown> }): Promise<{ entry: StoredEntry; delegation: Record<string, unknown> }> {
    const sealed = await sealResult(built, options.delegation);
    const retainUntil = new Date(clock + 3600_000).toISOString();
    const { body: _sealedBody, ...record } = built.record;
    const entry = {
      requestId: built.requestId, bodyCid: built.bodyCid, request: built.request, record, ...ORIGINS,
      phase: "acked", resultRef: RESULT_REF, resultExpiresAt: new Date(clock + 600_000).toISOString(), ackId: SYNTHETIC_ACK_ID,
      retainUntil, createdAt: built.record.header.issuedAt,
      ext: { cli: { expectedOwner: ownerDid, commandIntent: options.commandIntent, command: { request: {}, result: { expiry: retainUntil }, parent: sealed.opened } } },
    } as StoredEntry;
    return { entry, delegation: sealed.delegation };
  }

  /** A version 1 entry, as CLI 1.6.x wrote it (`PendingApproval`). */
  async function v1Entry(built: Built, options: EntryOptions & { acknowledged?: boolean; command?: unknown } = {}): Promise<LegacyV1Entry> {
    const phase = options.phase ?? "open";
    const sealed = phase === "fetched" || phase === "committed" ? await sealResult(built, options.delegation) : undefined;
    const owner = "expectedOwner" in options ? options.expectedOwner : ownerDid;
    return {
      version: 1, request: built.request, requestId: built.requestId, bodyCid: built.bodyCid, approvalUrl: built.approvalUrl,
      requestExpiresAt: built.requestExpiresAt, record: built.record, ...ORIGINS,
      ...(options.stagedKey ? { signingKey: options.stagedKey } : {}),
      relayPrivateKey: built.legacyRelayPrivateKey,
      ...(owner === undefined ? {} : { expectedOwner: owner }),
      ...(phase === "open" ? {} : { resultRef: options.resultRef ?? RESULT_REF, resultExpiresAt: options.resultExpiresAt ?? new Date(clock + 600_000).toISOString() }),
      ...(sealed ? { resultEnvelope: sealed.relay } : {}),
      ackId: SYNTHETIC_ACK_ID,
      ...(phase === "committed" ? { committed: true } : {}),
      ...(options.commandIntent === undefined ? {} : { commandIntent: options.commandIntent }),
      ...(options.command === undefined ? {} : { command: options.command }),
      ...(options.acknowledged ? { acknowledged: true } : {}),
    };
  }

  const writeState = (content: unknown) => writeJsonDurable(pendingPath(), content);

  async function commitAndAcknowledge(delegation: Record<string, unknown>, complete: (profile: string, delegation?: object) => Promise<void>): Promise<void> {
    const snapshot = await readProfileSnapshot("approval");
    const verified = verifyScopedLogin(delegation, key, did, requested, { expectedOwner: ownerDid, exactApproval: true });
    await commitLogin("approval", snapshot, { key, session: verified.session, profile: { ...snapshot.profile!, spaceId }, durable: true });
    await complete("approval", delegation);
  }
  /** Only the commit (the profile saves the grant); the acknowledgement is the caller's next step. */
  async function commitOnly(delegation: Record<string, unknown>): Promise<void> {
    const snapshot = await readProfileSnapshot("approval");
    const verified = verifyScopedLogin(delegation, key, did, requested, { expectedOwner: ownerDid, exactApproval: true });
    await commitLogin("approval", snapshot, { key, session: verified.session, profile: { ...snapshot.profile!, spaceId }, durable: true });
  }

  /** `acquireApprovalRequest` options with the virtual clock; `wait` adds a `--timeout`. */
  let offered: string[] = [];
  function options(wait?: { deadlineMs: number; step?: number; of?: number }, extra: Record<string, unknown> = {}) {
    return {
      profileName: "approval", jwk: key, host, permissions: requested, expectedOwner: ownerDid, expiry: "1h",
      openkeyHost: "https://openkey.example", openkeyApiHost: server.url.origin, noPopup: true,
      onApprovalRequest: ({ approvalUrl }: { approvalUrl: string }) => { offered.push(approvalUrl); },
      approvalClock: virtual,
      ...(wait ? { approvalWait: { step: 1, of: 1, ...wait, now: virtual.now, sleep: virtual.sleep } } : {}),
      ...extra,
    };
  }
  const withDeadline = (ms: number, extra: { step?: number; of?: number } = {}) => options({ deadlineMs: clock + ms, ...extra });

  async function caught(run: () => Promise<unknown>): Promise<InstanceType<typeof CLIError>> {
    try { await run(); } catch (error) {
      if (error instanceof CLIError) return error;
      throw error;
    }
    throw new Error("The call finished without an error");
  }

  /** The pending file and everything the adapter may set aside or leave beside it (set-aside copies, a killed writer's temp file). */
  async function clearPendingFiles(): Promise<void> {
    const names = await readdir(profilePath("approval")).catch(() => []);
    for (const name of names.filter((item) => item.includes("approval-pending.json"))) await rm(join(profilePath("approval"), name), { force: true });
  }

  async function enter(): Promise<void> {
    caseEnvironment = snapshotEnvironment();
    Object.assign(process.env, fixtureEnvironment);
    results.clear(); counters.linkPosts = 0; counters.discover = 0; counters.fetch = 0; counters.ack = 0; acks = []; override = undefined;
    clock = Date.now(); sleeps = []; onTick = () => undefined; skewMs = 0; networkFault = () => false; openkeyCalls = 0; calls = []; offered = [];
    await clearPendingFiles();
    await ProfileManager.setProfile("approval", { name: "approval", did, sessionDid: did, ownerDid, host, chainId: 1, spaceName: "applications", createdAt: new Date().toISOString(), authMethod: "openkey", posture: "owner-openkey" });
    await ProfileManager.setKey("approval", key);
    await ProfileManager.clearSession("approval");
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(routed);
  }
  async function leave(): Promise<void> {
    fetchSpy?.mockRestore();
    try { await clearPendingFiles(); } finally { restoreEnvironment(caseEnvironment); }
  }
  async function dispose(): Promise<void> {
    server.stop(true);
    await rm(home, { recursive: true, force: true });
  }

  return {
    // identity
    key, did, ownerDid, host, spaceId, requested, wasm,
    // modules
    ProfileManager, profilePath, readJson, writeJsonDurable, CLIError, pendingPath, home,
    // clock and server controls
    virtual, results, counters, resultRef: RESULT_REF,
    get acks() { return acks; }, get sleeps() { return sleeps; }, get calls() { return calls; }, get offered() { return offered; },
    set override(value: OpenKeyOverride | undefined) { override = value; },
    set onTick(value: (now: number) => Promise<void> | void) { onTick = value; },
    set skewMs(value: number) { skewMs = value; },
    set networkFault(value: (url: URL) => boolean) { networkFault = value; },
    get clock() { return clock; }, set clock(value: number) { clock = value; },
    get openkeyCalls() { return openkeyCalls; },
    // builders
    buildRequest, v1Entry, v2Entry, ackedCommandEntry, writeState, readState, entries, approve, offerResult, sealResult, signedDelegation, cidOf,
    options, withDeadline, caught, commitAndAcknowledge, commitOnly,
    enter, leave, dispose,
  };
}
