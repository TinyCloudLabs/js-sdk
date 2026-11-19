import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Wallet } from "ethers";
import { PrivateKeySigner, TinyCloudNode } from "@tinycloud/node-sdk";
import { parseSignedSiweCacao } from "@tinycloud/sdk-core";
import { ed25519 } from "@noble/curves/ed25519";
import { canonicalize, didKeyFromEd25519PublicKey } from "@tinycloud/share-envelope";
import {
  SHARE_PUBLISH_RESULT_VERSION,
  createNativeShare,
  historyRecordForPublishedShare,
  parseNativeShareUrl,
  prepareAddressedShare,
  publishAddressedShare,
  type PublishedShare,
} from "@tinycloud/share-sdk";
import {
  AgentShareRecordStore,
  INDEX_MAIN_KEY,
  MemoryShareIndexOutbox,
  SHARE_RECORDS_VAULT_PREFIX,
  SenderShareIndex,
  WebShareRecordStore,
  agentIdFromDid,
  agentRecordBinding,
  agentRecordKey,
  compactShareRecord,
  createTinyCloudShareIndexBackend,
  deriveAgentKeyMaterial,
  project,
  sealAgentRecord,
  verifyAgentRecordChain,
  type SenderShareRecord,
  type ShareIndexBackend,
  type ShareIndexDocument,
  type ShareIndexOp,
  type ShareIndexOutbox,
  type ShareIndexReconcileReport,
} from "@tinycloud/share-sdk/share-index";
import { z } from "zod";
import { checkServerHealth, SERVER_URL } from "./setup";

/**
 * Live tests (real local node, temp datadir, throwaway keys) of the
 * share-sdk shared share index, TC-1432 slice 2, DESIGN-C §10 tests 1-8.
 * Every case uses a fresh owner wallet, so each has its own space and
 * `_index/main`. Output carries counts, statuses and timings only; never
 * links, tokens, keys or record contents.
 *
 * Needs `TC_TEST_SERVER` (a local tinycloud-node; never production).
 */

const SHARE_ORIGIN = "https://share.c5.test";
/** The signed v3 envelope admits only an https node origin; the local node is http (see the C5 file). */
const ENVELOPE_NODE_ORIGIN = "https://node.c5.test";
const RECORDS_KV = `vault/${SHARE_RECORDS_VAULT_PREFIX}`;
const RUN = Date.now().toString(36);
const LEAK_EMAIL = `leak.check.${RUN}@example.com`;
const enc = (text: string) => new TextEncoder().encode(text);
const report: Record<string, unknown> = {};

const JsonObject = z.record(z.string(), z.unknown());
const SessionJwk = z.object({ d: z.string() }).passthrough();

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

interface Owner {
  readonly key: string;
  readonly node: TinyCloudNode;
  readonly spaceId: string;
  readonly ownerDid: string;
  readonly networkId: string;
  readonly nodeDid: string;
}

async function signedIn(key: string): Promise<TinyCloudNode> {
  const node = new TinyCloudNode({
    host: SERVER_URL,
    signer: new PrivateKeySigner(key),
    domain: "share-index-live.test",
    autoBootstrapAccount: false,
    autoDiscoverLocalNode: false,
    enablePublicSpace: false,
    autoCreateSpace: true,
  });
  await node.signIn();
  return node;
}

async function newOwner(): Promise<Owner> {
  const key = Wallet.createRandom().privateKey.slice(2);
  const node = await signedIn(key);
  const networkId = node.getDefaultEncryptionNetworkId();
  await node.ensureEncryptionNetwork(networkId);
  return { key, node, spaceId: node.session!.spaceId, ownerDid: node.did, networkId, nodeDid: (await node.activeNodeIdentity()).nodeDid };
}

/** The owner-session backend: vault in the session space, decrypt proved by the session delegation. */
function ownerBackend(owner: Owner, node: TinyCloudNode = owner.node): ShareIndexBackend {
  return createTinyCloudShareIndexBackend({
    client: node,
    spaceId: owner.spaceId,
    ownerNetworkId: owner.networkId,
    decryptProof: () => ({ proofs: [node.session!.delegationCid] }),
  });
}

function newIndex(owner: Owner, backend: ShareIndexBackend, outbox: ShareIndexOutbox, writer: string): SenderShareIndex {
  return new SenderShareIndex({ backend, outbox, ownerDid: owner.ownerDid, writer, shareOrigins: [SHARE_ORIGIN], parseSiweCacao: parseSignedSiweCacao });
}

interface Instrumented {
  readonly backend: ShareIndexBackend;
  readonly stats: { indexWrites: number; indexConflicts: number; listCalls: number; listCallsWithCursor: number; pagesWithCursor: number; unwraps: number };
  /** Awaited once before the next `_index/main` read, then cleared. */
  beforeIndexRead?: () => Promise<void>;
  /** Called with the AAD of every owner unwrap. */
  onUnwrap?: (aad: Uint8Array) => void;
}

/** Counts index writes, CAS conflicts, list pages and owner unwraps of the stock backend. */
function instrument(inner: ShareIndexBackend): Instrumented {
  const result: Instrumented = {
    stats: { indexWrites: 0, indexConflicts: 0, listCalls: 0, listCallsWithCursor: 0, pagesWithCursor: 0, unwraps: 0 },
    backend: inner,
  };
  const unwrap = inner.ownerUnwrap;
  const backend: ShareIndexBackend = {
    ...inner,
    async readVault(key) {
      const hook = key === INDEX_MAIN_KEY ? result.beforeIndexRead : undefined;
      if (hook !== undefined) {
        result.beforeIndexRead = undefined;
        await hook();
      }
      return inner.readVault(key);
    },
    async writeVault(key, value, condition) {
      const written = await inner.writeVault(key, value, condition);
      if (key === INDEX_MAIN_KEY) {
        result.stats.indexWrites++;
        if (!written.ok && written.code === "conflict") result.stats.indexConflicts++;
      }
      return written;
    },
    async listKeys(prefix, cursor) {
      result.stats.listCalls++;
      if (cursor !== undefined) result.stats.listCallsWithCursor++;
      const page = await inner.listKeys(prefix, cursor);
      if (page.status === "ok" && page.cursor !== undefined) result.stats.pagesWithCursor++;
      return page;
    },
    ...(unwrap === undefined ? {} : {
      ownerUnwrap: {
        async unwrap(envelope, aad) {
          result.stats.unwraps++;
          result.onUnwrap?.(aad);
          return unwrap.unwrap(envelope, aad);
        },
      },
    }),
  };
  return Object.assign(result, { backend });
}

/** Resolves for every party once `parties` have arrived. */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => undefined;
  const open = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    arrived++;
    if (arrived >= parties) release();
    await open;
  };
}

async function inBatches<T>(items: readonly T[], width: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let start = 0; start < items.length; start += width) await Promise.all(items.slice(start, start + width).map(run));
}

async function loadDoc(index: SenderShareIndex): Promise<ShareIndexDocument> {
  const loaded = await index.load();
  if (loaded.status !== "ok") throw new Error(`index load: ${loaded.status}`);
  return loaded.doc;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** An owner-written (web) record fixture. Its link and delivery material are inert strings that must never reach the index. */
function webRecord(owner: Owner, shareId: string, options: { readonly email?: string } = {}): SenderShareRecord {
  const now = Date.now();
  return {
    shareId,
    target: { origin: SERVER_URL, nodeAudience: owner.nodeDid, spaceId: owner.spaceId },
    resource: { kind: "exact", path: `xyz.tinycloud.share/shares/${shareId}/note.txt` },
    actions: ["tinycloud.kv/get"],
    recipientMatcher: options.email === undefined ? { kind: "bearer" } : { kind: "exactEmail", value: options.email },
    targetKind: options.email === undefined ? "bearer" : "email",
    registeredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(),
    enforcementDelegationCid: `bafkfixture${shareId.toLowerCase().replace(/[^a-z0-9]/g, "")}`,
    link: `${SHARE_ORIGIN}/viewer#tc1=fixture-not-a-token-${shareId}`,
    filename: `${shareId}.txt`,
    ...(options.email === undefined ? {} : { deliveryMaterial: { envelope: { fixture: true }, shareCid: "bafkfixture", sealedEnvelope: "fixture-sealed", envelopeKey: "fixture-key" } }),
  };
}

function upsertOp(record: SenderShareRecord): ShareIndexOp {
  return { id: `upsert-${record.shareId}`, type: "upsert", key: record.shareId, row: project(record, { key: record.shareId, src: "web" }) };
}

interface AgentIdentity {
  readonly node: TinyCloudNode;
  readonly agentDid: string;
  readonly agentId: string;
  readonly store: AgentShareRecordStore;
}

/** KEK_a from the session key: the JWK `d` is read here and never leaves this function. */
async function agentKeyFor(node: TinyCloudNode, agentDid: string) {
  const jwk = SessionJwk.parse(node.session!.jwk);
  return deriveAgentKeyMaterial(new Uint8Array(Buffer.from(jwk.d, "base64url")), agentDid);
}

/** An agent session modelled like the CLI: a sign-in of the owner wallet, writing with its own session. */
async function ownerWalletAgent(owner: Owner): Promise<AgentIdentity> {
  const node = await signedIn(owner.key);
  const agentDid = node.credentialHolderDid;
  const backend = createTinyCloudShareIndexBackend({ client: node, spaceId: owner.spaceId, ownerNetworkId: owner.networkId });
  return { node, agentDid, agentId: agentIdFromDid(agentDid), store: new AgentShareRecordStore({ backend, agentDid, agentKey: await agentKeyFor(node, agentDid) }) };
}

interface PublishedLink {
  readonly url: string;
  readonly cid: string;
  readonly authorization: string;
  readonly path: string;
}

/** The CLI bearer branch: write the source, then mint a native link with the issuing session. */
async function publishLink(issuer: TinyCloudNode, owner: Owner, label: string): Promise<PublishedLink> {
  const path = `xyz.tinycloud.share/shares/${crypto.randomUUID().replaceAll("-", "")}/${label}.txt`;
  const written = await issuer.kvForSpace(owner.spaceId).put(path, enc(`share-index live ${label}`), { contentType: "text/plain" });
  if (!written.ok) throw new Error(`source put: ${written.error.code}`);
  const native = await createNativeShare(issuer.sharing, { path, expiresAt: new Date(Math.floor((Date.now() + 3_600_000) / 1000) * 1000), viewerOrigin: SHARE_ORIGIN });
  const decoded = issuer.sharing.decodeLink(parseNativeShareUrl(native.url));
  return { url: native.url, cid: native.delegationCid, authorization: (decoded.delegation.authHeader ?? "").replace(/^Bearer\s+/i, ""), path };
}

/** The agent record of a native bearer share with its link, the link UCAN and the issuing session's CACAO. */
function bearerAgentRecord(owner: Owner, link: PublishedLink, session: TinyCloudNode): SenderShareRecord {
  const now = Date.now();
  return {
    shareId: link.cid,
    target: { origin: SERVER_URL, nodeAudience: owner.nodeDid, spaceId: owner.spaceId },
    resource: { kind: "exact", path: link.path },
    actions: ["tinycloud.kv/get"],
    recipientMatcher: { kind: "bearer" },
    targetKind: "bearer",
    registeredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    enforcementDelegationCid: link.cid,
    link: link.url,
    filename: link.path.slice(link.path.lastIndexOf("/") + 1),
    proofs: { session: session.session!.delegationHeader.Authorization.replace(/^Bearer\s+/i, ""), link: link.authorization },
  };
}

/**
 * The same share as the CLI records it: its bearer publish result (shape of
 * `adapters.ts` targetAdapter) through `historyRecordForPublishedShare`, plus
 * the proofs. Its target keeps `kind`.
 */
function historyBearerRecord(owner: Owner, link: PublishedLink, session: TinyCloudNode): SenderShareRecord {
  const filename = link.path.slice(link.path.lastIndexOf("/") + 1);
  const published: PublishedShare = {
    protocol: "tinycloud-share",
    version: SHARE_PUBLISH_RESULT_VERSION,
    url: link.url,
    link: { kind: "native", cid: link.cid },
    metadata: {
      protocol: "tinycloud-share",
      version: 1,
      shareId: link.cid,
      origin: SHARE_ORIGIN,
      target: { kind: "bearer", origin: SERVER_URL, nodeAudience: owner.nodeDid, spaceId: owner.spaceId },
      resource: { kind: "exact", path: link.path },
      actions: ["read"],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      display: { filename },
      recipientMatcher: { kind: "bearer" },
      enforcementDelegationCid: link.cid,
    },
  };
  return { ...historyRecordForPublishedShare(published), proofs: { session: session.session!.delegationHeader.Authorization.replace(/^Bearer\s+/i, ""), link: link.authorization } };
}

/**
 * The CLI addressed branch (`adapters.ts`) for a recipient-DID target: the
 * source is encrypted to the owner network and stored in the issuing
 * session's `default` space, then published with that session's authority.
 * Returns the sender record `historyRecordForPublishedShare` makes, with the
 * session CACAO as its proof.
 */
async function publishAgentV3(issuer: TinyCloudNode, recipientDid: string): Promise<SenderShareRecord> {
  const activeNode = await issuer.activeNodeIdentity();
  const spaceId = issuer.session!.spaceId;
  const shareId = crypto.randomUUID().replaceAll("-", "");
  const filename = "doc.txt";
  const resourcePath = `shares/${shareId}/${filename}`;
  const policyActions: ("tinycloud.kv/get" | "tinycloud.kv/metadata")[] = ["tinycloud.kv/get", "tinycloud.kv/metadata"];
  const prepared = prepareAddressedShare({ target: { kind: "recipientDid", did: recipientDid }, actions: ["read"], policyActions, filename });
  const plaintext = enc(`share-index live v3 ${shareId}`);
  const encrypted = await issuer.encryption.encryptToNetwork(issuer.getEncryptionNetworkIdForSpace(spaceId), plaintext, { metadata: { contentType: "text/plain" } });
  if (!encrypted.ok) throw new Error(`encryptToNetwork: ${encrypted.error.code}`);
  const storedBytes = enc(canonicalize(encrypted.data));
  const stored = await issuer.kvForSpace(spaceId).put(resourcePath, storedBytes, { contentType: "application/vnd.tinycloud.encrypted-envelope+json" });
  if (!stored.ok) throw new Error(`addressed source put: ${stored.error.code}`);
  const published = await publishAddressedShare({
    shareId,
    shareOrigin: SHARE_ORIGIN,
    nodeOrigin: ENVELOPE_NODE_ORIGIN,
    nodeAudience: activeNode.nodeDid,
    enforcerDid: activeNode.nodeDid,
    spaceId,
    target: prepared.target,
    resource: { kind: "exact", path: resourcePath },
    actions: ["read"],
    policyActions,
    contentSource: {
      shareId,
      kvResource: `${spaceId}/kv/${resourcePath}`,
      selector: "exact",
      encryptionNetwork: encrypted.data.networkId,
      encryptedSymmetricKeyDigestHex: encrypted.data.encryptedSymmetricKeyHash,
      keyVersion: encrypted.data.keyVersion,
      mode: "immutable",
      initialCiphertextDigestHex: createHash("sha256").update(storedBytes).digest("hex"),
    },
    filename,
    mediaType: "text/plain",
    byteLength: plaintext.byteLength,
    expiresAt: new Date(Math.floor((Date.now() + 3_600_000) / 1000) * 1000),
    authority: {
      ownerDid: issuer.credentialHolderDid,
      createOwnerRoot: (request) => issuer.createUnifiedOwnerRoot(request),
      sign: (bytes) => issuer.signSessionBytes(bytes),
      registerPolicy: (request) => issuer.registerPolicy(request),
    },
  });
  return { ...historyRecordForPublishedShare(published), proofs: { session: issuer.session!.delegationHeader.Authorization.replace(/^Bearer\s+/i, "") } };
}

// ---------------------------------------------------------------------------

const leakChecked: { label: string; index: SenderShareIndex }[] = [];

describe("share index on a live node (DESIGN-C §10)", () => {
  test("setup: node reachable", async () => {
    await checkServerHealth();
  }, 30_000);

  test("a: two concurrent owner writers converge to the union; conflicts are retried; a no-op flush writes nothing", async () => {
    const owner = await newOwner();
    const second = await signedIn(owner.key);
    const one = instrument(ownerBackend(owner));
    const two = instrument(ownerBackend(owner, second));
    const writers = [
      { name: "web:a1", backend: one, index: newIndex(owner, one.backend, new MemoryShareIndexOutbox(), "web:a1") },
      { name: "web:a2", backend: two, index: newIndex(owner, two.backend, new MemoryShareIndexOutbox(), "web:a2") },
    ];
    const expected = new Set<string>();
    const rounds: unknown[] = [];
    for (const round of [0, 1]) {
      for (const writer of writers) {
        for (let i = 0; i < 20; i++) {
          const shareId = `a${round}${writer.name.slice(-1)}x${i}r${RUN}`;
          expected.add(shareId);
          await writer.index.enqueue(upsertOp(webRecord(owner, shareId, i % 5 === 0 ? { email: LEAK_EMAIL } : {})));
        }
      }
      // Both writers read the same etag before either writes, so one CAS must lose and retry.
      const gate = barrier(2);
      for (const writer of writers) writer.backend.beforeIndexRead = gate;
      const started = performance.now();
      const results = await Promise.all(writers.map((writer) => writer.index.flush()));
      rounds.push({ statuses: results.map((result) => result.status), refused: results.map((result) => result.refused.length), ms: Math.round(performance.now() - started) });
      expect(results.map((result) => result.status)).toEqual(["written", "written"]);
    }
    const doc = await loadDoc(writers[0]!.index);
    const keys = Object.keys(doc.rows);
    const conflicts = one.stats.indexConflicts + two.stats.indexConflicts;
    const writesBefore = one.stats.indexWrites + two.stats.indexWrites;
    const emptyFlush = await Promise.all(writers.map((writer) => writer.index.flush()));
    // An op whose row is already present is applied without a write.
    await writers[0]!.index.enqueue(upsertOp(webRecord(owner, [...expected][0]!)));
    const replay = await writers[0]!.index.flush();
    const writesAfter = one.stats.indexWrites + two.stats.indexWrites;
    report.a = { rounds, rows: keys.length, expected: expected.size, conflicts, indexWrites: writesBefore, emptyFlush: emptyFlush.map((result) => result.status), replay: replay.status, writesDuringNoOps: writesAfter - writesBefore };
    expect(keys.length).toBe(expected.size);
    expect(new Set(keys)).toEqual(expected);
    expect(conflicts).toBeGreaterThanOrEqual(2);
    expect(emptyFlush.map((result) => result.status)).toEqual(["empty", "empty"]);
    expect(replay.status).toBe("unchanged");
    expect(writesAfter - writesBefore).toBe(0);
    leakChecked.push({ label: "a", index: writers[0]!.index });
  }, 180_000);

  test("b: 1,500 web records reconcile into one index; the stock backend pages past 1,000 keys within the per-pass budget", async () => {
    const owner = await newOwner();
    const stock = instrument(ownerBackend(owner));
    const store = new WebShareRecordStore(stock.backend);
    const ids = Array.from({ length: 1500 }, (_, i) => `b${String(i).padStart(4, "0")}r${RUN}`);
    let started = performance.now();
    await inBatches(ids, 16, async (shareId) => store.put(webRecord(owner, shareId, Number(shareId.slice(1, 5)) % 50 === 0 ? { email: LEAK_EMAIL } : {})));
    const writeMs = Math.round(performance.now() - started);
    const index = newIndex(owner, stock.backend, new MemoryShareIndexOutbox(), "web:b");
    const passes: ShareIndexReconcileReport[] = [];
    started = performance.now();
    let rows = 0;
    for (let pass = 0; pass < 30; pass++) {
      const result = await index.reconcile();
      passes.push(result);
      const loaded = await index.load();
      rows = loaded.status === "ok" ? Object.keys(loaded.doc.rows).length : rows;
      if (result.cycleComplete && rows === ids.length) break;
    }
    const reconcileMs = Math.round(performance.now() - started);
    started = performance.now();
    const doc = await loadDoc(index);
    const loadMs = Math.round(performance.now() - started);
    const raw = await stock.backend.readRaw(INDEX_MAIN_KEY);
    const rowsBytes = enc(JSON.stringify(doc.rows)).length;
    report.b = {
      records: ids.length,
      writeMs,
      listCalls: stock.stats.listCalls,
      passes: passes.length,
      perPass: passes.map((pass) => `${pass.pages}p/${pass.fetches}f/${pass.admitted}a`).join(" "),
      listCallsWithCursor: stock.stats.listCallsWithCursor,
      pagesReturningCursor: stock.stats.pagesWithCursor,
      reconcileMs,
      rows: Object.keys(doc.rows).length,
      bytesPerRow: Math.round(rowsBytes / Object.keys(doc.rows).length),
      mainDocJsonBytes: enc(JSON.stringify(doc)).length,
      mainDocStoredBytes: raw.status === "ok" ? raw.bytes.byteLength : raw.status,
      loadMs,
    };
    expect(Object.keys(doc.rows).length).toBe(ids.length);
    expect(stock.stats.listCallsWithCursor).toBeGreaterThan(0);
    expect(passes.some((pass) => pass.pages > 1)).toBe(true);
    for (const pass of passes) {
      expect(pass.pages).toBeLessThanOrEqual(10);
      expect(pass.fetches).toBeLessThanOrEqual(200);
    }
    leakChecked.push({ label: "b", index });
  }, 900_000);

  describe("c: crash points (abandoned writer, same outbox)", () => {
    test("upsert: after enqueue / after record write / after CAS before outbox clear / after record write before enqueue", async () => {
      const owner = await newOwner();
      const backend = ownerBackend(owner);
      const store = new WebShareRecordStore(backend);
      const outbox = new MemoryShareIndexOutbox();
      const record = (point: string) => webRecord(owner, `cu${point}r${RUN}`, point === "3" ? { email: LEAK_EMAIL } : {});
      const crashed = (writer: string, box: ShareIndexOutbox = outbox) => newIndex(owner, backend, box, writer);
      // 1. after enqueue (record not yet written)
      const r1 = record("1");
      await crashed("web:c-crash").enqueue(upsertOp(r1));
      // 2. after record write
      const r2 = record("2");
      await crashed("web:c-crash").enqueue(upsertOp(r2));
      await store.put(r2);
      // 3. after the CAS write, before the outbox is cleared
      const r3 = record("3");
      let failRemove = true;
      const failing: ShareIndexOutbox = {
        list: () => outbox.list(),
        put: (op) => outbox.put(op),
        async remove(ids) {
          if (failRemove) { failRemove = false; throw new Error("crash before outbox clear"); }
          return outbox.remove(ids);
        },
      };
      const writer3 = crashed("web:c-crash", failing);
      await writer3.enqueue(upsertOp(r3));
      await store.put(r3);
      const crashFlush = await writer3.flush().then(() => "resolved", (error: unknown) => (error instanceof Error ? error.message : "rejected"));
      // 4. record written, op never enqueued
      const r4 = record("4");
      await store.put(r4);

      const fresh = crashed("web:c-fresh");
      const pending = (await outbox.list()).length;
      const flushed = await fresh.flush();
      const reconciled = await fresh.reconcile();
      const doc = await loadDoc(fresh);
      const rows = [r1, r2, r3, r4].map((item) => doc.rows[item.shareId]);
      report.cUpsert = {
        crashFlush,
        pendingOpsAtRestart: pending,
        freshFlush: flushed.status,
        reconcile: reconciled,
        rowsPresent: rows.map((row) => row !== undefined),
        rowsMatchProjection: [r1, r2, r3, r4].map((item) => JSON.stringify(doc.rows[item.shareId]) === JSON.stringify(project(item, { key: item.shareId, src: "web" }))),
        outboxAfter: (await outbox.list()).length,
        totalRows: Object.keys(doc.rows).length,
      };
      expect(crashFlush).toBe("crash before outbox clear");
      expect(pending).toBe(3);
      expect(Object.keys(doc.rows).length).toBe(4);
      for (const item of [r1, r2, r3, r4]) expect(doc.rows[item.shareId]).toEqual(project(item, { key: item.shareId, src: "web" }));
      expect((await outbox.list()).length).toBe(0);
      leakChecked.push({ label: "c-upsert", index: fresh });
    }, 180_000);

    test("revoke: points 1-3 converge through the outbox; point 4 (record revoked, no op queued) is not repaired by reconcile, only by status sync", async () => {
      const owner = await newOwner();
      const backend = ownerBackend(owner);
      const store = new WebShareRecordStore(backend);
      const outbox = new MemoryShareIndexOutbox();
      const records = ["1", "2", "3", "4"].map((point) => webRecord(owner, `cv${point}r${RUN}`));
      const setup = newIndex(owner, backend, outbox, "web:c-setup");
      for (const item of records) {
        await store.put(item);
        await setup.enqueue(upsertOp(item));
      }
      expect((await setup.flush()).status).toBe("written");
      const revokeAt = (offsetSeconds: number) => new Date(Math.floor(Date.now() / 1000) * 1000 - offsetSeconds * 1000).toISOString();
      const revokeOp = (shareId: string, at: string): ShareIndexOp => ({ id: `revoke-${shareId}`, type: "revoke", key: shareId, at, confirmed: false });
      const ats = [revokeAt(40), revokeAt(30), revokeAt(20), revokeAt(10)];
      // 1. after enqueue
      await newIndex(owner, backend, outbox, "web:c-crash").enqueue(revokeOp(records[0]!.shareId, ats[0]!));
      // 2. after the record write
      await newIndex(owner, backend, outbox, "web:c-crash").enqueue(revokeOp(records[1]!.shareId, ats[1]!));
      await store.update(records[1]!.shareId, (current) => ({ ...current, revokedAt: ats[1]! }));
      // 3. after the CAS write, before the outbox is cleared
      let failRemove = true;
      const failing: ShareIndexOutbox = {
        list: () => outbox.list(),
        put: (op) => outbox.put(op),
        async remove(ids) {
          if (failRemove) { failRemove = false; throw new Error("crash before outbox clear"); }
          return outbox.remove(ids);
        },
      };
      const writer3 = newIndex(owner, backend, failing, "web:c-crash");
      await writer3.enqueue(revokeOp(records[2]!.shareId, ats[2]!));
      await store.update(records[2]!.shareId, (current) => ({ ...current, revokedAt: ats[2]! }));
      const crashFlush = await writer3.flush().then(() => "resolved", (error: unknown) => (error instanceof Error ? error.message : "rejected"));
      // 4. record revoked, op never enqueued
      await store.update(records[3]!.shareId, (current) => ({ ...current, revokedAt: ats[3]! }));

      const fresh = newIndex(owner, backend, outbox, "web:c-fresh");
      const flushed = await fresh.flush();
      const reconciled = await fresh.reconcile();
      const doc = await loadDoc(fresh);
      const revocations = records.map((item) => doc.rows[item.shareId]?.r?.at ?? null);
      report.cRevoke = {
        crashFlush,
        freshFlush: flushed.status,
        reconcile: reconciled,
        revokedAtMatches: revocations.map((at, index) => at === ats[index]),
        point4RowRevoked: revocations[3] !== null,
        totalRows: Object.keys(doc.rows).length,
        outboxAfter: (await outbox.list()).length,
      };
      expect(crashFlush).toBe("crash before outbox clear");
      expect(Object.keys(doc.rows).length).toBe(4);
      expect(revocations.slice(0, 3)).toEqual(ats.slice(0, 3));
      // Reconcile skips keys the index already knows, so a revocation written
      // to the record without an outbox op does not reach the row...
      expect(revocations[3]).toBeNull();
      expect((await outbox.list()).length).toBe(0);
      // ...status sync is the repair path: a port answering "revoked" confirms it.
      const synced = await fresh.syncStatus({ status: async (key) => (key === records[3]!.shareId ? "revoked" : "unknown") });
      const repaired = (await loadDoc(fresh)).rows[records[3]!.shareId];
      report.cRevoke = { ...(report.cRevoke as object), statusSync: synced, point4AfterSync: repaired?.r ?? null };
      expect(synced.status).toBe("written");
      expect(repaired?.r?.confirmed).toBe(true);
      leakChecked.push({ label: "c-revoke", index: fresh });
    }, 180_000);
  });

  test("d: Tier W agent grant is confined to its own prefix; its record is admitted (7a) and read back without decrypt (7b)", async () => {
    const owner = await newOwner();
    const ownerIndex = newIndex(owner, ownerBackend(owner), new MemoryShareIndexOutbox(), "web:d");
    const web = webRecord(owner, `dweb${RUN}`);
    await new WebShareRecordStore(ownerBackend(owner)).put(web);
    await ownerIndex.enqueue(upsertOp(web));
    await ownerIndex.flush();
    // The Tier W agent: its own wallet and session key, holding only the owner's prefix grant (probe-v2 pattern).
    const tier = await signedIn(Wallet.createRandom().privateKey.slice(2));
    const agentDid = tier.credentialHolderDid;
    const agentId = agentIdFromDid(agentDid);
    const otherId = agentIdFromDid(`did:key:z6Mkother${RUN}`);
    const siblingId = `${agentId.slice(0, 21)}${agentId.endsWith("X") ? "Y" : "X"}`;
    const own = `${RECORDS_KV}agents/${agentId}/`;
    await owner.node.kv.put(`${RECORDS_KV}agents/${otherId}/x`, { owner: true });
    // Not `disableSubDelegation: true`: that makes the grant terminal (TC-1436, #578), and wallet-mode `useDelegation`
    // to a did:pkh recipient must sub-delegate to its session key, which the node refuses on a terminal grant (401
    // `terminal-parent-cannot-redelegate`; #578's documented edge, not a product issue). Slice 4: the CLI activates its
    // agent grant through runtime permissions (as test h does) or a grant to its session-key DID, never wallet-mode
    // `useDelegation` on a terminal grant.
    const grant = await owner.node.createDelegation({ path: own, actions: ["tinycloud.kv/put", "tinycloud.kv/get", "tinycloud.kv/list"], delegateDID: tier.did, includePublicSpace: false });
    const access = await tier.useDelegation(grant);
    const body = { forged: true };
    const code = (result: { ok: boolean; error?: { code: string } }) => (result.ok ? "OK" : result.error?.code ?? "error");
    const refusedProbes = {
      getIndex: code(await access.kv.get(`${RECORDS_KV}${INDEX_MAIN_KEY}`, { prefix: "", raw: true })),
      putIndex: code(await access.kv.put(`${RECORDS_KV}${INDEX_MAIN_KEY}`, body, { prefix: "" })),
      getWebRecord: code(await access.kv.get(`${RECORDS_KV}${web.shareId}`, { prefix: "", raw: true })),
      putWebRecord: code(await access.kv.put(`${RECORDS_KV}${web.shareId}`, body, { prefix: "" })),
      getOtherAgent: code(await access.kv.get(`${RECORDS_KV}agents/${otherId}/x`, { prefix: "", raw: true })),
      putOtherAgent: code(await access.kv.put(`${RECORDS_KV}agents/${otherId}/x`, body, { prefix: "" })),
      putSiblingPrefix: code(await access.kv.put(`${RECORDS_KV}agents/${siblingId}/x`, body, { prefix: "" })),
      putDotDotIndex: code(await access.kv.put("../../_index/main", body)),
      putDotDotOtherAgent: code(await access.kv.put(`../${otherId}/x`, body)),
      prefixOverrideIndex: code(await access.kv.put(INDEX_MAIN_KEY, body, { prefix: RECORDS_KV })),
      prefixOverrideAgentsParent: code(await access.kv.put(`${otherId}/x`, body, { prefix: `${RECORDS_KV}agents/` })),
      listRecordsRoot: code(await access.kv.list({ prefix: RECORDS_KV })),
      listOwnPrefixWithoutSlash: code(await access.kv.list({ prefix: own.slice(0, -1) })),
      listDefault: code(await access.kv.list({})),
    };
    const ownPut = code(await access.kv.put(`${own}own-1`, { mine: 1 }, { prefix: "" }));
    const ownGet = code(await access.kv.get(`${own}own-1`, { prefix: "", raw: true }));
    const ownListed = await access.kv.list({ prefix: own, removePrefix: true });
    // A network decrypt of an owner-network envelope.
    const sealed = await owner.node.encryption.encryptToNetwork(owner.networkId, enc("owner-only"));
    if (!sealed.ok) throw new Error(`encrypt: ${sealed.error.code}`);
    const decryptNoProof = await tier.encryption.decryptEnvelope(sealed.data, { proofs: [] });
    const decryptGrantProof = await tier.encryption.decryptEnvelope(sealed.data, { proofs: [grant.cid] });

    // 7a: the Tier W client writes its record through AgentShareRecordStore.
    const issuer = await signedIn(owner.key); // the owner-wallet CLI session that minted the link
    const link = await publishLink(issuer, owner, "tierw");
    const tierBackend = createTinyCloudShareIndexBackend({ client: { vault: tier.vault, kv: access.kv, encryption: tier.encryption }, spaceId: owner.spaceId, ownerNetworkId: owner.networkId });
    const tierStore = new AgentShareRecordStore({ backend: tierBackend, agentDid, agentKey: await agentKeyFor(tier, agentDid) });
    const record = bearerAgentRecord(owner, link, issuer);
    const putOutcome = await tierStore.put(record).then(() => "OK", (error: unknown) => (error instanceof Error ? error.message : "rejected"));
    const pass = await ownerIndex.reconcile();
    const doc = await loadDoc(ownerIndex);
    const row = doc.rows[agentRecordKey(agentId, record.shareId)];
    // 7b: read back through wrapAgent, no owner-network decrypt.
    const readBack = await tierStore.get(record.shareId).catch((error: unknown) => (error instanceof Error ? error.message : "rejected"));
    const listedBack = await tierStore.list().then((items) => items.length, (error: unknown) => (error instanceof Error ? error.message : "rejected"));
    report.d = {
      refusedProbes,
      ownPut,
      ownGet,
      ownListWithSlash: ownListed.ok ? ownListed.data.keys.length : ownListed.error.code,
      decryptNoProof: decryptNoProof.ok ? "DECRYPTED" : decryptNoProof.error.code,
      decryptWithGrantProof: decryptGrantProof.ok ? "DECRYPTED" : decryptGrantProof.error.code,
      tierWRecordPut: putOutcome,
      reconcile: pass,
      admitted: row !== undefined,
      rowSrcIsAgent: row?.src === `agent:${agentId}`,
      rowProofState: row?.ps ?? null,
      readBackMatches: typeof readBack === "object" && readBack !== undefined && JSON.stringify(readBack) === JSON.stringify(record),
      listedBack,
    };
    for (const [probe, result] of Object.entries(refusedProbes)) expect([probe, result]).toEqual([probe, "AUTH_UNAUTHORIZED"]);
    expect([ownPut, ownGet]).toEqual(["OK", "OK"]);
    expect(ownListed.ok).toBe(true);
    expect(decryptNoProof.ok).toBe(false);
    expect(decryptGrantProof.ok).toBe(false);
    expect(putOutcome).toBe("OK");
    expect(row?.src).toBe(`agent:${agentId}`);
    expect(JSON.stringify(readBack)).toBe(JSON.stringify(record));
  }, 180_000);

  test("f0: a CLI-shaped bearer agent record with its link, and one built by historyRecordForPublishedShare, are admitted as proven; a record padded past 32 KiB is refused `size` by the agent store before writing, and by the reconciler when written raw, with the node refusing to send its body", async () => {
    const owner = await newOwner();
    // The owner's client, with every KV GET's limit and outcome recorded by key.
    const gets: { key: string; maxResponseBytes?: number; outcome: string }[] = [];
    const kv = owner.node.kv;
    const countingKv = {
      get: (async (key: string, options: { maxResponseBytes?: number }) => {
        const result = await kv.get(key, options as never);
        gets.push({ key, ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }), outcome: result.ok ? "OK" : result.error.code });
        return result;
      }) as typeof kv.get,
      put: kv.put.bind(kv), list: kv.list.bind(kv),
    };
    const index = newIndex(owner, createTinyCloudShareIndexBackend({
      client: { vault: owner.node.vault, kv: countingKv, encryption: owner.node.encryption },
      spaceId: owner.spaceId, ownerNetworkId: owner.networkId, decryptProof: () => ({ proofs: [owner.node.session!.delegationCid] }),
    }), new MemoryShareIndexOutbox(), "web:f0");
    const agent = await ownerWalletAgent(owner);
    const withLink = bearerAgentRecord(owner, await publishLink(agent.node, owner, "f0full"), agent.node);
    const fromHistory = historyBearerRecord(owner, await publishLink(agent.node, owner, "f0hist"), agent.node);
    const padded: SenderShareRecord = { ...bearerAgentRecord(owner, await publishLink(agent.node, owner, "f0pad"), agent.node), deliveredRecipients: ["x".repeat(20_000)] };
    for (const record of [withLink, fromHistory]) await agent.store.put(record);
    const storePadded = await agent.store.put(padded).then(() => "OK", (error: unknown) => (error instanceof Error ? error.message : "rejected"));
    const agentBackend = createTinyCloudShareIndexBackend({ client: agent.node, spaceId: owner.spaceId, ownerNetworkId: owner.networkId });
    // An agent can still write raw bytes under its own prefix: seal the oversize record by hand and put it.
    const paddedKey = agentRecordKey(agent.agentId, padded.shareId);
    const sealed = await sealAgentRecord({
      plaintext: enc(JSON.stringify(padded)), spaceId: owner.spaceId, vaultKey: `${SHARE_RECORDS_VAULT_PREFIX}${paddedKey}`, agentDid: agent.agentDid,
      ownerNetworkId: owner.networkId, ownerWrap: agentBackend.ownerWrap, agentKey: await agentKeyFor(agent.node, agent.agentDid),
    });
    expect(await agentBackend.writeRaw(paddedKey, sealed as unknown as Record<string, unknown>, { ifNoneMatch: "*" })).toEqual({ ok: true });
    const storedSize = async (record: SenderShareRecord) => {
      const raw = await agentBackend.readRaw(agentRecordKey(agent.agentId, record.shareId));
      return raw.status === "ok" ? raw.bytes.byteLength : -1;
    };
    const pass = await index.reconcile();
    const paddedGets = gets.filter((get) => get.key.endsWith(paddedKey));
    const doc = await loadDoc(index);
    const proofState = (record: SenderShareRecord) => doc.rows[agentRecordKey(agent.agentId, record.shareId)]?.ps ?? null;
    const readBack = async (record: SenderShareRecord) => agent.store.get(record.shareId).then(() => "OK", (error: unknown) => (error instanceof Error ? error.message : "rejected"));
    report.f0 = {
      plaintextBytes: { withLink: enc(JSON.stringify(withLink)).length, fromHistory: enc(JSON.stringify(fromHistory)).length, padded: enc(JSON.stringify(padded)).length },
      componentBytes: { link: withLink.link?.length ?? 0, sessionCacao: withLink.proofs?.session?.length ?? 0, linkUcan: withLink.proofs?.link?.length ?? 0 },
      storedBytes: { withLink: await storedSize(withLink), fromHistory: await storedSize(fromHistory), padded: await storedSize(padded), cap: 32 * 1024 },
      paddedOwnerGets: paddedGets.map(({ maxResponseBytes, outcome }) => ({ maxResponseBytes, outcome })),
      historyTargetKeys: Object.keys(fromHistory.target).sort(),
      reconcile: pass,
      proofState: { withLink: proofState(withLink), fromHistory: proofState(fromHistory), padded: proofState(padded) },
      agentReadBack: { withLink: await readBack(withLink), fromHistory: await readBack(fromHistory), padded: await readBack(padded) },
    };
    expect(Object.keys(fromHistory.target)).toContain("kind");
    expect(storePadded).toBe("agent record refused: size");
    expect(await storedSize(padded)).toBeGreaterThan(32 * 1024);
    expect(pass.rejected).toEqual({ size: 1 });
    // The owner asked the node for at most the cap, and the node refused before sending the body.
    expect(paddedGets.map(({ maxResponseBytes, outcome }) => ({ maxResponseBytes, outcome }))).toEqual([{ maxResponseBytes: 32 * 1024, outcome: "KV_RESPONSE_TOO_LARGE" }]);
    expect([proofState(withLink), proofState(fromHistory), proofState(padded)]).toEqual(["proven", "proven", null]);
    expect([await readBack(withLink), await readBack(fromHistory), await readBack(padded)]).toEqual(["OK", "OK", "agent record refused: size"]);
  }, 120_000);

  test("f: copied and forged agent records are rejected; a genuine proven record displaces a copied-proof chained claim", async () => {
    const owner = await newOwner();
    const backend = instrument(ownerBackend(owner));
    const index = newIndex(owner, backend.backend, new MemoryShareIndexOutbox(), "web:f");
    const agentA = await ownerWalletAgent(owner);
    const agentB = await ownerWalletAgent(owner);
    const link = await publishLink(agentA.node, owner, "fshare");
    // B claims A's link with A's real proofs (verifies as chained) and is reconciled first.
    const copiedProof = bearerAgentRecord(owner, link, agentA.node);
    await agentB.store.put(copiedProof);
    const pass1 = await index.reconcile();
    const keyA = agentRecordKey(agentA.agentId, link.cid);
    const keyB = agentRecordKey(agentB.agentId, link.cid);
    const afterPass1 = await loadDoc(index);
    const chainedRow = afterPass1.rows[keyB];
    // A's genuine record arrives a pass later and displaces B's claim.
    await agentA.store.put(bearerAgentRecord(owner, link, agentA.node));
    const pass2 = await index.reconcile();
    const afterPass2 = await loadDoc(index);

    // Copy A's stored record verbatim into B's prefix.
    const storedA = await backend.backend.readRaw(keyA);
    if (storedA.status !== "ok") throw new Error("A's record is not readable");
    const storedValue = JsonObject.parse(JSON.parse(new TextDecoder().decode(storedA.bytes)));
    const copyKey = agentRecordKey(agentB.agentId, `copy${RUN}`);
    const copyWrite = await backend.backend.writeRaw(copyKey, storedValue, { ifNoneMatch: "*" });
    // B's own header around a foreign wrapped key that declares this key's AAD.
    const storedB = await backend.backend.readRaw(keyB);
    if (storedB.status !== "ok") throw new Error("B's record is not readable");
    const forgedKey = agentRecordKey(agentB.agentId, `forged${RUN}`);
    const forgedBinding = agentRecordBinding({ spaceId: owner.spaceId, vaultKey: `${SHARE_RECORDS_VAULT_PREFIX}${forgedKey}`, agentDid: agentB.agentDid, ownerNetworkId: owner.networkId });
    const foreignWrap = JsonObject.parse(storedValue.wrapOwner);
    const forged = { ...JsonObject.parse(JSON.parse(new TextDecoder().decode(storedB.bytes))), wrapOwner: { ...foreignWrap, aad: Buffer.from(forgedBinding).toString("base64") } };
    const forgedWrite = await backend.backend.writeRaw(forgedKey, forged, { ifNoneMatch: "*" });
    let forgedUnwraps = 0;
    const forgedAad = Buffer.from(forgedBinding).toString("base64");
    backend.onUnwrap = (aad) => { if (Buffer.from(aad).toString("base64") === forgedAad) forgedUnwraps++; };
    const pass3 = await index.reconcile();
    const doc = await loadDoc(index);
    const entryB = doc.agents[agentB.agentId];
    report.f = {
      pass1: pass1,
      copiedProofRowAfterPass1: chainedRow === undefined ? null : { src: chainedRow.src === `agent:${agentB.agentId}` ? "agent:B" : chainedRow.src, ps: chainedRow.ps },
      pass2: pass2,
      rowAfterPass2: { aPresent: afterPass2.rows[keyA] !== undefined, aProofState: afterPass2.rows[keyA]?.ps ?? null, bPresent: afterPass2.rows[keyB] !== undefined },
      copyWrite: copyWrite.ok,
      forgedWrite: forgedWrite.ok,
      pass3: pass3,
      forgedUnwrapPosts: forgedUnwraps,
      agentB: entryB === undefined ? null : { rejected: entryB.rejected, rejectedKeys: entryB.rejectedKeys.length, rows: entryB.rows },
    };
    expect(chainedRow?.ps).toBe("chained");
    expect(afterPass2.rows[keyA]?.src).toBe(`agent:${agentA.agentId}`);
    expect(afterPass2.rows[keyA]?.ps).toBe("proven");
    expect(afterPass2.rows[keyB]).toBeUndefined();
    expect(afterPass2.agents[agentB.agentId]?.rejected.proof).toBe(1);
    expect(pass3.rejected.header ?? 0).toBeGreaterThanOrEqual(1);
    expect((pass3.rejected.decrypt ?? 0) + (pass3.rejected.commit ?? 0)).toBe(1);
    expect(forgedUnwraps).toBe(1);
    expect(doc.rows[copyKey]).toBeUndefined();
    expect(doc.rows[forgedKey]).toBeUndefined();
  }, 180_000);

  test("g: flood of 1,500 junk keys and 60 valid records in one agent prefix pauses the agent within budgets", async () => {
    const owner = await newOwner();
    const backend = instrument(ownerBackend(owner));
    const index = newIndex(owner, backend.backend, new MemoryShareIndexOutbox(), "web:g");
    const webIds = Array.from({ length: 10 }, (_, i) => `gweb${i}r${RUN}`);
    const webStore = new WebShareRecordStore(backend.backend);
    for (const shareId of webIds) {
      const record = webRecord(owner, shareId);
      await webStore.put(record);
      await index.enqueue(upsertOp(record));
    }
    await index.flush();
    const agent = await ownerWalletAgent(owner);
    let started = performance.now();
    await inBatches(Array.from({ length: 60 }, (_, i) => i), 6, async (i) => {
      await agent.store.put(bearerAgentRecord(owner, await publishLink(agent.node, owner, `g${i}`), agent.node));
    });
    await inBatches(Array.from({ length: 1500 }, (_, i) => i), 16, async (i) => {
      const put = await owner.node.kv.put(`${RECORDS_KV}agents/${agent.agentId}/junk-${String(i).padStart(4, "0")}`, { junk: i });
      if (!put.ok) throw new Error(`junk put: ${put.error.code}`);
    });
    const writeMs = Math.round(performance.now() - started);
    const passes: ShareIndexReconcileReport[] = [];
    started = performance.now();
    for (let pass = 0; pass < 15; pass++) {
      const result = await index.reconcile();
      passes.push(result);
      const entry = (await loadDoc(index)).agents[agent.agentId];
      if (result.cycleComplete && result.fetches === 0 && entry?.paused !== false) break;
    }
    const doc = await loadDoc(index);
    const entry = doc.agents[agent.agentId];
    const { rows: _rows, ...header } = doc;
    const headerBytes = enc(JSON.stringify(header)).length;
    report.g = {
      writeMs,
      reconcileMs: Math.round(performance.now() - started),
      passes: passes.length,
      perPass: passes.map((pass) => `${pass.pages}p/${pass.fetches}f/${pass.admitted}a/${JSON.stringify(pass.rejected)}`).join(" "),
      paused: entry?.paused === false ? false : entry?.paused?.reason ?? null,
      rejectedKeys: entry?.rejectedKeys.length ?? null,
      rejected: entry?.rejected ?? null,
      agentRows: entry?.rows ?? null,
      headerBytes,
      webRowsPresent: webIds.filter((id) => doc.rows[id] !== undefined).length,
    };
    expect(entry?.paused).not.toBe(false);
    expect(entry!.rejectedKeys.length).toBeLessThanOrEqual(100);
    expect(headerBytes).toBeLessThanOrEqual(64 * 1024);
    expect(webIds.every((id) => doc.rows[id] !== undefined)).toBe(true);
    for (const pass of passes) {
      expect(pass.pages).toBeLessThanOrEqual(10);
      expect(pass.fetches).toBeLessThanOrEqual(200);
    }
  }, 900_000);

  test("h: two-space layout: records in `applications`, content in the agent session's `default`; the bearer and the real CLI v3 record (stored form, under the 32 KiB cap) are proven and read back whole; another owner's space or a registeredAt before the session is refused `schema`", async () => {
    const owner = await newOwner();
    const appsId = await owner.node.ensureOwnedSpaceHosted("applications");
    const recordsGrant = (path: string) => [{ service: "tinycloud.kv", space: appsId, path, skipPrefix: true, actions: ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/list", "tinycloud.kv/metadata", "tinycloud.kv/del"] }];
    // The owner's own sign-in covers `default`; records live in `applications`.
    await owner.node.grantRuntimePermissions(recordsGrant(RECORDS_KV));
    const ownerApps = owner.node.space(appsId);
    const index = newIndex(owner, createTinyCloudShareIndexBackend({
      client: { vault: ownerApps.vault, kv: ownerApps.kv, encryption: owner.node.encryption },
      spaceId: appsId,
      ownerNetworkId: owner.networkId,
      decryptProof: () => ({ proofs: [owner.node.session!.delegationCid] }),
    }), new MemoryShareIndexOutbox(), "web:h");
    // Agent A: a CLI sign-in of the owner wallet with the Tier W grant on its own record prefix.
    const agentNode = await signedIn(owner.key);
    const agentDid = agentNode.credentialHolderDid;
    const agentId = agentIdFromDid(agentDid);
    await agentNode.grantRuntimePermissions(recordsGrant(`${RECORDS_KV}agents/${agentId}/`));
    const agentApps = agentNode.space(appsId);
    const agentBackend = createTinyCloudShareIndexBackend({ client: { vault: agentApps.vault, kv: agentApps.kv, encryption: agentNode.encryption }, spaceId: appsId, ownerNetworkId: owner.networkId });
    const store = new AgentShareRecordStore({ backend: agentBackend, agentDid, agentKey: await agentKeyFor(agentNode, agentDid) });
    // Content in the agent session's `default` space (owner.spaceId is the same wallet's `default`).
    const bearer = bearerAgentRecord(owner, await publishLink(agentNode, owner, "hbearer"), agentNode);
    const v3 = await publishAgentV3(agentNode, didKeyFromEd25519PublicKey(ed25519.getPublicKey(ed25519.utils.randomPrivateKey())));
    const foreignBase = bearerAgentRecord(owner, await publishLink(agentNode, owner, "hforeign"), agentNode);
    const foreign: SenderShareRecord = { ...foreignBase, target: { ...foreignBase.target, spaceId: `tinycloud:pkh:eip155:1:${Wallet.createRandom().address}:default` } };
    // A real record whose registeredAt is moved 3 days before the session's SIWE Issued At.
    const issuedAt = Date.parse(/\nIssued At: (\S+)/.exec(agentNode.session!.siwe)?.[1] ?? "");
    expect(Number.isFinite(issuedAt)).toBe(true);
    const backdated: SenderShareRecord = { ...bearerAgentRecord(owner, await publishLink(agentNode, owner, "hbackdated"), agentNode), registeredAt: new Date(issuedAt - 3 * 86_400_000).toISOString() };
    const records = [["bearer", bearer], ["v3", v3], ["foreign", foreign], ["backdated", backdated]] as const;
    const puts: Record<string, string> = {};
    for (const [label, record] of records) {
      puts[label] = await store.put(record).then(() => "OK", (error: unknown) => (error instanceof Error ? error.message : "rejected"));
    }
    const storedBytes: Record<string, number> = {};
    for (const [label, record] of records) {
      const raw = await agentBackend.readRaw(agentRecordKey(agentId, record.shareId));
      storedBytes[label] = raw.status === "ok" ? raw.bytes.byteLength : -1;
    }
    const pass = await index.reconcile();
    const doc = await loadDoc(index);
    const proofState = (record: SenderShareRecord) => doc.rows[agentRecordKey(agentId, record.shareId)]?.ps ?? null;
    const stored = await compactShareRecord(v3);
    // The v3 record's chain judged directly, apart from the store.
    const v3Verdict = await verifyAgentRecordChain(stored, { accountOwnerDid: owner.ownerDid, agentDid, now: new Date(), parseSiweCacao: parseSignedSiweCacao })
      .then((verdict) => (verdict.ok ? verdict.state : `rejected: ${verdict.detail}`));
    // Read back by the agent: the envelope is reopened from the sealed material; the full link is not kept in the index.
    const readBack = await new AgentShareRecordStore({ backend: agentBackend, agentDid, agentKey: await agentKeyFor(agentNode, agentDid) }).get(v3.shareId);
    const { link: _fullLink, ...v3WithoutLink } = v3;
    report.h = {
      recordsSpaceIsApplications: appsId.endsWith(":applications"),
      contentSpaceIsDefault: owner.spaceId.endsWith(":default"),
      puts,
      storedBytes: { ...storedBytes, cap: 32 * 1024 },
      reconcile: pass,
      proofState: Object.fromEntries(records.map(([label, record]) => [label, proofState(record)])),
      agentEntry: doc.agents[agentId] === undefined ? null : { rows: doc.agents[agentId]!.rows, rejected: doc.agents[agentId]!.rejected },
      v3ChainVerdict: v3Verdict,
      v3Bytes: {
        fullPlaintext: enc(JSON.stringify(v3)).length,
        storedPlaintext: enc(JSON.stringify(stored)).length,
        envelope: enc(JSON.stringify(v3.deliveryMaterial?.envelope ?? {})).length,
        link: v3.link?.length ?? 0,
        sealedEnvelope: v3.deliveryMaterial?.sealedEnvelope.length ?? 0,
        sessionCacao: v3.proofs?.session?.length ?? 0,
        storedRecord: storedBytes.v3,
        headroom: 32 * 1024 - storedBytes.v3!,
      },
      v3ReadBackWhole: canonicalize(readBack) === canonicalize(v3WithoutLink),
      v3FullLinkNotStored: stored.link === undefined && readBack?.link === undefined,
    };
    console.log(`SHARE-INDEX-H ${JSON.stringify(report.h)}`);
    leakChecked.push({ label: "h", index });
    // The cap ruling: the stored v3 record keeps each blob once (no envelope, no full link), fits under
    // MAX_AGENT_RECORD_BYTES and is admitted proven.
    expect(puts).toEqual({ bearer: "OK", v3: "OK", foreign: "OK", backdated: "OK" });
    expect(storedBytes.v3).toBeLessThanOrEqual(32 * 1024);
    expect(v3Verdict).toBe("proven");
    expect(records.map(([, record]) => proofState(record))).toEqual(["proven", "proven", null, null]);
    expect(pass.rejected).toEqual({ schema: 2 });
    expect(readBack).toEqual(v3WithoutLink);
    expect(stored.link).toBeUndefined();
  }, 180_000);

  test("e: no link, token, delivery material or full email in any decrypted index (after a, b, c, h)", async () => {
    const findings: Record<string, unknown> = {};
    for (const { label, index } of leakChecked) {
      const text = JSON.stringify(await loadDoc(index));
      findings[label] = {
        bytes: text.length,
        hashK: text.includes("#k="),
        tc1: text.includes("tc1"),
        deliveryMaterial: text.includes("deliveryMaterial"),
        linkKey: /"link"\s*:/.test(text),
        fullEmail: text.includes(LEAK_EMAIL),
      };
    }
    report.e = findings;
    console.log(`SHARE-INDEX-RESULTS ${JSON.stringify(report)}`);
    expect(leakChecked.map((item) => item.label)).toEqual(expect.arrayContaining(["a", "b", "c-upsert", "c-revoke", "h"]));
    for (const [label, finding] of Object.entries(findings)) {
      expect([label, finding]).toEqual([label, expect.objectContaining({ hashK: false, tc1: false, deliveryMaterial: false, linkKey: false, fullEmail: false })]);
    }
  }, 120_000);
});
