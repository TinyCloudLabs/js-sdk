import { afterEach, describe, expect, it, mock } from "bun:test";
import { MemorySenderShareRecordStorage, revokeShare, type SenderShareRecord, type ShareRevocationResult } from "@tinycloud/share-sdk";
import { didKeyFromEd25519PublicKey } from "@tinycloud/share-envelope";
import {
  parseCompactUcanAuthorization,
  parseSignedSiweCacao,
  signCompactUcanRootAuthorization,
  type CompactUcanAuthorizationV1,
} from "@tinycloud/sdk-core";
import { NodeWasmBindings, PrivateKeySigner, TinyCloudNode } from "@tinycloud/node-sdk";

const NODE_ORIGIN = "https://node.example";
const NODE_DID = "did:key:z6MkvRXNYcE7MMduynWTgeKbDaT1iijDSC8pZqXZc8rHPrf2";

// A test owner wallet signs real SIWE CACAOs: owner-signed links and the
// owner revocations `TinyCloudNode.signOwnerRevocation` produces.
const wasm = new NodeWasmBindings();
const ownerSigner = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const OWNER_ADDRESS = await ownerSigner.getAddress();
const OWNER_DID = `did:pkh:eip155:1:${OWNER_ADDRESS}`;
const SPACE_ID: string = wasm.makeSpaceId(OWNER_ADDRESS, 1, "default");
const ownerNode = new TinyCloudNode({ host: NODE_ORIGIN, signer: ownerSigner, autoDiscoverLocalNode: false });
Object.assign(ownerNode, { _restoredTcSession: { address: OWNER_ADDRESS, chainId: 1, spaceId: SPACE_ID } });

interface SessionKey {
  readonly did: string;
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>;
}

async function sessionKey(): Promise<SessionKey> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    did: didKeyFromEd25519PublicKey(publicKey),
    sign: async (bytes) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, bytes)),
  };
}

/**
 * The owner node's `POST /revoke` (tinycloud-core models/revocation.rs): a
 * proofless revocation is authorized when its verified signer is the
 * target's delegator or the owner of the space it targets. A compact UCAN
 * names the target as `urn:cid:<cid>`; a wallet CACAO as `aud ucan:<cid>`.
 */
const delegations = new Map<string, { readonly delegator: string }>();
const revoked = new Set<string>();
const links = new Map<string, { readonly keyDid: string; readonly delegation: { readonly cid: string; readonly authHeader: string } }>();
const revocations: string[] = [];
/** Refuse before applying the revocation. */
let refusal: { readonly status: number; readonly body: string } | undefined;
/** Apply the revocation, then reply with this body instead of the receipt. */
let receiptBody: string | undefined;

async function nodeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (url.origin !== NODE_ORIGIN || url.pathname !== "/revoke" || init?.method !== "POST") return new Response("not found", { status: 404 });
  const authorization = new Headers(init.headers).get("authorization") ?? "";
  revocations.push(authorization);
  if (refusal !== undefined) return new Response(refusal.body, { status: refusal.status });
  let signer: string;
  let cid: string;
  try {
    if (authorization.includes(".")) {
      const payload: CompactUcanAuthorizationV1["payload"] = parseCompactUcanAuthorization(authorization).payload;
      const now = Math.floor(Date.now() / 1000);
      if (payload.nbf > now || payload.exp <= now || payload.prf.length !== 0) return new Response("Unauthorized Revoker", { status: 403 });
      const target = Object.entries(payload.att).find(([, actions]) => actions["tinycloud.delegation/revoke"] !== undefined)?.[0] ?? "";
      signer = payload.iss.split("#", 1)[0]!;
      cid = target.startsWith("urn:cid:") ? target.slice("urn:cid:".length) : "";
    } else {
      const cacao = await parseSignedSiweCacao(authorization);
      if (cacao.expiresAt === undefined || Date.parse(cacao.expiresAt) <= Date.now()) return new Response("Revocation expired or not yet valid", { status: 403 });
      signer = cacao.issuer;
      cid = cacao.audience.startsWith("ucan:") ? cacao.audience.slice("ucan:".length) : "";
    }
  } catch {
    return new Response("Failed to verify signature", { status: 403 });
  }
  const delegation = delegations.get(cid);
  if (delegation === undefined) return new Response("Cannot find parent delegation", { status: 403 });
  if (signer !== delegation.delegator && signer !== OWNER_DID) return new Response("Unauthorized Revoker", { status: 403 });
  revoked.add(cid);
  return receiptBody === undefined ? Response.json({ revoked: true, cid }) : new Response(receiptBody, { status: 200 });
}

/** The profile the next CLI invocation restores. */
let profile: { readonly session: SessionKey; readonly ownerKey: boolean; readonly sessionDelegationCid?: string } | undefined;

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    resolveContext: async ({ profile: name }: { profile: string }) => ({ profile: name, host: NODE_ORIGIN }),
    getProfile: async () => ({ authMethod: profile?.ownerKey ? "local" : "openkey" }),
  },
}));
mock.module("../lib/sdk.js", () => ({
  ensureAuthenticated: async () => {
    if (profile === undefined) throw new Error("no session");
    const { session, ownerKey, sessionDelegationCid = "bafkr4isessiondelegation" } = profile;
    return {
      sessionDid: `${session.did}#${session.did.slice("did:key:".length)}`,
      credentialHolderDid: session.did,
      isSessionOnly: !ownerKey,
      session: { delegationCid: sessionDelegationCid },
      activeNodeIdentity: async () => ({ origin: NODE_ORIGIN, nodeDid: NODE_DID }),
      signSessionBytes: session.sign,
      signOwnerRevocation: async (cid: string) => {
        if (!ownerKey) throw new Error("Owner wallet signer is required");
        return ownerNode.signOwnerRevocation(cid);
      },
      sharing: {
        decodeLink: (token: string) => {
          const decoded = links.get(token);
          if (decoded === undefined) throw new Error("unknown share link");
          return decoded;
        },
      },
    };
  },
}));

const { createShareAuthorityAdapters } = await import("./adapters.js");

/** One CLI invocation: a fresh adapter restores the profile's current session. */
const revocationAdapter = () => createShareAuthorityAdapters({ profileName: async () => "publisher", fetchFn: nodeFetch as typeof globalThis.fetch }).revocation;

function bearerRecord(cid: string, path: string, token: string): SenderShareRecord {
  const now = Date.now();
  return {
    shareId: cid,
    target: { origin: NODE_ORIGIN, nodeAudience: NODE_DID, spaceId: SPACE_ID },
    resource: { kind: "exact", path },
    actions: ["tinycloud.kv/get"],
    recipientMatcher: { kind: "bearer" },
    targetKind: "bearer",
    enforcementDelegationCid: cid,
    registeredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    link: `https://share.example/viewer#tc1=${token}`,
  };
}

const sharePath = () => `xyz.tinycloud.share/shares/${crypto.randomUUID().replaceAll("-", "")}/note.md`;

/** A bearer link as `tc share publish` records it when the session key mints it. */
async function sessionSignedShare(issuer: SessionKey): Promise<SenderShareRecord> {
  const linkKey = await sessionKey();
  const path = sharePath();
  const now = Math.floor(Date.now() / 1000);
  const delegation = await signCompactUcanRootAuthorization({
    issuerDid: issuer.did,
    audienceDid: linkKey.did,
    attenuation: { [`${SPACE_ID}/kv/${path}`]: { "tinycloud.kv/get": [{}] } },
    facts: [{}],
    notBefore: now,
    expiresAt: now + 3600,
    nonce: `urn:uuid:${crypto.randomUUID()}`,
    sign: issuer.sign,
  });
  delegations.set(delegation.cid, { delegator: issuer.did });
  const token = `token-${delegation.cid}`;
  links.set(token, { keyDid: linkKey.did, delegation: { cid: delegation.cid, authHeader: delegation.authorization } });
  return bearerRecord(delegation.cid, path, token);
}

/** A bearer link that outlives the session: the owner wallet signs a CACAO, as `createOwnerDelegation` does. */
async function ownerSignedShare(): Promise<SenderShareRecord> {
  const linkKey = await sessionKey();
  const path = sharePath();
  const issuedAt = new Date();
  const prepared = wasm.prepareSession({
    abilities: { kv: { [path]: ["tinycloud.kv/get"] } },
    address: OWNER_ADDRESS,
    chainId: 1,
    domain: "app.tinycloud.xyz",
    issuedAt: issuedAt.toISOString(),
    expirationTime: new Date(issuedAt.getTime() + 60 * 86_400_000).toISOString(),
    spaceId: SPACE_ID,
    delegateUri: linkKey.did,
  });
  const signed = wasm.completeSessionSetup({ ...prepared, signature: await ownerSigner.signMessage(prepared.siwe) });
  const cid: string = signed.delegationCid;
  delegations.set(cid, { delegator: OWNER_DID });
  const token = `token-${cid}`;
  links.set(token, { keyDid: `${linkKey.did}#${linkKey.did.slice("did:key:".length)}`, delegation: { cid, authHeader: signed.delegationHeader.Authorization } });
  return bearerRecord(cid, path, token);
}

interface RevokeOutcome {
  readonly result?: ShareRevocationResult;
  readonly error?: unknown;
  readonly revokedAt: string | undefined;
}

async function revoke(record: SenderShareRecord): Promise<RevokeOutcome> {
  const records = new MemorySenderShareRecordStorage();
  await records.put(record);
  const outcome = await revokeShare({ record, records, adapter: revocationAdapter() }).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  return { ...outcome, revokedAt: (await records.get(record.shareId))?.revokedAt };
}

/** Point a record at another link's token, as a tampered sender history could. */
function withLinkOf(record: SenderShareRecord, other: SenderShareRecord, cid = other.shareId): SenderShareRecord {
  return { ...record, shareId: cid, enforcementDelegationCid: cid, link: other.link };
}

afterEach(() => {
  delegations.clear();
  revoked.clear();
  links.clear();
  revocations.length = 0;
  refusal = undefined;
  receiptBody = undefined;
  profile = undefined;
});

describe("bearer share revocation", () => {
  it("revokes a session-signed link with a proofless revocation from that session key, addressed to the node", async () => {
    const publisher = await sessionKey();
    const record = await sessionSignedShare(publisher);
    profile = { session: publisher, ownerKey: false };

    const outcome = await revoke(record);

    expect(outcome).toMatchObject({ result: { state: "revoked", target: "bearer", delegationCid: record.shareId } });
    expect(outcome.revokedAt).toBeString();
    expect(revoked.has(record.shareId)).toBe(true);
    const payload = parseCompactUcanAuthorization(revocations[0]!).payload;
    expect({ iss: payload.iss.split("#", 1)[0], aud: payload.aud, prf: payload.prf }).toEqual({ iss: publisher.did, aud: NODE_DID, prf: [] });
  });

  it("revokes an owner-signed link with the owner wallet's CACAO revocation", async () => {
    const record = await ownerSignedShare();
    profile = { session: await sessionKey(), ownerKey: true };

    const outcome = await revoke(record);

    expect(outcome).toMatchObject({ result: { state: "revoked" } });
    expect(outcome.revokedAt).toBeString();
    expect(revoked.has(record.shareId)).toBe(true);
    const cacao = await parseSignedSiweCacao(revocations[0]!);
    expect({ issuer: cacao.issuer, audience: cacao.audience }).toEqual({ issuer: OWNER_DID, audience: `ucan:${record.shareId}` });
    expect(Date.parse(cacao.expiresAt!) - Date.now()).toBeLessThanOrEqual(600_000);
    expect(Date.parse(cacao.expiresAt!) - Date.now()).toBeGreaterThan(540_000);
  });

  it("revokes a link an earlier session key signed with the owner key", async () => {
    const record = await sessionSignedShare(await sessionKey());
    profile = { session: await sessionKey(), ownerKey: true };

    expect(await revoke(record)).toMatchObject({ result: { state: "revoked" } });
    expect((await parseSignedSiweCacao(revocations[0]!)).issuer).toBe(OWNER_DID);
  });

  it.each([
    ["another session key signed", () => sessionKey().then(sessionSignedShare)],
    ["the owner wallet signed", ownerSignedShare],
  ])("refuses a link %s on a session-only profile without asking the node", async (_case, share) => {
    const record = await share();
    profile = { session: await sessionKey(), ownerKey: false };

    const outcome = await revoke(record);

    expect(outcome.error).toMatchObject({ code: "SHARE_ISSUER_KEY_UNAVAILABLE", exitCode: 5 });
    expect(revocations).toEqual([]);
    expect(outcome.revokedAt).toBeUndefined();
  });

  it.each([
    ["has no stored link", async () => ({ ...await ownerSignedShare(), link: undefined })],
    ["names a CID its link does not carry", async () => ({ ...await ownerSignedShare(), shareId: "bafkr4iother", enforcementDelegationCid: "bafkr4iother" })],
    ["points at another share's owner-signed CACAO", async () => withLinkOf(await ownerSignedShare(), await ownerSignedShare())],
    ["points at another share's session-signed link", async () => withLinkOf(await ownerSignedShare(), await sessionSignedShare(await sessionKey()))],
    ["carries a CACAO delegated to another key", async () => {
      const record = await ownerSignedShare();
      const token = record.link!.split("tc1=")[1]!;
      links.set(token, { ...links.get(token)!, keyDid: (await sessionKey()).did });
      return record;
    }],
    ["carries a CACAO whose signature was altered", async () => {
      const record = await ownerSignedShare();
      const token = record.link!.split("tc1=")[1]!;
      const original = links.get(token)!;
      const bytes = new Uint8Array(Buffer.from(original.delegation.authHeader, "base64url"));
      // The CACAO ends with the signature bytes, then `"t": "eip191"` (9 bytes).
      bytes[bytes.length - 12]! ^= 0x01;
      const cid: string = wasm.computeCid(bytes, 0x55n);
      delegations.set(cid, { delegator: OWNER_DID });
      links.set(token, { ...original, delegation: { cid, authHeader: Buffer.from(bytes).toString("base64url") } });
      return { ...record, shareId: cid, enforcementDelegationCid: cid };
    }],
  ])("refuses a record that %s without asking the node", async (_case, tampered) => {
    const record = await tampered();
    profile = { session: await sessionKey(), ownerKey: true };

    const outcome = await revoke(record);

    expect(outcome.error).toMatchObject({ code: "SHARE_LINK_UNAVAILABLE", exitCode: 4 });
    expect(revocations).toEqual([]);
    expect(revoked.size).toBe(0);
  });

  it("never revokes this profile's own session delegation, even through a link bound to it", async () => {
    const record = await ownerSignedShare();
    profile = { session: await sessionKey(), ownerKey: true, sessionDelegationCid: record.shareId };

    const outcome = await revoke(record);

    expect(outcome.error).toMatchObject({ code: "SHARE_LINK_UNAVAILABLE" });
    expect(revocations).toEqual([]);
  });

  it.each([
    [403, "Cannot find parent delegation"],
    [500, "database unavailable"],
  ])("reports node refusal %i as SHARE_REVOKE_REJECTED with its reason", async (status, body) => {
    const publisher = await sessionKey();
    const record = await sessionSignedShare(publisher);
    profile = { session: publisher, ownerKey: false };
    refusal = { status, body };

    const outcome = await revoke(record);

    expect(outcome.error).toMatchObject({
      code: "SHARE_REVOKE_REJECTED", exitCode: 4, status,
      message: `the node rejected the share revocation (HTTP ${status}: ${body}); nothing was revoked`,
    });
    expect(outcome.revokedAt).toBeUndefined();
  });

  it.each([
    ["a receipt for another CID", JSON.stringify({ revoked: true, cid: "bafkr4iother" })],
    ["no JSON receipt", "ok"],
  ])("reports a revocation the node applied but answered with %s as SHARE_REVOKE_UNCONFIRMED", async (_case, body) => {
    const publisher = await sessionKey();
    const record = await sessionSignedShare(publisher);
    profile = { session: publisher, ownerKey: false };
    receiptBody = body;

    const outcome = await revoke(record);

    expect(revoked.has(record.shareId)).toBe(true);
    expect(outcome.error).toMatchObject({ code: "SHARE_REVOKE_UNCONFIRMED", exitCode: 1, message: expect.stringContaining("may already be revoked") });
    expect(outcome.revokedAt).toBeUndefined();
  });
});
