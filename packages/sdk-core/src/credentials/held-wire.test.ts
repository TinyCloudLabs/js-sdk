import { describe, expect, test } from "bun:test";
import { holderBindingCanonicalBytes, holderBindingSigningBytes, validateCredentialHolderBinding } from "./binding";
import { validateCredentialFlowDescriptor } from "./descriptor";
import { canonicalDigest, encodeBase64Url } from "./digest";
import { CredentialError } from "./errors";
import * as credentialTypes from "./types";
import { HOLDER_BINDING_DOMAIN } from "./types";
import { ACCOUNT_BINDING_DOMAIN } from "../held-credentials/rows";

// TC-2254 S7 and S8: the descriptor and the holder binding accept exactly two shapes, ticket and held account.
const vectors = await Bun.file(new URL("../../../node-sdk/src/credentials/fixtures/held-wire-v2.4/vectors.json", import.meta.url)).json();
const HELD_DESCRIPTOR: Record<string, any> = vectors.descriptor.held;
const HELD_DIGEST = "dc3_DuvzipXwYkTfjKqTaK1c3VS0YSPnaBsYSQriC0w";
const LIVE_BINDING: Record<string, unknown> = vectors.happyPath.holder_binding.response.body.binding;
const FIXED = vectors.holderProof.fixed;

const clone = <T>(value: T): T => structuredClone(value);
function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof CredentialError ? error.code : `other:${String(error)}`;
  }
  return "ok";
}
/** The ticket-shaped twin of the held descriptor: the five fields the contract lists differ. */
function ticketDescriptor(): Record<string, any> {
  const d = clone(HELD_DESCRIPTOR);
  d.profile = "tinycloud.email-proof/v1";
  d.claims = d.claims.filter((claim: { name: string }) => claim.name === "email");
  d.subjectRelationship = "holder_is_subject";
  d.holderBinding = { required: true, alg: "EdDSA", domain: HOLDER_BINDING_DOMAIN, version: 1 };
  return d;
}

describe("S7: the descriptor accepts exactly the ticket and the held shape", () => {
  test("the domain constant is the held-credentials account binding domain", () => {
    expect((credentialTypes as Record<string, unknown>).ACCOUNT_HOLDER_BINDING_DOMAIN).toBe(ACCOUNT_BINDING_DOMAIN);
  });

  test("the witness's held descriptor validates, keeps its bytes and has the pinned digest", async () => {
    const descriptor = validateCredentialFlowDescriptor(HELD_DESCRIPTOR);
    expect(descriptor.subjectRelationship).toBe("account_is_subject");
    expect(descriptor.holderBinding).toEqual({ required: true, alg: "EIP191", domain: ACCOUNT_BINDING_DOMAIN, version: 1 });
    expect(await canonicalDigest(descriptor)).toBe(HELD_DIGEST);
  });

  test("the ticket shape still validates", () => {
    expect(code(() => validateCredentialFlowDescriptor(ticketDescriptor()))).toBe("ok");
  });

  test("every mixed pair of subject relationship, algorithm and domain is refused as unsupported", () => {
    const mixes: [string, string, string][] = [
      ["account_is_subject", "EdDSA", HOLDER_BINDING_DOMAIN],
      ["account_is_subject", "EIP191", HOLDER_BINDING_DOMAIN],
      ["account_is_subject", "EdDSA", ACCOUNT_BINDING_DOMAIN],
      ["holder_is_subject", "EIP191", ACCOUNT_BINDING_DOMAIN],
      ["holder_is_subject", "EIP191", HOLDER_BINDING_DOMAIN],
      ["holder_is_subject", "EdDSA", ACCOUNT_BINDING_DOMAIN],
    ];
    for (const [subjectRelationship, alg, domain] of mixes) {
      const d = clone(HELD_DESCRIPTOR);
      d.subjectRelationship = subjectRelationship;
      d.holderBinding = { ...d.holderBinding, alg, domain };
      expect(code(() => validateCredentialFlowDescriptor(d))).toBe("UNSUPPORTED_PROFILE");
    }
  });

  test("an unknown subject relationship, algorithm or domain is refused", () => {
    for (const patch of [{ subjectRelationship: "anyone" }, { holderBinding: { ...HELD_DESCRIPTOR.holderBinding, alg: "ES256" } }, { holderBinding: { ...HELD_DESCRIPTOR.holderBinding, domain: "tinycloud.credentials/other/v1" } }]) {
      expect(code(() => validateCredentialFlowDescriptor({ ...clone(HELD_DESCRIPTOR), ...patch }))).toBe("UNSUPPORTED_PROFILE");
    }
  });
});

describe("S8: two explicit binding shapes keyed on type", () => {
  test("the witness's live account binding validates and its canonical bytes equal the witness's", () => {
    const binding = validateCredentialHolderBinding(LIVE_BINDING);
    expect(binding.type).toBe(ACCOUNT_BINDING_DOMAIN);
    const canonical = vectors.happyPath.holder_binding.response.body.canonical;
    expect(encodeBase64Url(holderBindingCanonicalBytes(binding))).toBe(canonical);
  });

  test("the signing bytes of the fixed account binding are the contract's signing input (account domain, NUL, JCS)", () => {
    const bytes = holderBindingSigningBytes(validateCredentialHolderBinding(FIXED.binding));
    expect(`0x${Buffer.from(bytes).toString("hex")}`).toBe(FIXED.signingInputHex);
    expect(new TextDecoder().decode(bytes)).toBe(`${ACCOUNT_BINDING_DOMAIN}\0${FIXED.canonicalJcs}`);
  });

  test("the ticket binding keeps its 19 fields and its holder-binding domain", () => {
    const ticket = {
      type: HOLDER_BINDING_DOMAIN, protocol: "tinycloud.credentials/acquisition/v1", requestId: "R".repeat(32), profile: "tinycloud.email-proof/v1", profileVersion: 1,
      descriptorDigest: "D".repeat(43), requirementDigest: "Q".repeat(43), issuer: "did:web:issuer.credentials.org", issuerKid: "did:web:issuer.credentials.org#controller",
      holderDid: "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH", normalizedClaimsDigest: "N".repeat(43), challengeNonce: "C".repeat(32), audience: "tinycloud://credentials",
      openerOrigin: "https://localhost", completionOrigin: "https://localhost", completionContext: "sdk-acquisition", jti: "J".repeat(32), issuedAt: "2030-01-01T00:00:00Z", expiresAt: "2030-01-01T00:10:00Z",
    };
    expect(code(() => validateCredentialHolderBinding(ticket))).toBe("ok");
    expect(new TextDecoder().decode(holderBindingSigningBytes(validateCredentialHolderBinding(ticket))).startsWith(`${HOLDER_BINDING_DOMAIN}\0`)).toBe(true);
    // A ticket binding that carries the account-only field, or a held one without it, is refused.
    expect(code(() => validateCredentialHolderBinding({ ...ticket, credentialLifetimeSeconds: 31536000 }))).toBe("REQUEST_SUBSTITUTED");
    expect(code(() => validateCredentialHolderBinding({ ...ticket, jti: "urn:uuid:25290ed4-6020-4355-804e-c90f5cb3f8d8" }))).toBe("REQUEST_SUBSTITUTED");
  });

  test("an account binding is refused for a wrong lifetime, a non-uuid or non-v4 jti, an extra, a missing or a re-typed field", () => {
    const bad: Record<string, unknown>[] = [
      { ...LIVE_BINDING, credentialLifetimeSeconds: 3600 },
      { ...LIVE_BINDING, credentialLifetimeSeconds: "31536000" },
      { ...LIVE_BINDING, jti: "JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ" },
      { ...LIVE_BINDING, jti: "urn:uuid:25290ed4-6020-1355-804e-c90f5cb3f8d8" },
      { ...LIVE_BINDING, jti: "urn:uuid:25290ED4-6020-4355-804e-c90f5cb3f8d8" },
      { ...LIVE_BINDING, extra: "x" },
      Object.fromEntries(Object.entries(LIVE_BINDING).filter(([key]) => key !== "credentialLifetimeSeconds")),
      Object.fromEntries(Object.entries(LIVE_BINDING).filter(([key]) => key !== "normalizedClaimsDigest")),
      { ...LIVE_BINDING, type: "tinycloud.credentials/other/v1" },
      { ...LIVE_BINDING, profileVersion: 2 },
      { ...LIVE_BINDING, protocol: "tinycloud.credentials/acquisition/v2" },
      { ...LIVE_BINDING, expiresAt: LIVE_BINDING.issuedAt },
    ];
    for (const value of bad) expect(code(() => validateCredentialHolderBinding(value))).not.toBe("ok");
  });

  test("a ticket-typed 20-field body and an account-typed 19-field body are both refused", () => {
    expect(code(() => validateCredentialHolderBinding({ ...LIVE_BINDING, type: HOLDER_BINDING_DOMAIN }))).toBe("REQUEST_SUBSTITUTED");
    const nineteen = Object.fromEntries(Object.entries(LIVE_BINDING).filter(([key]) => key !== "credentialLifetimeSeconds"));
    expect(code(() => validateCredentialHolderBinding(nineteen))).toBe("REQUEST_SUBSTITUTED");
  });
});
