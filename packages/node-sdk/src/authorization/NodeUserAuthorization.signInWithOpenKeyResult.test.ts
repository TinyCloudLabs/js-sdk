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
import { extractRecapAttenuations } from "@tinycloud/sdk-core";

/**
 * Derive selectedActionKeys entries in the CANONICAL four-part OpenKey ID
 * format (`service\0space\0path\0ability`) that signInWithOpenKeyResult now
 * requires. This mirrors the real OpenKey `capability-review` `ids.actionId`
 * output; OpenKey never emits the legacy two-part shape.
 *
 * Structurally-required `tinycloud.capabilities/read` is intentionally
 * excluded because the widget UI cannot deselect it — the SDK does not
 * require it to appear in `selectedActionKeys` for Rule A coverage.
 */
function deriveSelectedActionKeysFromSiwe(siwe: string): string[] {
  const caps = extractRecapAttenuations(siwe);
  const out: string[] = [];
  for (const [resource, actions] of Object.entries(caps)) {
    // Split the resource URI into space + path the same way OpenKey does.
    let space = resource;
    let path = "";
    if (resource.startsWith("tinycloud:")) {
      const slash = resource.indexOf("/");
      if (slash >= 0) {
        space = resource.slice(0, slash);
        path = resource.slice(slash + 1);
      }
    }
    for (const ability of Object.keys(actions)) {
      if (ability === "tinycloud.capabilities/read" || ability === "capabilities/read") continue;
      const slashIdx = ability.indexOf("/");
      const service = slashIdx > 0 ? ability.slice(0, slashIdx) : "";
      out.push(`${service}\0${space}\0${path}\0${ability}`);
    }
  }
  return out;
}

/**
 * Legacy two-part encoder. Retained as a helper so the regression test
 * below can prove that the SDK now REJECTS this format — Sol continuation
 * contract requires canonical four-part IDs and forbids the two-part
 * fallback that historically resolved to unrelated authority when short
 * service names collided.
 */
function deriveLegacyTwoPartActionKeysFromSiwe(siwe: string): string[] {
  const caps = extractRecapAttenuations(siwe);
  const out: string[] = [];
  for (const [resource, actions] of Object.entries(caps)) {
    for (const action of Object.keys(actions)) {
      if (action === "tinycloud.capabilities/read" || action === "capabilities/read") continue;
      out.push(`${resource}\0${action}`);
    }
  }
  return out;
}

/**
 * Derive a `permissions` array matching the effective grants encoded in the
 * SIWE. Sol MAJOR-5 update: the SDK now requires permissions to equal the
 * signed authority for EVERY resource/action pair — INCLUDING structurally-
 * required capabilities like `tinycloud.capabilities/read`. Tests that used
 * to skip the required actions therefore need to include them here.
 */
function derivePermissionsFromSiwe(
  siwe: string,
): Array<{ service: string; space: string; path: string; actions: string[] }> {
  const caps = extractRecapAttenuations(siwe);
  const out: Array<{ service: string; space: string; path: string; actions: string[] }> = [];
  for (const [resource, actions] of Object.entries(caps)) {
    let space = resource;
    let path = "";
    if (resource.startsWith("tinycloud:")) {
      const slash = resource.indexOf("/");
      if (slash >= 0) {
        space = resource.slice(0, slash);
        path = resource.slice(slash + 1);
      }
    }
    const grouped = new Map<string, string[]>();
    for (const ability of Object.keys(actions)) {
      const slashIdx = ability.indexOf("/");
      const service = slashIdx > 0 ? ability.slice(0, slashIdx) : "";
      const list = grouped.get(service) ?? [];
      list.push(ability);
      grouped.set(service, list);
    }
    for (const [service, abilities] of grouped) {
      out.push({ service, space, path, actions: abilities });
    }
  }
  return out;
}

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

  const selectedActionKeys = deriveSelectedActionKeysFromSiwe(preparation.prepared.siwe);
  const permissions = derivePermissionsFromSiwe(preparation.prepared.siwe);

  const clientSession = await auth.signInWithOpenKeyResult(
    {
      protocolVersion: 1,
      address,
      signature,
      signedMessage: preparation.prepared.siwe,
      selectedActionKeys,
      permissions,
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

test("signInWithOpenKeyResult REJECTS empty selectedActionKeys when capabilities are present", async () => {
  // Sol MAJOR-3: previously, an OpenKey response could return empty
  // selectedActionKeys with a capability-bearing SIWE and be trusted. This
  // test locks in the new behaviour that requires selectedActionKeys to
  // cover every non-required capability in signedMessage.
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
        selectedActionKeys: [], // deliberately empty — capabilities not covered
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
  ).rejects.toThrow(/selectedActionKeys is missing entries/);
});

test("signInWithOpenKeyResult REJECTS permissions that claim actions not in signedMessage", async () => {
  // Sol MAJOR-3: the permissions array must not claim broader capabilities
  // than what signedCaps actually contains. A permissions entry with an
  // action not present in the signed SIWE is a wire-format tampering
  // attempt and must be rejected.
  const { auth, signer, preparation } = await buildAuthWithPreparedSession();
  const signature = await signer.signMessage(preparation.prepared.siwe);
  const address = await signer.getAddress();

  const selectedActionKeys = deriveSelectedActionKeysFromSiwe(preparation.prepared.siwe);

  await expect(
    auth.signInWithOpenKeyResult(
      {
        protocolVersion: 1,
        address,
        signature,
        signedMessage: preparation.prepared.siwe,
        selectedActionKeys,
        // Broader permission claim — a fictitious action not in the ReCap.
        permissions: [
          {
            service: "tinycloud.kv",
            space: preparation.prepared.spaceId,
            path: "",
            actions: ["tinycloud.kv/nuke-from-orbit"],
          },
        ],
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
  ).rejects.toThrow(/not present in signedMessage capabilities|not confirmed in signedMessage capabilities/);
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

  // selectedActionKeys must cover every non-required capability in the
  // NARROWED SIWE (which is what was actually signed).
  const selectedActionKeys = deriveSelectedActionKeysFromSiwe(narrowedPrepared.siwe);
  const permissions = derivePermissionsFromSiwe(narrowedPrepared.siwe);

  const clientSession = await auth.signInWithOpenKeyResult(
    {
      protocolVersion: 1,
      address,
      signature,
      signedMessage: narrowedPrepared.siwe,
      selectedActionKeys,
      permissions,
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

test("signInWithOpenKeyResult accepts real OpenKey four-part selectedActionKeys", async () => {
  // Sol continuation contract: OpenKey produces action IDs in the CANONICAL
  // four-part format `service\0space\0path\0ability`. This test proves the
  // SDK now accepts that format directly — without the historical two-part
  // suffix-match fallback. It is the primary regression guard against the
  // ID-format mismatch that caused the widget to approve narrow while
  // signing broad in the pre-consolidation code paths.
  const { auth, signer, preparation } = await buildAuthWithPreparedSession();
  const signature = await signer.signMessage(preparation.prepared.siwe);
  const address = await signer.getAddress();

  const selectedActionKeys = deriveSelectedActionKeysFromSiwe(preparation.prepared.siwe);
  const permissions = derivePermissionsFromSiwe(preparation.prepared.siwe);
  // Sanity: the helper must have produced FOUR-part IDs.
  expect(selectedActionKeys.length).toBeGreaterThan(0);
  for (const key of selectedActionKeys) {
    expect(key.split("\0").length).toBe(4);
  }

  const clientSession = await auth.signInWithOpenKeyResult(
    {
      protocolVersion: 1,
      address,
      signature,
      signedMessage: preparation.prepared.siwe,
      selectedActionKeys,
      permissions,
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

test("signInWithOpenKeyResult REJECTS legacy two-part selectedActionKeys", async () => {
  // Sol continuation contract: OpenKey emits ONLY the canonical four-part
  // `service\0space\0path\0ability` shape. The historical two-part
  // `resource\0action` fallback resolved by suffix match — which
  // silently accepted a rawKey that DIDN'T carry a validated service
  // namespace. Rejecting it closes that gap.
  const { auth, signer, preparation } = await buildAuthWithPreparedSession();
  const signature = await signer.signMessage(preparation.prepared.siwe);
  const address = await signer.getAddress();

  const legacyTwoPartKeys = deriveLegacyTwoPartActionKeysFromSiwe(preparation.prepared.siwe);
  const permissions = derivePermissionsFromSiwe(preparation.prepared.siwe);
  expect(legacyTwoPartKeys.length).toBeGreaterThan(0);
  for (const key of legacyTwoPartKeys) {
    expect(key.split("\0").length).toBe(2);
  }

  await expect(
    auth.signInWithOpenKeyResult(
      {
        protocolVersion: 1,
        address,
        signature,
        signedMessage: preparation.prepared.siwe,
        selectedActionKeys: legacyTwoPartKeys,
        permissions,
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
  ).rejects.toThrow(/malformed/);
});

test("signInWithOpenKeyResult rejects a three-part malformed selectedActionKey", async () => {
  // Sol continuation contract: neither 3-part nor 5+-part IDs are valid.
  // The SDK must fail closed rather than silently accepting a truncated ID.
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
        // 3-part is neither the 4-part canonical nor 2-part legacy format.
        selectedActionKeys: ["a\0b\0c"],
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
  ).rejects.toThrow(/malformed/);
});
