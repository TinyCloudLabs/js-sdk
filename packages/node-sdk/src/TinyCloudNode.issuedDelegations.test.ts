import { afterEach, describe, expect, mock, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";

import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import "./replication/node-loader";
import { TinyCloudNode } from "./TinyCloudNode";
import { PROOF_PRIVATE_KEY, signedRestorableSession } from "./test-support/signed-restorable-session";
import { mintCompactDelegation } from "./test-support/compact-delegation";

const HOST = "https://issued.example";
const NODE_DID = "did:key:z6MkNodeFixtureOnly";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function claims(authorization: string) {
  const [header, payload, signature] = authorization.split(".");
  const body: { att: Record<string, Record<string, unknown[]>>; aud: string; iss: string; prf: string[] } =
    JSON.parse(Buffer.from(payload!, "base64url").toString());
  return { body, signed: new TextEncoder().encode(`${header}.${payload}`), signature: Buffer.from(signature!, "base64url") };
}

/** The 32-byte Ed25519 key a did:key encodes. */
function publicKeyOf(did: string): Uint8Array {
  return base58btc.decode(did.slice("did:key:".length)).slice(2);
}

describe("TinyCloudNode session-key invocations for issued delegations", () => {
  test("a restored session lists and revokes with its own did:key, proofless, addressed to the node", async () => {
    const seen: Array<{ url: string; authorization?: string; body?: string }> = [];
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, authorization: headers.get("authorization") ?? undefined, body: typeof init?.body === "string" ? init.body : undefined });
      if (url.endsWith("/info")) {
        return new Response(JSON.stringify({ nodeId: NODE_DID, features: ["delegation-issued-query-v1"] }), { status: 200 });
      }
      if (url.endsWith("/delegation/query")) {
        return new Response(JSON.stringify({ schemaVersion: 2, items: [] }), { status: 200 });
      }
      if (url.endsWith("/revoke")) return new Response(JSON.stringify({ revoked: true, cid: "bafy-issued" }), { status: 200 });
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const proof = await signedRestorableSession();
    const node = new TinyCloudNode({ signer: new PrivateKeySigner(PROOF_PRIVATE_KEY), wasmBindings: new NodeWasmBindings() });
    await node.restoreSession({ ...proof, tinycloudHosts: [HOST] });
    const sessionDid = node.credentialHolderDid;
    // A SIWE-backed (owner) session carries a verified wallet address; the CLI reads that to refuse the delegate path.
    expect(node.address).toBeDefined();

    expect((await node.delegationManager.query({ direction: "issued" })).ok).toBe(true);
    expect(await node.delegationManager.revokeIssued("bafy-issued")).toEqual({ ok: true, data: { revoked: true, cid: "bafy-issued" } });

    const list = seen.find((entry) => entry.url.endsWith("/delegation/query"))!;
    const revoke = seen.find((entry) => entry.url.endsWith("/revoke"))!;
    for (const [entry, att] of [
      [list, { [`${sessionDid}/delegation`]: { "tinycloud.delegation/list": [{}] } }],
      [revoke, { "urn:cid:bafy-issued": { "tinycloud.delegation/revoke": [{}] } }],
    ] as const) {
      const { body, signed, signature } = claims(entry.authorization!);
      expect(body.att).toEqual(att);
      expect(body.prf).toEqual([]);
      expect(body.iss.split("#")[0]).toBe(sessionDid);
      expect(body.aud).toBe(NODE_DID);
      expect(ed25519.verify(signature, signed, publicKeyOf(sessionDid))).toBe(true);
    }
    expect(JSON.parse(list.body!)).toEqual({ direction: "issued" });
  });

  test("a delegate session restored from a compact delegation has no owner address", async () => {
    const wasm = new NodeWasmBindings();
    const manager = wasm.createSessionManager();
    const delegateDid = manager.getDID("default").split("#", 1)[0]!;
    const imported = await mintCompactDelegation({ audience: delegateDid, expSecs: Math.floor(Date.now() / 1000) + 3_600, host: HOST });
    const node = new TinyCloudNode({ host: HOST, wasmBindings: wasm });

    await node.restoreSession({
      delegationHeader: imported.delegation.delegationHeader,
      delegationCid: imported.delegation.cid,
      spaceId: imported.spaceId,
      jwk: JSON.parse(manager.jwk("default")!),
      verificationMethod: delegateDid,
    });

    expect(node.address).toBeUndefined();
  });
});
