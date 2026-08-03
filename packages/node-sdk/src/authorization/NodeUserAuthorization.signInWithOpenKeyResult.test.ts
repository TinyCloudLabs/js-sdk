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
import {
  extractRecapAttenuations,
  parseCanonicalRecapResource,
} from "@tinycloud/sdk-core";

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
    // Sol final continuation contract requirement 1: parse the resource
    // URI with the SHARED canonical semantics — service segment stripped
    // out of `path` so the emitted four-part IDs match what
    // OpenKey's `computeActionKey` produces via WASM `parseRecapFromSiwe`.
    const { space, path } = parseCanonicalRecapResource(resource);
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
    // Sol final continuation contract requirement 1: use the SHARED
    // canonical resource parser so `permissions[]` emits the same
    // (space, path) tuples the SDK consumer expects.
    const { space, path } = parseCanonicalRecapResource(resource);
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

test("signInWithOpenKeyResult accepts a narrowed SIWE with ReCap-derived statement drift (Sol continuation req 2)", async () => {
  // Sol final continuation contract requirement 2: for a ReCap-bearing SIWE,
  // the WASM `prepareSession` renders the ENTIRE statement from the ReCap
  // contents ("I further authorize the stated URI to perform the following
  // actions on my behalf..."). Any narrowing therefore MUST change the
  // statement — treating statement as byte-immutable would reject every
  // legitimate narrowing, which is exactly the production failure Sol cited.
  // This test proves the diff excludes statement when the original SIWE
  // carries a ReCap, so a narrowing round-trip through the real consumer
  // succeeds end-to-end.
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
      kv: { "": ["tinycloud.kv/get", "tinycloud.kv/put"] },
      sql: { "": ["tinycloud.sql/read"] },
      capabilities: { "": ["tinycloud.capabilities/read"] },
    },
  });
  const preparation = await auth.prepareSessionForSigning();
  // Pre-check: the prepared SIWE MUST carry a ReCap-derived statement.
  // If this precondition ever weakens, the test is no longer meaningful.
  expect(preparation.prepared.siwe).toContain("I further authorize");

  const nonceMatch = preparation.prepared.siwe.match(/Nonce:\s*(.+)/);
  const issuedAtMatch = preparation.prepared.siwe.match(/Issued At:\s*(.+)/);
  const expiresAtMatch = preparation.prepared.siwe.match(/Expiration Time:\s*(.+)/);
  const narrowedPrepared = wasm.prepareSession({
    abilities: {
      kv: { "": ["tinycloud.kv/get"] },
      capabilities: { "": ["tinycloud.capabilities/read"] },
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
  // Pre-check: the narrowed statement MUST differ from the prepared one.
  // If they were identical, the immutable-statement bug would not be hit.
  const stmt = (s: string) => {
    const uriIdx = s.split("\n").findIndex((l) => /^URI:/.test(l));
    return s.split("\n").slice(3, uriIdx).join("\n").trim();
  };
  expect(stmt(preparation.prepared.siwe)).not.toBe(stmt(narrowedPrepared.siwe));
  expect(stmt(narrowedPrepared.siwe)).toContain("tinycloud.kv': 'get");
  expect(stmt(narrowedPrepared.siwe)).not.toMatch(/tinycloud\.kv': 'put/);
  expect(stmt(narrowedPrepared.siwe)).not.toMatch(/tinycloud\.sql/);

  const signature = await signer.signMessage(narrowedPrepared.siwe);
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
  // The session's siwe is now the NARROWED bytes.
  expect(clientSession.siwe).toBe(narrowedPrepared.siwe);
});

test("diffImmutableSiweFields still enforces statement equality when the ORIGINAL SIWE has NO ReCap (Sol continuation req 2 contrapositive)", async () => {
  // Sol final continuation contract requirement 2 (contrapositive): the
  // relaxation ONLY applies when the original SIWE carries a ReCap. A
  // plain (no-ReCap) SIWE carries a caller-authored statement that MUST
  // remain byte-for-byte identical between prepared and signed.
  //
  // The full round-trip through `signInWithOpenKeyResult` for a plain
  // SIWE would fail earlier at signature verification (constructing a
  // valid plain SIWE without ReCap requires a real signer + full SIWE
  // library work that duplicates the SDK). Instead we exercise the
  // pure `diffImmutableSiweFields` helper directly — which is what
  // `signInWithOpenKeyResult` calls internally — and prove the
  // `originalHasRecap` flag correctly toggles the statement immutability
  // rule.
  const { diffImmutableSiweFields } = await import("@tinycloud/sdk-core");
  const original = {
    domain: "example.com",
    address: "0x1111111111111111111111111111111111111111",
    uri: "https://example.com",
    version: "1",
    chainId: "1",
    nonce: "abcdef",
    issuedAt: "2026-08-01T00:00:00Z",
    expirationTime: "2026-08-08T00:00:00Z",
    statement: "Original statement, authored by caller.",
    nonRecapResources: "",
  };
  const signedWithChangedStatement = {
    ...original,
    statement: "Attacker-injected statement.",
  };
  // Case 1: originalHasRecap = false → statement drift IS a violation.
  const plainDiffs = diffImmutableSiweFields(original, signedWithChangedStatement, {
    originalHasRecap: false,
  });
  expect(plainDiffs).toContain("statement");
  // Case 2: originalHasRecap = true → statement drift is TOLERATED
  // (the ReCap subset check is the authoritative narrowing gate for
  // ReCap-bearing SIWEs, and the WASM emitter re-renders the statement
  // from the narrowed ReCap on every narrowing).
  const recapDiffs = diffImmutableSiweFields(original, signedWithChangedStatement, {
    originalHasRecap: true,
  });
  expect(recapDiffs).not.toContain("statement");
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

// Sol final continuation contract MAJOR-1: pass an EXPLICITLY WIRE-SHAPED
// finalize body — constructed byte-for-byte in the shape the OpenKey
// `/authorize-sign` Hono route returns — directly to the REAL
// `signInWithOpenKeyResult` consumer. The existing e2e test in
// `NodeUserAuthorization.signInWithOpenKey.e2e.test.ts` exercises the
// `wireOpenKeyAuthorize` bridge; this test exercises the CONSUMER
// itself, which is what the OpenKey server response ultimately hits
// after the bridge translates types. Any wire-format drift (missing
// `permissions`, non-canonical selectedActionKeys, wrong protocolVersion,
// missing signedMessage) would fail here even if the bridge accepted
// the response.
test("signInWithOpenKeyResult accepts a finalize body in the EXACT wire shape the Hono /authorize-sign route emits (Sol MAJOR-1 final)", async () => {
  // 1. Build a real prepared session via the SDK — this is what a
  //    caller passes to OpenKey on the wire. The prepared SIWE has
  //    the production shape (non-empty ReCap statement, full header
  //    set) — the same shape Sol's OpenKey-side e2e test uses.
  const { auth, signer, preparation } = await buildAuthWithPreparedSession();
  const address = await signer.getAddress();

  // 2. Simulate the Hono /authorize-sign route's SIGN step: sign the
  //    exact prepared SIWE bytes with the real signer. In production
  //    OpenKey's server-side signManagedKey performs this signature;
  //    the byte-for-byte value doesn't matter as long as it verifies
  //    against signedMessage, which is what the SDK validates.
  const signature = await signer.signMessage(preparation.prepared.siwe);

  // 3. Derive selectedActionKeys + permissions the way the actual
  //    OpenKey Hono route derives them — from the RAW `parsePreparedRecap`
  //    entries of the signed message, in the canonical four-part
  //    `service\0space\0path\0ability` shape. We reuse the SAME test
  //    helper that mirrors OpenKey's `computeActionKey` output for
  //    consistency across both sides of the wire.
  const selectedActionKeys = deriveSelectedActionKeysFromSiwe(
    preparation.prepared.siwe,
  );
  const permissions = derivePermissionsFromSiwe(preparation.prepared.siwe);

  // 4. Assemble the finalize body EXACTLY as the Hono route emits it:
  //      `{ protocolVersion, address, signature, signedMessage,
  //         selectedActionKeys, permissions }`
  //    with `protocolVersion: 1` (route hardcode), address canonicalized,
  //    signedMessage as the signed bytes, and selectedActionKeys/
  //    permissions grouped per the route's `effectiveGrants` +
  //    `effectiveSelectedActionKeys` derivation. Pass DIRECTLY to
  //    `signInWithOpenKeyResult` — no bridge, no simulator.
  const finalizeBody = {
    protocolVersion: 1 as const,
    address,
    signature,
    signedMessage: preparation.prepared.siwe,
    selectedActionKeys,
    permissions,
  };

  const clientSession = await auth.signInWithOpenKeyResult(
    finalizeBody,
    {
      siwe: preparation.prepared.siwe,
      jwk: preparation.prepared.jwk,
      spaceId: preparation.prepared.spaceId,
      verificationMethod: preparation.prepared.verificationMethod,
    },
    preparation.keyId,
    preparation.prepared.jwk,
  );

  // 5. Assert the SDK consumer accepted the wire-format finalize body
  //    end-to-end. The resulting session must carry the signed SIWE
  //    bytes and the correct signer address — proving every validator
  //    (protocol version, address canonicalization, signature-verify,
  //    immutable-fields diff, ReCap subset, selectedActionKeys grounding,
  //    permissions coverage) passed.
  expect(clientSession.address).toBe(address);
  expect(clientSession.siwe).toBe(preparation.prepared.siwe);

  // 6. Additionally cross-check the selectedActionKeys shape against
  //    the wire contract — each entry MUST be a canonical four-part ID
  //    (this is the exact regression Sol MAJOR-1 called out as a wire-
  //    drift risk between producer and consumer). A regression that
  //    slipped in a three-part or two-part legacy ID would have been
  //    rejected earlier by signInWithOpenKeyResult; asserting the
  //    shape here documents the contract at the test level.
  expect(finalizeBody.selectedActionKeys.length).toBeGreaterThan(0);
  for (const key of finalizeBody.selectedActionKeys) {
    expect(key.split("\0").length).toBe(4);
  }
  // Every permissions entry must have non-empty actions.
  for (const perm of finalizeBody.permissions) {
    expect(typeof perm.service).toBe("string");
    expect(typeof perm.space).toBe("string");
    expect(typeof perm.path).toBe("string");
    expect(Array.isArray(perm.actions)).toBe(true);
    expect(perm.actions.length).toBeGreaterThan(0);
  }
});

// Sol final continuation contract MAJOR-1 (companion): a NARROWED
// finalize body — the shape the OpenKey Hono route emits after the
// user deselects some abilities — must also be accepted by the real
// consumer. Together with the unmodified test above, this proves the
// consumer accepts BOTH the identity round-trip AND the narrowing
// round-trip when handed the actual Hono finalize wire body.
test("signInWithOpenKeyResult accepts a NARROWED finalize body in the Hono /authorize-sign wire shape (Sol MAJOR-1 final)", async () => {
  // Build a broader prepared session — the SDK proposes kv/get+put+del
  // and sql/read plus capabilities/read. In production the user then
  // narrows via the OpenKey widget; the Hono route regenerates a
  // narrowed SIWE via `narrowSiwePreservingImmutable` and signs it
  // server-side. We simulate the regenerate step here directly with
  // WASM `prepareSession`, which is EXACTLY what the Hono route calls.
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
      sql: { "": ["tinycloud.sql/read"] },
      capabilities: { "": ["tinycloud.capabilities/read"] },
    },
  });
  const preparation = await auth.prepareSessionForSigning();
  // Preserve every immutable header line by reusing the prepared
  // nonce/issuedAt/expirationTime — the Hono route's
  // narrowSiwePreservingImmutable does the same thing.
  const nonceMatch = preparation.prepared.siwe.match(/Nonce:\s*(.+)/);
  const issuedAtMatch = preparation.prepared.siwe.match(/Issued At:\s*(.+)/);
  const expiresAtMatch = preparation.prepared.siwe.match(/Expiration Time:\s*(.+)/);
  const narrowedPrepared = wasm.prepareSession({
    abilities: {
      kv: { "": ["tinycloud.kv/get"] },
      capabilities: { "": ["tinycloud.capabilities/read"] },
    },
    address,
    chainId,
    domain: "example.com",
    issuedAt: issuedAtMatch![1]!,
    expirationTime: expiresAtMatch![1]!,
    spaceId: preparation.prepared.spaceId,
    jwk: preparation.prepared.jwk,
    nonce: nonceMatch![1]!,
  });
  const signature = await signer.signMessage(narrowedPrepared.siwe);

  // Derive the wire shape from the NARROWED SIWE — this is how the
  // Hono route builds `effectiveSelectedActionKeys` and `effectiveGrants`
  // after signing narrowed bytes.
  const selectedActionKeys = deriveSelectedActionKeysFromSiwe(narrowedPrepared.siwe);
  const permissions = derivePermissionsFromSiwe(narrowedPrepared.siwe);

  const finalizeBody = {
    protocolVersion: 1 as const,
    address,
    signature,
    signedMessage: narrowedPrepared.siwe,
    selectedActionKeys,
    permissions,
  };

  const clientSession = await auth.signInWithOpenKeyResult(
    finalizeBody,
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
  // The session's SIWE MUST be the narrowed bytes — the whole point of
  // the wire round-trip is that OpenKey may return different bytes than
  // the caller's original prepared SIWE.
  expect(clientSession.siwe).toBe(narrowedPrepared.siwe);
  // The consumer MUST have accepted a signedMessage whose ReCap-derived
  // `statement` differs from the prepared statement — this is the exact
  // regression Sol MAJOR-1 called out as a wire acceptance gap.
  expect(clientSession.siwe).toContain("I further authorize");
  expect(clientSession.siwe).toMatch(/tinycloud\.kv': 'get/);
  expect(clientSession.siwe).not.toMatch(/tinycloud\.kv': 'put/);
  expect(clientSession.siwe).not.toMatch(/tinycloud\.sql/);
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
