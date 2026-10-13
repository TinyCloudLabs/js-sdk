import { afterEach, describe, expect, it, mock } from "bun:test";
import { MemorySenderShareRecordStorage, revokeShare, type SenderShareRecord, type ShareRevocationResult } from "@tinycloud/share-sdk";
import { didKeyFromEd25519PublicKey } from "@tinycloud/share-envelope";
import { parseCompactUcanAuthorization, signCompactUcanRootAuthorization, type CompactUcanAuthorizationV1 } from "@tinycloud/sdk-core";
import { computeCid } from "@tinycloud/node-sdk-wasm";

const NODE_ORIGIN = "https://node.example";
const NODE_DID = "did:key:z6MkvRXNYcE7MMduynWTgeKbDaT1iijDSC8pZqXZc8rHPrf2";
const OWNER_DID = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";
const SPACE_ID = `tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default`;

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
 * The owner node's revocation rule (tinycloud-core models/revocation.rs): a
 * proofless revocation is authorized when its signer is the target's
 * delegator or the owner of the space it targets. A compact UCAN names the
 * target as `urn:cid:<cid>`. The owner's wallet CACAO revocation is stood in
 * for by an `owner:<did>:<cid>` token here; the local-node smoke exercises
 * the real CACAO.
 */
const delegations = new Map<string, { readonly delegator: string; readonly owner: string }>();
const revoked = new Set<string>();
const links = new Map<string, { readonly keyDid: string; readonly delegation: { readonly cid: string; readonly authHeader: string } }>();
const revocations: string[] = [];
let nodeReply: { readonly status: number; readonly body: string } | undefined;

async function nodeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (url.origin !== NODE_ORIGIN || url.pathname !== "/revoke" || init?.method !== "POST") return new Response("not found", { status: 404 });
  const authorization = new Headers(init.headers).get("authorization") ?? "";
  revocations.push(authorization);
  if (nodeReply !== undefined) return new Response(nodeReply.body, { status: nodeReply.status });
  let signer: string;
  let cid: string;
  if (authorization.startsWith("owner:")) {
    [, signer = "", cid = ""] = /^owner:(did:pkh:[^:]+:[^:]+:[^:]+):(.+)$/.exec(authorization) ?? [];
  } else {
    let payload: CompactUcanAuthorizationV1["payload"];
    try {
      payload = parseCompactUcanAuthorization(authorization).payload;
    } catch {
      return new Response("Failed to verify signature", { status: 403 });
    }
    const now = Math.floor(Date.now() / 1000);
    if (payload.nbf > now || payload.exp <= now) return new Response("Revocation expired or not yet valid", { status: 403 });
    const target = Object.entries(payload.att).find(([, actions]) => actions["tinycloud.delegation/revoke"] !== undefined)?.[0];
    if (!target?.startsWith("urn:cid:") || payload.prf.length !== 0) return new Response("Unauthorized Revoker", { status: 403 });
    signer = payload.iss.split("#", 1)[0]!;
    cid = target.slice("urn:cid:".length);
  }
  const delegation = delegations.get(cid);
  if (delegation === undefined) return new Response("Cannot find parent delegation", { status: 403 });
  if (signer !== delegation.delegator && signer !== delegation.owner) return new Response("Unauthorized Revoker", { status: 403 });
  revoked.add(cid);
  return Response.json({ revoked: true, cid });
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
        return `owner:${OWNER_DID}:${cid}`;
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

function bearerRecord(cid: string, token: string): SenderShareRecord {
  const now = Date.now();
  return {
    shareId: cid,
    target: { origin: NODE_ORIGIN, nodeAudience: NODE_DID, spaceId: SPACE_ID },
    resource: { kind: "exact", path: "xyz.tinycloud.share/shares/abc/note.md" },
    actions: ["tinycloud.kv/get"],
    recipientMatcher: { kind: "bearer" },
    targetKind: "bearer",
    enforcementDelegationCid: cid,
    registeredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    link: `https://share.example/viewer#tc1=${token}`,
  };
}

/** A bearer link as `tc share publish` records it when the session key mints it. */
async function sessionSignedShare(issuer: SessionKey): Promise<SenderShareRecord> {
  const linkKey = await sessionKey();
  const now = Math.floor(Date.now() / 1000);
  const delegation = await signCompactUcanRootAuthorization({
    issuerDid: issuer.did,
    audienceDid: linkKey.did,
    attenuation: { [`${SPACE_ID}/kv/xyz.tinycloud.share/shares/abc/note.md`]: { "tinycloud.kv/get": [{}] } },
    facts: [{}],
    notBefore: now,
    expiresAt: now + 3600,
    nonce: `urn:uuid:${crypto.randomUUID()}`,
    sign: issuer.sign,
  });
  delegations.set(delegation.cid, { delegator: issuer.did, owner: OWNER_DID });
  const token = `token-${delegation.cid}`;
  links.set(token, { keyDid: linkKey.did, delegation: { cid: delegation.cid, authHeader: delegation.authorization } });
  return bearerRecord(delegation.cid, token);
}

/** A bearer link that outlives the session: the owner wallet signs a CACAO delegation. */
async function ownerSignedShare(): Promise<SenderShareRecord> {
  const bytes = crypto.getRandomValues(new Uint8Array(96));
  const delegationCid = computeCid(bytes, 0x55n);
  delegations.set(delegationCid, { delegator: OWNER_DID, owner: OWNER_DID });
  const token = `token-${delegationCid}`;
  links.set(token, { keyDid: (await sessionKey()).did, delegation: { cid: delegationCid, authHeader: Buffer.from(bytes).toString("base64url") } });
  return bearerRecord(delegationCid, token);
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

afterEach(() => {
  delegations.clear();
  revoked.clear();
  links.clear();
  revocations.length = 0;
  nodeReply = undefined;
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

  it("revokes an owner-signed link on a profile that holds the owner key", async () => {
    const record = await ownerSignedShare();
    profile = { session: await sessionKey(), ownerKey: true };

    const outcome = await revoke(record);

    expect(outcome).toMatchObject({ result: { state: "revoked" } });
    expect(revoked.has(record.shareId)).toBe(true);
    expect(outcome.revokedAt).toBeString();
  });

  it("revokes a link an earlier session key signed with the owner key", async () => {
    const record = await sessionSignedShare(await sessionKey());
    profile = { session: await sessionKey(), ownerKey: true };

    expect(await revoke(record)).toMatchObject({ result: { state: "revoked" } });
    expect(revocations).toEqual([`owner:${OWNER_DID}:${record.shareId}`]);
  });

  it.each([
    ["another session key signed", () => sessionKey().then(sessionSignedShare)],
    ["the owner wallet signed", () => ownerSignedShare()],
  ])("refuses a link %s on a session-only profile without asking the node", async (_case, share) => {
    const record = await share();
    profile = { session: await sessionKey(), ownerKey: false };

    const outcome = await revoke(record);

    expect(outcome.error).toMatchObject({ code: "SHARE_ISSUER_KEY_UNAVAILABLE", exitCode: 5 });
    expect(revocations).toEqual([]);
    expect(outcome.revokedAt).toBeUndefined();
  });

  it.each([
    ["has no stored link", (record: SenderShareRecord) => ({ ...record, link: undefined })],
    ["names another delegation CID", (record: SenderShareRecord) => ({ ...record, shareId: "bafkr4iother", enforcementDelegationCid: "bafkr4iother" })],
  ])("refuses a record that %s without asking the node", async (_case, tamper) => {
    const publisher = await sessionKey();
    const record = tamper(await sessionSignedShare(publisher));
    profile = { session: publisher, ownerKey: true };

    const outcome = await revoke(record);

    expect(outcome.error).toMatchObject({ code: "SHARE_LINK_UNAVAILABLE", exitCode: 1 });
    expect(revocations).toEqual([]);
  });

  it("never revokes this profile's own session delegation, even through a link bound to it", async () => {
    // A tampered history can bind a record and link to the session delegation's bytes.
    const record = await ownerSignedShare();
    profile = { session: await sessionKey(), ownerKey: true, sessionDelegationCid: record.shareId };

    const outcome = await revoke(record);

    expect(outcome.error).toMatchObject({ code: "SHARE_LINK_UNAVAILABLE" });
    expect(revocations).toEqual([]);
  });

  it.each([
    [403, "Cannot find parent delegation", "the node rejected the share revocation (HTTP 403: Cannot find parent delegation); nothing was revoked"],
    [500, "database unavailable", "the node rejected the share revocation (HTTP 500: database unavailable); nothing was revoked"],
    [200, JSON.stringify({ revoked: true, cid: "bafkr4iother" }), "the node rejected the share revocation (HTTP 200); nothing was revoked"],
  ])("reports a node reply %i for a link the session key signed as SHARE_REVOKE_REJECTED", async (status, body, message) => {
    const publisher = await sessionKey();
    const record = await sessionSignedShare(publisher);
    profile = { session: publisher, ownerKey: false };
    nodeReply = { status, body };

    const outcome = await revoke(record);

    expect(outcome.error).toMatchObject({ code: "SHARE_REVOKE_REJECTED", exitCode: 7, status: status === 200 ? undefined : status, message });
    expect(revocations).toHaveLength(1);
    expect(outcome.revokedAt).toBeUndefined();
  });
});
