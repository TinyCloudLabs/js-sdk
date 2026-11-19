import { describe, expect, test } from "bun:test";
import { validateCredentialFlowDescriptor, validateCredentialHolderBinding, type CredentialRequirement } from "@tinycloud/sdk-core";
import { interpretCredentialFlow } from "./interpreter";
import { OpenCredentialsHttpTransport } from "./transport";
import type { CredentialAcquisitionTransport } from "./types";
import { vectors } from "./test-support/held-witness";

// TC-2254 A2.5: the exported low-level driver refuses an account-bound (held) descriptor unless it is constructed or called with
// `allowAccountSubject: true`, which only the email-proof functions pass, after the per-call opt-in was accepted. No request is made without it.
const held = validateCredentialFlowDescriptor(vectors.descriptor.held);
const binding = validateCredentialHolderBinding(vectors.happyPath.holder_binding.response.body.binding);
const HELD = "tinycloud.email-held/v1" as const;

const fetchSpy = () => {
  const seen = { fetched: 0 };
  const fetchFn = Object.assign(async () => { seen.fetched += 1; return new Response("{}"); }, { preconnect: () => {} }) as typeof globalThis.fetch;
  return { seen, fetchFn };
};
const requirement = { type: "TinyCloudCredentialRequirement", version: 1, profile: { id: HELD, version: 1 }, credentialType: { id: "opencredentials.email/v1", version: 1 }, claims: { email: "alice@example.com" } } as CredentialRequirement;
const base = (transport: CredentialAcquisitionTransport) => ({ descriptor: held, requirement, requestId: binding.requestId, verifier: "v", holderDid: binding.holderDid, descriptorDigest: binding.descriptorDigest, requirementDigest: binding.requirementDigest, openerOrigin: "https://localhost", expiresAt: binding.expiresAt, transport, signing: { autoSign: async () => new Uint8Array(65), holderKey: { alg: "EIP191" as const, kid: "k" } } });

describe("OpenCredentialsHttpTransport", () => {
  test("a held descriptor is refused at construction, with no request, unless allowAccountSubject is true", () => {
    const { seen, fetchFn } = fetchSpy();
    expect(() => new OpenCredentialsHttpTransport(held, fetchFn)).toThrow(expect.objectContaining({ code: "UNSUPPORTED_PROFILE" }));
    expect(() => new OpenCredentialsHttpTransport(held, fetchFn, { honorServerRecoverable: true })).toThrow(expect.objectContaining({ code: "UNSUPPORTED_PROFILE" }));
    expect(() => new OpenCredentialsHttpTransport(held, fetchFn, { allowAccountSubject: false } as never)).toThrow(expect.objectContaining({ code: "UNSUPPORTED_PROFILE" }));
    expect(() => new OpenCredentialsHttpTransport(held, fetchFn, { allowAccountSubject: true })).not.toThrow();
    expect(seen.fetched).toBe(0);
  });
});

describe("interpretCredentialFlow", () => {
  const stub = () => {
    const calls: string[] = [];
    const transport = new Proxy({}, { get: (_t, name) => async () => { calls.push(String(name)); throw new Error("stop"); } }) as unknown as CredentialAcquisitionTransport;
    return { calls, transport };
  };

  test("a held descriptor is refused before the first transport call unless allowAccountSubject is true", async () => {
    const { calls, transport } = stub();
    await expect(interpretCredentialFlow(base(transport))).rejects.toMatchObject({ code: "UNSUPPORTED_PROFILE" });
    await expect(interpretCredentialFlow({ ...base(transport), allowAccountSubject: false } as never)).rejects.toMatchObject({ code: "UNSUPPORTED_PROFILE" });
    expect(calls).toEqual([]);
  });

  test("with allowAccountSubject: true it proceeds to the transport", async () => {
    const { calls, transport } = stub();
    await expect(interpretCredentialFlow({ ...base(transport), allowAccountSubject: true })).rejects.toThrow("stop");
    expect(calls).toEqual(["state"]);
  });
});
