import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import { base58btc } from "multiformats/bases/base58";
import { CID } from "multiformats/cid";
import { decodeBase64Url, encodeBase64Url } from "../credentials/digest";
import { markDelegationTerminal, TERMINAL_DELEGATION_FACT } from "./terminal";

const encoder = new TextEncoder();

interface TestKey {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
  readonly did: string;
  readonly jwk: { kty: string; crv: string; x: string; d: string };
}

function sessionKey(): TestKey {
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  const did = `did:key:${base58btc.encode(Uint8Array.of(0xed, 0x01, ...publicKey))}`;
  return {
    publicKey,
    privateKey,
    did,
    jwk: { kty: "OKP", crv: "Ed25519", x: encodeBase64Url(publicKey), d: encodeBase64Url(privateKey) },
  };
}

/** A UCAN delegation shaped like the WASM builder's output, signed by `key`. */
function signedDelegation(key: TestKey, extra: Record<string, unknown> = {}): string {
  const header = { alg: "EdDSA", typ: "JWT", ucv: "0.10.0" };
  const payload = {
    iss: `${key.did}#${key.did.slice("did:key:".length)}`,
    aud: "did:key:z6MkpngR2AZoEn7LbbRjKFooctSQ1ViX4Fpo4N7x6SECz3MT",
    exp: 1_900_000_000,
    nnc: "urn:uuid:5b2d4f0e-8d7a-4b9e-9c1d-2f3a4b5c6d7e",
    prf: ["bafkr4ifbbvllkexgvlyf6o7zgcx7cr76dqkd6hqz57cqbhkqyoadhq5sgq"],
    att: { "tinycloud:pkh:eip155:1:0xabc:default/kv/docs/": { "tinycloud.kv/get": [{}] } },
    ...extra,
  };
  const input = [header, payload].map((part) => encodeBase64Url(encoder.encode(JSON.stringify(part)))).join(".");
  return `${input}.${encodeBase64Url(ed25519.sign(encoder.encode(input), key.privateKey))}`;
}

function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(token.split(".")[1]!)));
}

describe("markDelegationTerminal", () => {
  test("adds the node's terminal fact, keeps every other claim, and signs with the issuer key", () => {
    const key = sessionKey();
    const token = signedDelegation(key);
    const marked = markDelegationTerminal(token, key.jwk);

    const before = payloadOf(token);
    const after = payloadOf(marked.delegation);
    expect(after.fct).toEqual([{ "xyz.tinycloud.policy/delegationMode": "terminal" }]);
    expect({ ...after, fct: undefined }).toEqual({ ...before, fct: undefined });
    expect(marked.delegation.split(".")[0]).toBe(token.split(".")[0]);

    const [header, payload, signature] = marked.delegation.split(".");
    expect(ed25519.verify(decodeBase64Url(signature!), encoder.encode(`${header}.${payload}`), key.publicKey)).toBe(true);

    const cid = CID.parse(marked.cid);
    expect(cid.version).toBe(1);
    expect(cid.code).toBe(0x55);
    expect(cid.multihash.code).toBe(0x1e);
    expect(cid.multihash.digest).toEqual(blake3(encoder.encode(marked.delegation)));
  });

  test("appends after existing facts in order", () => {
    const key = sessionKey();
    const marked = markDelegationTerminal(signedDelegation(key, { fct: [{ a: 1 }, { b: 2 }] }), key.jwk);
    expect(payloadOf(marked.delegation).fct).toEqual([{ a: 1 }, { b: 2 }, TERMINAL_DELEGATION_FACT]);
  });

  test("is idempotent: a token that already carries the fact comes back unchanged with its own CID", () => {
    const key = sessionKey();
    const once = markDelegationTerminal(signedDelegation(key, { fct: [{ a: 1 }] }), key.jwk);
    const twice = markDelegationTerminal(once.delegation, key.jwk);
    expect(twice).toEqual(once);
    expect(payloadOf(twice.delegation).fct).toEqual([{ a: 1 }, TERMINAL_DELEGATION_FACT]);

    const preMarked = signedDelegation(key, { fct: [TERMINAL_DELEGATION_FACT, { a: 1 }] });
    expect(markDelegationTerminal(preMarked, key.jwk).delegation).toBe(preMarked);
  });

  test("refuses a key that is not the token's issuer", () => {
    const issuer = sessionKey();
    const other = sessionKey();
    expect(() => markDelegationTerminal(signedDelegation(issuer), other.jwk))
      .toThrow("session key is not the delegation issuer");
  });

  test("refuses non-Ed25519 keys and malformed facts", () => {
    const key = sessionKey();
    const token = signedDelegation(key);
    expect(() => markDelegationTerminal(token, { kty: "EC", crv: "P-256", d: key.jwk.d }))
      .toThrow("terminal delegations require an Ed25519 session key");
    expect(() => markDelegationTerminal(token, { kty: "OKP", crv: "Ed25519" }))
      .toThrow("terminal delegations require an Ed25519 session key");
    expect(() => markDelegationTerminal(signedDelegation(key, { fct: { a: 1 } }), key.jwk))
      .toThrow("delegation facts are not an array");
  });
});
