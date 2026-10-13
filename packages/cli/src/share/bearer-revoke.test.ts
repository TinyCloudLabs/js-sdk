import { afterEach, describe, expect, it, mock } from "bun:test";
import { MemorySenderShareRecordStorage, revokeShare, type SenderShareRecord } from "@tinycloud/share-sdk";
import { didKeyFromEd25519PublicKey } from "@tinycloud/share-envelope";
import { parseCompactUcanAuthorization, signCompactUcanRootAuthorization, type CompactUcanAuthorizationV1 } from "@tinycloud/sdk-core";

const NODE_ORIGIN = "https://node.example";
const NODE_DID = "did:key:z6MkvRXNYcE7MMduynWTgeKbDaT1iijDSC8pZqXZc8rHPrf2";
const SPACE_ID = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";

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
 * The owner node's revocation rule (tinycloud-core revocation.rs): a
 * proofless revocation of `urn:cid:<cid>` is authorized only when its signed
 * issuer is the target delegation's delegator. Anything citing the session
 * delegation as proof needs a revoke capability the publishing session lacks.
 */
const issuedBy = new Map<string, string>();
const revoked = new Set<string>();
const links = new Map<string, { readonly delegation: { readonly cid: string; readonly authHeader: string } }>();
let revokeRequests = 0;

async function nodeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (url.origin !== NODE_ORIGIN || url.pathname !== "/revoke" || init?.method !== "POST") return new Response("not found", { status: 404 });
  revokeRequests += 1;
  let payload: CompactUcanAuthorizationV1["payload"];
  try {
    payload = parseCompactUcanAuthorization(new Headers(init.headers).get("authorization") ?? "").payload;
  } catch {
    return new Response("invalid authorization", { status: 401 });
  }
  const now = Math.floor(Date.now() / 1000);
  const targets = Object.entries(payload.att);
  const [resource, actions] = targets[0] ?? ["", {}];
  if (targets.length !== 1 || !resource.startsWith("urn:cid:") || actions["tinycloud.delegation/revoke"] === undefined) {
    return new Response("not a revocation", { status: 400 });
  }
  if (payload.nbf > now || payload.exp <= now) return new Response("revocation is not current", { status: 401 });
  const cid = resource.slice("urn:cid:".length);
  const delegator = issuedBy.get(cid);
  if (delegator === undefined) return new Response("delegation not found", { status: 404 });
  if (payload.prf.length !== 0 || payload.iss.split("#", 1)[0] !== delegator) return new Response("Unauthorized Revoker", { status: 403 });
  revoked.add(cid);
  return Response.json({ revoked: true, cid });
}

let activeSession: SessionKey | undefined;

mock.module("../config/profiles.js", () => ({
  ProfileManager: {
    resolveContext: async ({ profile }: { profile: string }) => ({ profile, host: NODE_ORIGIN }),
    getProfile: async () => ({ authMethod: "openkey" }),
  },
}));
mock.module("../lib/sdk.js", () => ({
  ensureAuthenticated: async () => {
    const key = activeSession;
    if (key === undefined) throw new Error("no session");
    return {
      sessionDid: `${key.did}#${key.did.slice("did:key:".length)}`,
      credentialHolderDid: key.did,
      activeNodeIdentity: async () => ({ origin: NODE_ORIGIN, nodeDid: NODE_DID }),
      signSessionBytes: key.sign,
      sharing: {
        decodeLink: (token: string) => {
          const decoded = links.get(token);
          if (decoded === undefined) throw new Error("unknown share link");
          return decoded;
        },
      },
      // The SDK's ordinary path cites the session delegation as proof; the
      // publishing session holds no delegation/revoke capability.
      revokeDelegation: async () => ({
        ok: false as const,
        error: { code: "REVOCATION_FAILED", message: "Failed to revoke delegation: 403 - Unauthorized Revoker", meta: { status: 403 } },
      }),
    };
  },
}));

const { createShareAuthorityAdapters } = await import("./adapters.js");

/** One CLI invocation: a fresh adapter restores the profile's current session. */
const revocationAdapter = () => createShareAuthorityAdapters({ profileName: async () => "publisher", fetchFn: nodeFetch as typeof globalThis.fetch }).revocation;

/** A bearer link as `tc share publish` records it: a delegation the session key signed. */
async function publishBearer(issuer: SessionKey, linkKey: SessionKey): Promise<SenderShareRecord> {
  const now = Math.floor(Date.now() / 1000);
  const path = `xyz.tinycloud.share/shares/${crypto.randomUUID().replaceAll("-", "")}/note.md`;
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
  issuedBy.set(delegation.cid, issuer.did);
  const token = `token-${delegation.cid}`;
  links.set(token, { delegation: { cid: delegation.cid, authHeader: delegation.authorization } });
  return {
    shareId: delegation.cid,
    target: { origin: NODE_ORIGIN, nodeAudience: NODE_DID, spaceId: SPACE_ID },
    resource: { kind: "exact", path },
    actions: ["tinycloud.kv/get"],
    recipientMatcher: { kind: "bearer" },
    targetKind: "bearer",
    enforcementDelegationCid: delegation.cid,
    registeredAt: new Date(now * 1000).toISOString(),
    expiresAt: new Date((now + 3600) * 1000).toISOString(),
    link: `https://share.example/viewer#tc1=${token}`,
  };
}

afterEach(() => {
  issuedBy.clear();
  revoked.clear();
  links.clear();
  revokeRequests = 0;
  activeSession = undefined;
});

describe("bearer share revocation", () => {
  it("revokes a link with a proofless revocation signed by the session key that created it", async () => {
    const publisher = await sessionKey();
    const record = await publishBearer(publisher, await sessionKey());
    const records = new MemorySenderShareRecordStorage();
    await records.put(record);
    activeSession = publisher;

    const result = await revokeShare({ record, records, adapter: revocationAdapter() });

    expect(result).toMatchObject({ state: "revoked", target: "bearer", delegationCid: record.shareId });
    expect(revoked.has(record.shareId)).toBe(true);
    expect((await records.get(record.shareId))?.revokedAt).toBe(result.state === "revoked" ? result.revokedAt : "");
  });

  it("refuses a link another session key created without asking the node or marking it revoked", async () => {
    const record = await publishBearer(await sessionKey(), await sessionKey());
    const records = new MemorySenderShareRecordStorage();
    await records.put(record);
    activeSession = await sessionKey();

    await expect(revokeShare({ record, records, adapter: revocationAdapter() }))
      .rejects.toMatchObject({ code: "SHARE_ISSUER_KEY_UNAVAILABLE", exitCode: 5 });
    expect(revokeRequests).toBe(0);
    expect(revoked.size).toBe(0);
    expect((await records.get(record.shareId))?.revokedAt).toBeUndefined();
  });

  it("reports the same code when a record has no link and the node refuses the current session key", async () => {
    const { link: _link, ...record } = await publishBearer(await sessionKey(), await sessionKey());
    const records = new MemorySenderShareRecordStorage();
    await records.put(record);
    activeSession = await sessionKey();

    await expect(revokeShare({ record, records, adapter: revocationAdapter() }))
      .rejects.toMatchObject({ code: "SHARE_ISSUER_KEY_UNAVAILABLE", exitCode: 5 });
    expect(revokeRequests).toBe(1);
    expect(revoked.size).toBe(0);
    expect((await records.get(record.shareId))?.revokedAt).toBeUndefined();
  });
});
