import { describe, expect, test } from "bun:test";
import { canonicalDigest, createEmailCredentialRequirement, validateCredentialFlowDescriptor, type CredentialRequirement, type IssuedCredentialEnvelope } from "@tinycloud/sdk-core";
import { CredentialsService } from "../src/credentials/service";
import type { CredentialAcquisitionTransport, CredentialClient } from "../src/credentials/types";

// TC-2254 A2.5: the web root CredentialsService (acquire, ensure, verify) refuses a held requirement or an account_is_subject descriptor with
// UNSUPPORTED_PROFILE before any witness call: no catalog read, no transport call. The held profile is acquired through acquireHeldCredential only.
const vectors = await Bun.file(new URL("../../node-sdk/src/credentials/fixtures/held-wire-v2.4/vectors.json", import.meta.url)).json();
const goldens = (await Bun.file(new URL("../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url)).json()) as { vectors: { name: string; descriptor: unknown }[] };
const held = validateCredentialFlowDescriptor(vectors.descriptor.held);
const ticket = validateCredentialFlowDescriptor(goldens.vectors.find((v) => v.name === "email")!.descriptor);
const HOLDER = "did:key:z6MkehRgf7yJbgaGfYsdoAsKdBPE3dj2CYhowQdcjqSJgvVd";
const heldRequirement: CredentialRequirement = { type: "TinyCloudCredentialRequirement", version: 1, profile: { id: "tinycloud.email-held/v1", version: 1 }, credentialType: { id: "opencredentials.email/v1", version: 1 }, claims: { email: "alice@example.com" }, maxAgeSeconds: 31536000 };
const DISCOVERY = "https://witness.credentials.org/.well-known/opencredentials";

function client(): CredentialClient {
  return {
    sessionDid: HOLDER, credentialHolderDid: HOLDER, credentialHolderKid: `${HOLDER}#${HOLDER.slice("did:key:".length)}`,
    session: () => ({}) as never, signSessionBytes: async () => new Uint8Array(64),
    ensureOwnedSpaceHosted: async () => "", credentialSpaceOwnerDid: () => "", kvForSpace: () => ({}) as never, accountAuthorizationCid: () => "",
  };
}
function spies(catalog?: unknown) {
  const seen = { fetch: 0, transport: [] as string[] };
  const fetch = Object.assign(async () => { seen.fetch += 1; return new Response(JSON.stringify(catalog ?? {}), { headers: { "content-type": "application/json" } }); }, { preconnect: () => {} }) as typeof globalThis.fetch;
  const transport = new Proxy({}, { get: (_t, name) => async () => { seen.transport.push(String(name)); throw new Error("stop"); } }) as unknown as CredentialAcquisitionTransport;
  return { seen, fetch, transport };
}
const common = (s: ReturnType<typeof spies>) => ({ interaction: "headless" as const, inputs: { email: "alice@example.com" }, openerOrigin: "https://share.example", fetch: s.fetch, transport: s.transport });

describe("CredentialsService refuses the held profile before any witness call", () => {
  for (const method of ["acquire", "ensure"] as const) {
    const call = (s: ReturnType<typeof spies>, requirement: CredentialRequirement, extra: Record<string, unknown>) => (new CredentialsService(client()) as unknown as Record<string, (r: CredentialRequirement, o: unknown) => Promise<unknown>>)[method]!(requirement, { ...common(s), ...extra });

    test(`${method} with a pinned held descriptor: UNSUPPORTED_PROFILE, no fetch, no transport call`, async () => {
      const s = spies();
      await expect(call(s, heldRequirement, { descriptor: held })).rejects.toMatchObject({ code: "UNSUPPORTED_PROFILE" });
      expect(s.seen).toEqual({ fetch: 0, transport: [] });
    });

    test(`${method} with a pinned held descriptor for a requirement that does not name the held profile: refused as well`, async () => {
      const s = spies();
      const sneaky = { ...heldRequirement, profile: { id: ticket.profile, version: 1 } } as CredentialRequirement;
      await expect(call(s, sneaky, { descriptor: held })).rejects.toMatchObject({ code: "UNSUPPORTED_PROFILE" });
      expect(s.seen).toEqual({ fetch: 0, transport: [] });
    });

    test(`${method} through discovery for a held requirement: refused before the catalog is read`, async () => {
      const s = spies();
      await expect(call(s, heldRequirement, { discoveryUrl: DISCOVERY })).rejects.toMatchObject({ code: "UNSUPPORTED_PROFILE" });
      expect(s.seen).toEqual({ fetch: 0, transport: [] });
    });
  }

  test("verify with a held descriptor: UNSUPPORTED_PROFILE, no fetch", async () => {
    const s = spies();
    await expect(new CredentialsService(client()).verify({} as IssuedCredentialEnvelope, { descriptor: held, requirement: heldRequirement, fetch: s.fetch })).rejects.toMatchObject({ code: "UNSUPPORTED_PROFILE" });
    expect(s.seen.fetch).toBe(0);
  });

  test("control: a ticket requirement against a catalog that lists the held entry first still resolves the ticket entry", async () => {
    const entry = async (descriptor: unknown) => ({ supported: true, enabled: true, readiness: "ready", descriptor, descriptorDigest: await canonicalDigest(validateCredentialFlowDescriptor(descriptor)) });
    const catalog = { type: "tinycloud.credentials/catalog/v1", protocol: "tinycloud.credentials/acquisition/v1", catalogVersion: 1, profiles: [await entry(vectors.descriptor.held), await entry(goldens.vectors.find((v) => v.name === "email")!.descriptor)] };
    const s = spies(catalog);
    const requirement = createEmailCredentialRequirement({ email: "alice@example.com", profile: { id: ticket.profile, version: 1 }, credentialType: { id: ticket.format.vct, version: 1 } });
    await expect(new CredentialsService(client()).acquire(requirement, { ...common(s), discoveryUrl: DISCOVERY })).rejects.toBeDefined();
    expect(s.seen.fetch).toBe(1);
    expect(s.seen.transport[0]).toBe("create");
  });
});
