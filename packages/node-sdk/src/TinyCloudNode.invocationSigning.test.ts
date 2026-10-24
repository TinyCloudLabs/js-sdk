/**
 * Invocation signing consistency (TC-1910): every invocation token's
 * signature verifies under its own `iss`, and `iss`/`prf` name the session
 * that signed it, including audience-bound encryption network invocations
 * built under a runtime grant's session.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { describe, expect, test, afterAll } from "bun:test";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { base58btc } from "multiformats/bases/base58";

import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { TinyCloudNode } from "./TinyCloudNode";

// Never touch a real home: point HOME and tool homes at a throwaway dir first.
const tc1910Home = mkdtempSync("/var/tmp/tc1910.");
if (!tc1910Home.startsWith("/var/tmp/tc1910.")) throw new Error("test home guard failed");
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "COURIER_HOME", "TC_HOME"]) {
  process.env[name] = tc1910Home;
}
afterAll(() => rmSync(tc1910Home, { recursive: true, force: true }));


const KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f";
const NODE_DID = "did:key:z6MkNodeUnderTest111111111111111111111111111";

const b64u = (value: string) => Buffer.from(value, "base64url");

function decode(token: string) {
  const [header, payload, signature] = token.split(".");
  return {
    signingInput: `${header}.${payload}`,
    signature: b64u(signature),
    payload: JSON.parse(b64u(payload).toString()) as {
      iss: string;
      aud: string;
      prf: string[];
    },
  };
}

/** Verify the EdDSA signature against the raw key encoded in the `iss` did:key. */
function verifiesUnderIssuer(token: string): boolean {
  const { signingInput, signature, payload } = decode(token);
  const multibase = payload.iss.split("#", 1)[0].slice("did:key:".length);
  const bytes = base58btc.decode(multibase);
  expect([bytes[0], bytes[1]]).toEqual([0xed, 0x01]);
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(bytes.slice(2)).toString("base64url") },
    format: "jwk",
  });
  return verify(null, Buffer.from(signingInput), key, signature);
}

async function setup() {
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(KEY);
  const address = await signer.getAddress();
  const chainId = await signer.getChainId();
  const spaceId = wasm.makeSpaceId(address, chainId, "default");
  const networkId = `urn:tinycloud:encryption:did:pkh:eip155:${chainId}:${address}:default`;
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();

  const mint = async (input: { abilities: object; rawAbilities?: object }) => {
    const jwk = JSON.parse(wasm.createSessionManager().jwk("default")!);
    const prepared = wasm.prepareSession({
      ...input,
      address,
      chainId,
      domain: "tinycloud.test",
      issuedAt: new Date().toISOString(),
      expirationTime: expiresAt,
      spaceId,
      jwk,
    } as any);
    const signature = await signer.signMessage(prepared.siwe);
    const done = wasm.completeSessionSetup({ ...prepared, signature });
    return {
      delegationHeader: done.delegationHeader,
      delegationCid: done.delegationCid,
      spaceId,
      jwk,
      verificationMethod: done.verificationMethod,
      address,
      chainId,
      siwe: prepared.siwe,
      signature,
      expiresAt,
    };
  };

  const base = await mint({
    abilities: {
      kv: { "": ["tinycloud.kv/get"] },
      sql: { "": ["tinycloud.sql/read"] },
    },
  });
  const node = new TinyCloudNode({ host: "http://127.0.0.1:1", signer, wasmBindings: wasm });
  await node.restoreSession(base as any);
  return { wasm, node, base, mint, networkId, spaceId };
}

const CREATE = "tinycloud.encryption/network.create";
const DECRYPT = "tinycloud.encryption/decrypt";

function networkInput(networkId: string, action: string) {
  return { targetNode: NODE_DID, networkId, action, facts: { type: "test", networkId } };
}

function expectConsistent(token: string, session: { verificationMethod: string; delegationCid: string }) {
  const { payload } = decode(token);
  expect(payload.iss.split("#", 1)[0]).toBe(session.verificationMethod.split("#", 1)[0]);
  expect(payload.prf).toEqual([session.delegationCid]);
  expect(verifiesUnderIssuer(token)).toBe(true);
}

describe("invocation signing consistency (TC-1910)", () => {
  test("plain sign-in: kv, sql and encryption invocations verify under their iss and prf", async () => {
    const { node, base, networkId, spaceId } = await setup();
    for (const [service, action] of [["kv", "tinycloud.kv/get"], ["sql", "tinycloud.sql/read"]]) {
      const headers = (node as any).invokeAnyWithRuntimePermissions(
        base,
        [{ spaceId, service, path: "", action }],
        [{}],
      );
      expectConsistent(headers.Authorization, base);
    }
    for (const action of [CREATE, DECRYPT]) {
      const signed = await (node as any).signRawNetworkAuthorization(networkInput(networkId, action), {
        graph: { assertActive() {} },
        session: base,
      });
      expectConsistent(signed.authorization, base);
      expect(decode(signed.authorization).payload.aud).toBe(NODE_DID);
    }
  });

  test("manifest without an encryption entry (non-primary grant covers the network): network create and decrypt are signed by the grant session", async () => {
    const { node, base, mint, networkId, spaceId } = await setup();
    const grantSession = await mint({
      abilities: {},
      rawAbilities: { [networkId]: [CREATE, DECRYPT] },
    });
    expect(grantSession.verificationMethod).not.toBe(base.verificationMethod);
    (node as any).runtimePermissionGrants.push({
      session: grantSession,
      delegation: { cid: grantSession.delegationCid },
      operations: [CREATE, DECRYPT].map((action) => ({
        resource: networkId,
        service: "encryption",
        path: networkId,
        action,
      })),
      expiresAt: new Date(Date.now() + 30 * 60_000),
      provenance: "runtime",
    });

    for (const action of [CREATE, DECRYPT]) {
      const signed = await (node as any).signRawNetworkAuthorization(networkInput(networkId, action), {
        graph: { assertActive() {} },
        session: base,
      });
      expectConsistent(signed.authorization, grantSession);
      expect(decode(signed.authorization).payload.aud).toBe(NODE_DID);
    }

    // The public audience binder must also keep key, iss and prf together.
    const headers = (node as any).invokeAnyWithRuntimePermissions(
      base,
      [{ resource: networkId, service: "encryption", path: networkId, action: CREATE }],
      [{}],
    );
    const bound = await node.bindInvocationAudience(headers.Authorization, NODE_DID);
    expectConsistent(bound, grantSession);

    // Non-network invocations still come from the base session.
    const kv = (node as any).invokeAnyWithRuntimePermissions(
      base,
      [{ spaceId, service: "kv", path: "", action: "tinycloud.kv/get" }],
      [{}],
    );
    expectConsistent(kv.Authorization, base);
  });

  test("primary session covering the network op stays consistent", async () => {
    const { node, mint, networkId, wasm } = await setup();
    const primary = await mint({
      abilities: { kv: { "": ["tinycloud.kv/get"] } },
      rawAbilities: { [networkId]: [CREATE, DECRYPT] },
    });
    const owner = new TinyCloudNode({
      host: "http://127.0.0.1:1",
      signer: new PrivateKeySigner(KEY),
      wasmBindings: wasm,
    });
    await owner.restoreSession(primary as any);
    expect(node).toBeDefined();
    for (const action of [CREATE, DECRYPT]) {
      const signed = await (owner as any).signRawNetworkAuthorization(networkInput(networkId, action), {
        graph: { assertActive() {} },
        session: primary,
      });
      expectConsistent(signed.authorization, primary);
    }
  });

  test("oracle: re-signing a grant-session token with the base key fails verification", async () => {
    const { node, base, mint, networkId } = await setup();
    const grantSession = await mint({ abilities: {}, rawAbilities: { [networkId]: [CREATE] } });
    const headers = (node as any).wasmBindings.invokeAny(
      grantSession,
      [{ resource: networkId, service: "encryption", path: networkId, action: CREATE }],
      [{}],
    );
    const [h, p] = String(headers.Authorization).split(".");
    const forged = `${h}.${p}.${sign(null, Buffer.from(`${h}.${p}`), createPrivateKey({ key: base.jwk, format: "jwk" })).toString("base64url")}`;
    expect(verifiesUnderIssuer(headers.Authorization)).toBe(true);
    expect(verifiesUnderIssuer(forged)).toBe(false);
  });

  test("bindInvocationAudience with a grant held: a base-issued token is re-signed with the base key", async () => {
    const { node, base, mint, networkId, spaceId } = await setup();
    const grantSession = await mint({ abilities: {}, rawAbilities: { [networkId]: [CREATE] } });
    (node as any).runtimePermissionGrants.push({
      session: grantSession,
      delegation: { cid: grantSession.delegationCid },
      operations: [{ resource: networkId, service: "encryption", path: networkId, action: CREATE }],
      expiresAt: new Date(Date.now() + 30 * 60_000),
      provenance: "runtime",
    });
    const headers = (node as any).invokeAnyWithRuntimePermissions(
      base,
      [{ spaceId, service: "kv", path: "", action: "tinycloud.kv/get" }],
      [{}],
    );
    const bound = await node.bindInvocationAudience(headers.Authorization, NODE_DID);
    expectConsistent(bound, base);
    expect(decode(bound).payload.aud).toBe(NODE_DID);
  });

  test("bindInvocationAudience rejects a token whose issuer is not a held session", async () => {
    const { node, mint, networkId } = await setup();
    const stranger = await mint({ abilities: {}, rawAbilities: { [networkId]: [CREATE] } });
    const headers = (node as any).wasmBindings.invokeAny(
      stranger,
      [{ resource: networkId, service: "encryption", path: networkId, action: CREATE }],
      [{}],
    );
    await expect(node.bindInvocationAudience(headers.Authorization, NODE_DID)).rejects.toThrow(
      "invocation issuer does not match a held session",
    );
  });

  describe("decrypt 404 advice", () => {
    async function postDecryptTo(networkIdOf: (own: string) => string, body: string) {
      const { node, base, networkId } = await setup();
      const graph = {
        assertActive() {},
        fetch: async () => new Response(body, { status: 404 }),
      };
      const service = (node as any).createEncryptionService({
        graph,
        host: "http://127.0.0.1:1",
        session: base,
        did: node.did,
        address: base.address,
        chainId: 1,
      });
      return service._config.transport
        .postDecrypt({ targetNode: NODE_DID, networkId: networkIdOf(networkId), authorization: "a", canonicalBody: "{}" })
        .then(() => undefined, (error: any) => error);
    }

    test("the signed-in owner's default network carries the sign-in-again advice", async () => {
      const error = await postDecryptTo((own) => own, "network not found");
      expect(error.status).toBe(404);
      expect(error.notFoundMessage).toEndWith(
        "Sign in again with a current SDK to create the account's encryption network.",
      );
    });

    test("a named network and another owner's network carry no advice", async () => {
      const named = await postDecryptTo((own) => own.replace(":default", ":other"), "network not found");
      expect(named.status).toBe(404);
      expect(named.notFoundMessage).toBeUndefined();
      const foreign = await postDecryptTo(
        (own) => own.replace(/eip155:1:0x[0-9a-fA-F]{40}/, "eip155:1:0x00000000000000000000000000000000000000aa"),
        "network not found",
      );
      expect(foreign.status).toBe(404);
      expect(foreign.notFoundMessage).toBeUndefined();
      const odd = await postDecryptTo((own) => own, "something else");
      expect(odd.notFoundMessage).toBeUndefined();
    });
  });
});
