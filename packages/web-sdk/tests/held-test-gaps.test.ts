import { describe, expect, test } from "bun:test";
import { hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { validateCredentialFlowDescriptor, type CredentialRequirement, type IssuedCredentialEnvelope } from "@tinycloud/sdk-core";
import { EmailProofError } from "@tinycloud/node-sdk/credentials";
import { createAccountHolderSigner } from "../src/credentials/account-holder";
import { CredentialsService } from "../src/credentials/service";
import type { CredentialAcquisitionTransport, CredentialClient } from "../src/credentials/types";

// TC-2254 test-gap round (delta read of 4a8526532): signer field types and date formats, and verify with a caller-supplied transport.
const OWNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const ACCOUNT = `did:pkh:eip155:1:${OWNER.address}`;
const DOMAIN = "tinycloud.credentials/account-binding/v1";
const vectors = await Bun.file(new URL("../../node-sdk/src/credentials/fixtures/held-wire-v2.4/vectors.json", import.meta.url)).json();
const FIXED: Record<string, unknown> = vectors.holderProof.fixed.binding;

const jcs = (value: unknown): string => {
  const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v);
  return JSON.stringify(sort(value));
};
function wallet() {
  const calls = { count: 0 };
  const sign = async (bytes: Uint8Array): Promise<Uint8Array> => { calls.count += 1; return hexToBytes(await OWNER.signMessage({ message: new TextDecoder().decode(bytes) })); };
  return { sign, calls };
}
async function outcome(binding: Record<string, unknown>) {
  const { sign, calls } = wallet();
  try { await createAccountHolderSigner(ACCOUNT, sign).sign(new TextEncoder().encode(`${DOMAIN}\u0000${jcs(binding)}`)); } catch (error) { return { code: error instanceof EmailProofError ? error.code : error, wallet: calls.count }; }
  return { code: "signed", wallet: calls.count };
}

describe("the signer refuses a binding whose fields are not plain strings, even when the string inside is valid", () => {
  test("(c) a one-element array in a per-request field is refused with 0 wallet calls (a regex would coerce it to the string)", async () => {
    for (const field of ["requestId", "challengeNonce", "requirementDigest", "normalizedClaimsDigest", "issuedAt", "expiresAt", "jti"]) {
      expect([field, await outcome({ ...FIXED, [field]: [FIXED[field]] })]).toEqual([field, { code: "HOLDER_INVALID", wallet: 0 }]);
    }
  });
});

describe("the signer accepts one date format only, for issuedAt and expiresAt separately", () => {
  // The instants stay exactly 600 s apart, so only the format can refuse them.
  const cases: [string, Record<string, unknown>][] = [
    ["expiresAt with milliseconds", { expiresAt: "2026-08-03T01:10:00.000Z" }],
    ["expiresAt with a numeric offset", { expiresAt: "2026-08-03T02:10:00+01:00" }],
    ["expiresAt with a space instead of T", { expiresAt: "2026-08-03 01:10:00Z" }],
    ["expiresAt with a lowercase z", { expiresAt: "2026-08-03T01:10:00z" }],
    ["expiresAt without the zone", { expiresAt: "2026-08-03T01:10:00" }],
    ["issuedAt with a numeric offset", { issuedAt: "2026-08-03T02:00:00+01:00" }],
    ["issuedAt with a space instead of T", { issuedAt: "2026-08-03 01:00:00Z" }],
    ["issuedAt with a lowercase z", { issuedAt: "2026-08-03T01:00:00z" }],
  ];
  test("control: the fixed binding is signed", async () => {
    expect(await outcome(FIXED)).toEqual({ code: "signed", wallet: 1 });
  });
  for (const [name, patch] of cases) {
    test(`(d) ${name}: HOLDER_INVALID with 0 wallet calls`, async () => {
      expect([name, await outcome({ ...FIXED, ...patch })]).toEqual([name, { code: "HOLDER_INVALID", wallet: 0 }]);
    });
  }
});

describe("CredentialsService.verify refuses the held profile whatever transport it is given", () => {
  const held = validateCredentialFlowDescriptor(vectors.descriptor.held);
  const HOLDER = "did:key:z6MkehRgf7yJbgaGfYsdoAsKdBPE3dj2CYhowQdcjqSJgvVd";
  const requirement: CredentialRequirement = { type: "TinyCloudCredentialRequirement", version: 1, profile: { id: "tinycloud.email-held/v1", version: 1 }, credentialType: { id: "opencredentials.email/v1", version: 1 }, claims: { email: "alice@example.com" }, maxAgeSeconds: 31536000 };
  const client = (): CredentialClient => ({
    sessionDid: HOLDER, credentialHolderDid: HOLDER, credentialHolderKid: `${HOLDER}#${HOLDER.slice("did:key:".length)}`,
    session: () => ({}) as never, signSessionBytes: async () => new Uint8Array(64),
    ensureOwnedSpaceHosted: async () => "", credentialSpaceOwnerDid: () => "", kvForSpace: () => ({}) as never, accountAuthorizationCid: () => "",
  });

  test("(f) with a CALLER-SUPPLIED transport (no constructor refusal) and a held descriptor: UNSUPPORTED_PROFILE, the transport is never called", async () => {
    const calls: string[] = [];
    const transport = new Proxy({}, { get: (_t, name) => async () => { calls.push(String(name)); return {}; } }) as unknown as CredentialAcquisitionTransport;
    await expect(new CredentialsService(client()).verify({} as IssuedCredentialEnvelope, { descriptor: held, requirement, transport: transport as never })).rejects.toMatchObject({ code: "UNSUPPORTED_PROFILE" });
    expect(calls).toEqual([]);
  });
});
