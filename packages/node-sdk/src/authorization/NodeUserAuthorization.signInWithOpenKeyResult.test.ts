// Tests for NodeUserAuthorization.signInWithOpenKeyResult.
//
// These tests exercise the trust-boundary validation that the SDK performs on
// an OpenKey authorization result before completing a TinyCloud session with
// the returned `signedMessage`. Every failure path here corresponds to a way
// a compromised or misbehaving OpenKey response could smuggle unauthorized
// capabilities into a signed-in session. The signature-verification step
// requires real ethereum signatures, so these tests use the real WASM stack
// (NodeWasmBindings + PrivateKeySigner) rather than a mock.

import { afterEach, beforeEach, expect, test } from "bun:test";

import { NodeUserAuthorization } from "./NodeUserAuthorization";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";
import { MemorySessionStorage } from "../storage/MemorySessionStorage";

// Route every /info and /delegate hit through a stub so signIn's follow-up
// activation flow does not try to reach a live TinyCloud node.
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/info")) {
      return new Response(
        JSON.stringify({ protocol: 1, version: "1.0.0", features: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return new Response(
        JSON.stringify({ activated: ["space"], skipped: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Fixed test key so signature verification is deterministic across runs.
const PRIVATE_KEY = "1".padStart(64, "0");

/**
 * Build a NodeUserAuthorization + a "prepared" SIWE it would present to
 * OpenKey. Returns the pieces callers need to simulate an OpenKey round trip
 * (call `signMessage` on `prepared.siwe` yourself to get a real signature).
 */
async function buildAuthWithPreparedSession() {
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(PRIVATE_KEY);
  const auth = new NodeUserAuthorization({
    signer,
    wasmBindings: wasm,
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
  });

  const preparation = await auth.prepareSessionForSigning();
  return { auth, signer, wasm, preparation };
}

test("signInWithOpenKeyResult accepts an unmodified signed prepared SIWE", async () => {
  const { auth, signer, preparation } = await buildAuthWithPreparedSession();
  const signature = await signer.signMessage(preparation.prepared.siwe);
  const address = await signer.getAddress();

  const clientSession = await auth.signInWithOpenKeyResult(
    {
      protocolVersion: 1,
      address,
      signature,
      signedMessage: preparation.prepared.siwe,
      selectedActionKeys: [],
      permissions: [],
    },
    {
      siwe: preparation.prepared.siwe,
      jwk: preparation.prepared.jwk,
      spaceId: preparation.prepared.spaceId,
      verificationMethod: preparation.prepared.verificationMethod,
    },
    preparation.keyId,
    preparation.prepared.jwk,
  );

  expect(clientSession.address).toBe(address);
});

test("signInWithOpenKeyResult rejects a signature from a different signer", async () => {
  const { auth, preparation } = await buildAuthWithPreparedSession();
  // Sign with a DIFFERENT key so signature -> recovered-address diverges from
  // the local signer.
  const attacker = new PrivateKeySigner("2".padStart(64, "0"));
  const attackerAddress = await attacker.getAddress();
  const attackerSignature = await attacker.signMessage(preparation.prepared.siwe);

  await expect(
    auth.signInWithOpenKeyResult(
      {
        protocolVersion: 1,
        address: attackerAddress,
        signature: attackerSignature,
        signedMessage: preparation.prepared.siwe,
        selectedActionKeys: [],
        permissions: [],
      },
      {
        siwe: preparation.prepared.siwe,
        jwk: preparation.prepared.jwk,
        spaceId: preparation.prepared.spaceId,
        verificationMethod: preparation.prepared.verificationMethod,
      },
      preparation.keyId,
      preparation.prepared.jwk,
    ),
  ).rejects.toThrow(/expected/);
});

test("signInWithOpenKeyResult rejects when signature does not verify against signedMessage", async () => {
  const { auth, signer, preparation } = await buildAuthWithPreparedSession();
  // Sign an entirely different string, then attach it to the real prepared
  // SIWE. Verification must fail because the signature does not correspond to
  // signedMessage's bytes.
  const forgedSignature = await signer.signMessage("something-totally-different");
  const address = await signer.getAddress();

  await expect(
    auth.signInWithOpenKeyResult(
      {
        protocolVersion: 1,
        address,
        signature: forgedSignature,
        signedMessage: preparation.prepared.siwe,
        selectedActionKeys: [],
        permissions: [],
      },
      {
        siwe: preparation.prepared.siwe,
        jwk: preparation.prepared.jwk,
        spaceId: preparation.prepared.spaceId,
        verificationMethod: preparation.prepared.verificationMethod,
      },
      preparation.keyId,
      preparation.prepared.jwk,
    ),
  ).rejects.toThrow(/verification failed|Signature does not match/i);
});

test("signInWithOpenKeyResult rejects when domain differs between prepared and signed", async () => {
  const { auth, signer, preparation } = await buildAuthWithPreparedSession();
  // Rewrite the first line ("example.com wants you to sign in ...") to a
  // different domain. This is the classic phishing scenario — a widget re-
  // signing on behalf of a different relying party.
  const tampered = preparation.prepared.siwe.replace(
    /^example\.com/,
    "attacker.example",
  );
  // Sign the tampered SIWE so we hit the immutable-fields diff rather than the
  // signature-verification path.
  const signature = await signer.signMessage(tampered);
  const address = await signer.getAddress();

  await expect(
    auth.signInWithOpenKeyResult(
      {
        protocolVersion: 1,
        address,
        signature,
        signedMessage: tampered,
        selectedActionKeys: [],
        permissions: [],
      },
      {
        siwe: preparation.prepared.siwe,
        jwk: preparation.prepared.jwk,
        spaceId: preparation.prepared.spaceId,
        verificationMethod: preparation.prepared.verificationMethod,
      },
      preparation.keyId,
      preparation.prepared.jwk,
    ),
  ).rejects.toThrow(/altered immutable SIWE fields.*domain/);
});

test("signInWithOpenKeyResult rejects when nonce differs between prepared and signed", async () => {
  const { auth, signer, preparation } = await buildAuthWithPreparedSession();
  const nonceLine = preparation.prepared.siwe
    .split("\n")
    .find((l) => l.startsWith("Nonce:"));
  expect(nonceLine).toBeDefined();
  const tampered = preparation.prepared.siwe.replace(
    nonceLine!,
    "Nonce: 0000000000000000",
  );
  const signature = await signer.signMessage(tampered);
  const address = await signer.getAddress();

  await expect(
    auth.signInWithOpenKeyResult(
      {
        protocolVersion: 1,
        address,
        signature,
        signedMessage: tampered,
        selectedActionKeys: [],
        permissions: [],
      },
      {
        siwe: preparation.prepared.siwe,
        jwk: preparation.prepared.jwk,
        spaceId: preparation.prepared.spaceId,
        verificationMethod: preparation.prepared.verificationMethod,
      },
      preparation.keyId,
      preparation.prepared.jwk,
    ),
  ).rejects.toThrow(/altered immutable SIWE fields.*nonce/);
});

test("signInWithOpenKeyResult rejects when signedMessage broadens capabilities", async () => {
  // Build the "original" prepared SIWE with a narrow ability set: kv/get only.
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(PRIVATE_KEY);
  const address = await signer.getAddress();
  const chainId = await signer.getChainId();
  const auth = new NodeUserAuthorization({
    signer,
    wasmBindings: wasm,
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
    // Narrow the ability map so the "signed" version can genuinely broaden it.
    defaultActions: {
      kv: { "": ["tinycloud.kv/get"] },
    },
  });
  const preparation = await auth.prepareSessionForSigning();

  // Now build a SECOND prepared SIWE (independent of the first) with a broader
  // ability map. We reuse everything except the abilities so all immutable
  // fields agree — the only material difference is the ReCap resource block.
  const now = new Date();
  const nonceMatch = preparation.prepared.siwe.match(/Nonce:\s*(.+)/);
  const issuedAtMatch = preparation.prepared.siwe.match(/Issued At:\s*(.+)/);
  const expiresAtMatch = preparation.prepared.siwe.match(/Expiration Time:\s*(.+)/);
  expect(nonceMatch && issuedAtMatch && expiresAtMatch).toBeTruthy();
  const broadenedPrepared = wasm.prepareSession({
    abilities: {
      kv: { "": ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del"] },
      sql: { "": ["tinycloud.sql/read", "tinycloud.sql/write"] },
    },
    address,
    chainId,
    domain: "example.com",
    issuedAt: issuedAtMatch![1],
    expirationTime: expiresAtMatch![1],
    spaceId: preparation.prepared.spaceId,
    jwk: preparation.prepared.jwk,
    nonce: nonceMatch![1],
  });
  const signature = await signer.signMessage(broadenedPrepared.siwe);

  await expect(
    auth.signInWithOpenKeyResult(
      {
        protocolVersion: 1,
        address,
        signature,
        signedMessage: broadenedPrepared.siwe,
        selectedActionKeys: [],
        permissions: [],
      },
      {
        siwe: preparation.prepared.siwe,
        jwk: preparation.prepared.jwk,
        spaceId: preparation.prepared.spaceId,
        verificationMethod: preparation.prepared.verificationMethod,
      },
      preparation.keyId,
      preparation.prepared.jwk,
    ),
  ).rejects.toThrow(/broadened authorization/);
});

test("signInWithOpenKeyResult accepts when signedMessage narrows capabilities", async () => {
  // Build with a broad default ability map, then generate a NARROWED signed
  // SIWE (fewer actions). This must be accepted — narrowing is exactly what
  // the OpenKey review flow is allowed to do.
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(PRIVATE_KEY);
  const address = await signer.getAddress();
  const chainId = await signer.getChainId();
  const auth = new NodeUserAuthorization({
    signer,
    wasmBindings: wasm,
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
    defaultActions: {
      kv: { "": ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del"] },
      sql: { "": ["tinycloud.sql/read", "tinycloud.sql/write"] },
    },
  });
  const preparation = await auth.prepareSessionForSigning();

  const nonceMatch = preparation.prepared.siwe.match(/Nonce:\s*(.+)/);
  const issuedAtMatch = preparation.prepared.siwe.match(/Issued At:\s*(.+)/);
  const expiresAtMatch = preparation.prepared.siwe.match(/Expiration Time:\s*(.+)/);
  expect(nonceMatch && issuedAtMatch && expiresAtMatch).toBeTruthy();
  const narrowedPrepared = wasm.prepareSession({
    abilities: {
      kv: { "": ["tinycloud.kv/get"] },
    },
    address,
    chainId,
    domain: "example.com",
    issuedAt: issuedAtMatch![1],
    expirationTime: expiresAtMatch![1],
    spaceId: preparation.prepared.spaceId,
    jwk: preparation.prepared.jwk,
    nonce: nonceMatch![1],
  });
  const signature = await signer.signMessage(narrowedPrepared.siwe);

  const clientSession = await auth.signInWithOpenKeyResult(
    {
      protocolVersion: 1,
      address,
      signature,
      signedMessage: narrowedPrepared.siwe,
      selectedActionKeys: [],
      permissions: [],
    },
    {
      siwe: preparation.prepared.siwe,
      jwk: preparation.prepared.jwk,
      spaceId: preparation.prepared.spaceId,
      verificationMethod: preparation.prepared.verificationMethod,
    },
    preparation.keyId,
    preparation.prepared.jwk,
  );

  expect(clientSession.address).toBe(address);
});

test("signInWithOpenKeyResult rejects an unsupported protocolVersion", async () => {
  const { auth, signer, preparation } = await buildAuthWithPreparedSession();
  const signature = await signer.signMessage(preparation.prepared.siwe);
  const address = await signer.getAddress();

  await expect(
    auth.signInWithOpenKeyResult(
      {
        // Cast: the runtime check exists precisely for this case even though
        // the type says it must be 1.
        protocolVersion: 2 as unknown as 1,
        address,
        signature,
        signedMessage: preparation.prepared.siwe,
        selectedActionKeys: [],
        permissions: [],
      },
      {
        siwe: preparation.prepared.siwe,
        jwk: preparation.prepared.jwk,
        spaceId: preparation.prepared.spaceId,
        verificationMethod: preparation.prepared.verificationMethod,
      },
      preparation.keyId,
      preparation.prepared.jwk,
    ),
  ).rejects.toThrow(/Unsupported OpenKey protocol version 2/);
});

test("signInWithOpenKeyResult rejects when prepared.siwe is missing", async () => {
  const { auth, signer, preparation } = await buildAuthWithPreparedSession();
  const signature = await signer.signMessage(preparation.prepared.siwe);
  const address = await signer.getAddress();

  await expect(
    auth.signInWithOpenKeyResult(
      {
        protocolVersion: 1,
        address,
        signature,
        signedMessage: preparation.prepared.siwe,
        selectedActionKeys: [],
        permissions: [],
      },
      {
        // Simulate a caller that skipped passing the reference SIWE. The
        // guard here catches that mistake before any signature work happens.
        siwe: "",
        jwk: preparation.prepared.jwk,
        spaceId: preparation.prepared.spaceId,
        verificationMethod: preparation.prepared.verificationMethod,
      },
      preparation.keyId,
      preparation.prepared.jwk,
    ),
  ).rejects.toThrow(/requires prepared\.siwe/);
});
