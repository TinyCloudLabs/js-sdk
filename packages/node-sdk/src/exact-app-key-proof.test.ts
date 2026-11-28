import { describe, expect, test } from "bun:test";
import {
  completeSessionSetup, makeSpaceId, prepareSession, signEthereumMessage, TCWSessionManager,
} from "@tinycloud/node-sdk-wasm";
import { withRecapCaveat } from "../../cli/src/auth/test-support/recap-caveat.js";
import {
  EXACT_APP_KEY_MAX_LIFETIME_MS, prepareExactAppKeyRequest, verifyExactAppKeyProof,
  type ExactAppKeyRequest, type PreparedExactAppKeyRequest,
} from "./exact-app-key-proof.js";

// Published disposable key; never holds funds or data.
const PRIVATE_KEY = "11".repeat(32);
const address = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
const ownerDid = `did:pkh:eip155:1:${address}`;
const networkId = `urn:tinycloud:encryption:${ownerDid}:default`;
const path = "apps/xyz.tinycloud.share/xyz.tinycloud.tinyapps.contacts/seal-v1";
const resource = `${networkId}/${path}`;
const abilities = ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"];
const hour = 3_600_000;
const spaceId = makeSpaceId(address, 1, "default");
const invalidScope = { ok: false, reason: "invalid_scope" };
const invalidProof = { ok: false, reason: "invalid_proof" };

interface Ticket extends PreparedExactAppKeyRequest { readonly siwe: string }

function ticket(lifetime = hour): Ticket {
  const built = prepareExactAppKeyRequest(path, ownerDid, lifetime);
  return { ...built, siwe: built.request.requestedSiwe };
}

/** Owner approval: sign exactly `siwe`, optionally after the owner (or an attacker) changed it. */
function approve(
  base: Ticket,
  edit: (siwe: string) => string = (siwe) => siwe,
  { chainId = 1 }: { chainId?: number } = {},
) {
  const siwe = edit(base.siwe);
  const signature = `0x${signEthereumMessage(siwe, PRIVATE_KEY).replace(/^0x/, "")}`;
  return { ...completeSessionSetup({ ...base.prepared, siwe, signature }), spaceId, address, chainId, siwe, signature };
}

function expiryOf(siwe: string): number {
  return Date.parse(/^Expiration Time: (.+)$/m.exec(siwe)![1]!);
}

function withExpiry(siwe: string, ms: number): string {
  return siwe.replace(/^Expiration Time: .+$/m, `Expiration Time: ${new Date(ms).toISOString()}`);
}

/** A signed grant with different resources than the one requested (domain and attribution kept). */
function approveOther(base: Ticket, rawAbilities: Record<string, string[]>, hasKv = false) {
  const prepared = prepareSession({
    abilities: hasKv ? { kv: { "": ["tinycloud.kv/get"] } } : {},
    rawAbilities,
    address, chainId: 1, domain: "share.tinycloud.xyz", spaceId, jwk: base.request.sessionKey,
    issuedAt: /^Issued At: (.+)$/m.exec(base.siwe)![1]!,
    expirationTime: /^Expiration Time: (.+)$/m.exec(base.siwe)![1]!,
  });
  const siwe = prepared.siwe.replace("\n\n", "\n\nTinyCloud CLI is requesting an app key. ");
  const signature = `0x${signEthereumMessage(siwe, PRIVATE_KEY).replace(/^0x/, "")}`;
  return { ...completeSessionSetup({ ...prepared, siwe, signature }), spaceId, address, chainId: 1, siwe, signature };
}

describe("CLI-built exact app-key request", () => {
  test("binds the Contacts key to the reversed-appId host and one ReCap resource", () => {
    const base = ticket();
    expect(base.appKey).toEqual({ appId: "xyz.tinycloud.share", key: "xyz.tinycloud.tinyapps.contacts/seal-v1" });
    expect(base.siwe.startsWith("share.tinycloud.xyz wants you to sign in with your Ethereum account:\n")).toBe(true);
    expect(base.siwe).toContain("\nTinyCloud CLI is requesting an app key. I further authorize ");
    expect(base.siwe.match(/urn:recap:/g)).toHaveLength(1);
    expect(base.siwe).not.toContain("tinycloud.kv");
    expect(base.prepared.spaceId).toBe(spaceId);
  });

  test("never lasts longer than seven days and takes only exact app keys", () => {
    expect(() => prepareExactAppKeyRequest(path, ownerDid, EXACT_APP_KEY_MAX_LIFETIME_MS + 1)).toThrow();
    expect(() => prepareExactAppKeyRequest(path, ownerDid, 0)).toThrow();
    for (const bad of ["apps/", "apps/xyz.tinycloud.share", "apps/xyz.tinycloud.share/", "apps/localhost/k",
      "apps/xyz.tinycloud.share/apps/xyz.tinycloud.share/k", "apps/1.2.3.4/k", "qa/key"]) {
      expect(() => prepareExactAppKeyRequest(bad, ownerDid, hour)).toThrow();
    }
    expect(() => prepareExactAppKeyRequest(path, "did:pkh:eip155:1:not-an-address", hour)).toThrow();
  });
});

describe("local exact app-key approval verification", () => {
  test.each([hour, EXACT_APP_KEY_MAX_LIFETIME_MS])("accepts the signed Contacts row for %d ms", (lifetime) => {
    const base = ticket(lifetime);
    expect(verifyExactAppKeyProof(base.request, approve(base))).toEqual({
      ok: true, resource, networkId, expiresAt: expect.any(String), sessionDid: expect.stringMatching(/^did:key:/),
    });
  });

  test("accepts an owner-shortened expiry and reports the shorter end", () => {
    const base = ticket(24 * hour);
    const shorter = expiryOf(base.siwe) - 23 * hour;
    const result = verifyExactAppKeyProof(base.request, approve(base, (siwe) => withExpiry(siwe, shorter)));
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && Date.parse(result.expiresAt)).toBe(shorter);
  });

  test("refuses an expiry later than requested, or changed by the signer after the request", () => {
    const base = ticket(hour);
    expect(verifyExactAppKeyProof(base.request, approve(base, (siwe) => withExpiry(siwe, expiryOf(siwe) + 1_000))))
      .toEqual({ ok: false, reason: "invalid_expiry" });
  });

  test.each([
    ["domain", (siwe: string) => siwe.replace("share.tinycloud.xyz", "cli.example.test")],
    ["statement attribution", (siwe: string) => siwe.replace("TinyCloud CLI is requesting an app key. ", "")],
    ["nonce", (siwe: string) => siwe.replace(/^Nonce: .+$/m, "Nonce: 0123456789ab")],
    ["request id", (siwe: string) => siwe.replace(/^Issued At: .+$/m, "Issued At: 2020-01-01T00:00:00.000Z")],
    ["not-before", (siwe: string) => siwe.replace(/^(Expiration Time: .+)$/m, "$1\nNot Before: 2020-01-01T00:00:00.000Z")],
  ])("refuses an approval that changed the signed %s", (_name, edit) => {
    const base = ticket();
    expect(verifyExactAppKeyProof(base.request, approve(base, edit)).ok).toBe(false);
  });

  test("does not accept a signed proof without explicit local opt-in", () => {
    const base = ticket();
    expect(verifyExactAppKeyProof({ ...base.request, optIn: false }, approve(base))).toEqual({ ok: false, reason: "not_opted_in" });
  });

  test("refuses a request whose key is not the signed exact app key", () => {
    const base = ticket();
    const proof = approve(base);
    for (const requestedPath of ["apps/", "apps/xyz.tinycloud.share", `${path}/`, `${path}/*`, "qa/key"]) {
      expect(verifyExactAppKeyProof({ ...base.request, path: requestedPath } as ExactAppKeyRequest, proof)).toEqual(invalidScope);
    }
  });

  test.each([
    `${resource}/`, `${resource}-sibling`, `${resource}/child`,
    resource.replace("xyz.tinycloud.share", "com.example.other"),
    resource.replace(":default/", ":other/"),
    resource.replace(address, address.toLowerCase()),
    networkId,
  ])("refuses signed authority for a different resource: %s", (signedResource) => {
    const base = ticket();
    expect(verifyExactAppKeyProof(base.request, approveOther(base, { [signedResource]: abilities }))).toEqual(invalidScope);
  });

  test("refuses signed extra authorities, even alongside the exact key", () => {
    const base = ticket();
    expect(verifyExactAppKeyProof(base.request, approveOther(base, { [resource]: abilities, [`${resource}-other`]: abilities }))).toEqual(invalidScope);
    expect(verifyExactAppKeyProof(base.request, approveOther(base, { [resource]: abilities, [networkId]: [abilities[0]!] }))).toEqual(invalidScope);
    expect(verifyExactAppKeyProof(base.request, approveOther(base, { [resource]: abilities }, true))).toEqual(invalidScope);
  });

  test("refuses missing, extra or caveated key abilities", () => {
    const base = ticket();
    for (const signedAbilities of [[abilities[0]!], [abilities[1]!], [...abilities, "tinycloud.encryption/key.block"]]) {
      expect(verifyExactAppKeyProof(base.request, approveOther(base, { [resource]: signedAbilities }))).toEqual(invalidScope);
    }
    expect(verifyExactAppKeyProof(base.request, approve(base, (siwe) => withRecapCaveat(siwe, { limit: 1 })))).toEqual(invalidScope);
  });

  test("refuses a different signed identity, even if the raw grant names the expected owner", () => {
    const base = ticket();
    expect(verifyExactAppKeyProof(base.request, approve(base, undefined, { chainId: 2 }))).toEqual(invalidProof);
  });

  test("refuses a substituted session key, header, CID or signature", () => {
    const base = ticket();
    const proof = approve(base);
    const other = approve(ticket(2 * hour));
    const wrongKey = JSON.parse(new TCWSessionManager().jwk("default")!);
    expect(verifyExactAppKeyProof({ ...base.request, sessionKey: wrongKey }, proof)).toEqual(invalidProof);
    expect(verifyExactAppKeyProof(base.request, { ...proof, delegationHeader: other.delegationHeader })).toEqual(invalidProof);
    expect(verifyExactAppKeyProof(base.request, { ...proof, delegationCid: other.delegationCid })).toEqual(invalidProof);
    expect(verifyExactAppKeyProof(base.request, { ...proof, signature: other.signature })).toEqual(invalidProof);
  });

  test("refuses expired authority", () => {
    const base = ticket();
    const result = verifyExactAppKeyProof(base.request, approve(base, (siwe) => withExpiry(siwe, Date.now() - 1_000)));
    expect(result.ok).toBe(false);
  });
});
