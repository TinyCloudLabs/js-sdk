import { describe, expect, test } from "bun:test";
import { validateCredentialFlowDescriptor, type CredentialRequirement } from "@tinycloud/sdk-core";
import { CredentialsService } from "../src/credentials/service";
import type { CredentialAcquisitionTransport, CredentialClient } from "../src/credentials/types";

// TC-2254 C8.3 (1), ruled by the contract owner: the web root CredentialsService (acquire and ensure) refuses the held profile without the
// explicit per-call opt-in, BEFORE any network call: no catalog read, no transport call. The held profile is for `acquireHeldCredential`.
const vectors = await Bun.file(new URL("../../node-sdk/src/credentials/fixtures/held-wire-v2.4/vectors.json", import.meta.url)).json();
const held = validateCredentialFlowDescriptor(vectors.descriptor.held);
const HOLDER = "did:key:z6MkehRgf7yJbgaGfYsdoAsKdBPE3dj2CYhowQdcjqSJgvVd";
const requirement: CredentialRequirement = { type: "TinyCloudCredentialRequirement", version: 1, profile: { id: "tinycloud.email-held/v1", version: 1 }, credentialType: { id: "opencredentials.email/v1", version: 1 }, claims: { email: "alice@example.com" }, maxAgeSeconds: 31536000 };

function client(): CredentialClient {
  return {
    sessionDid: HOLDER, credentialHolderDid: HOLDER, credentialHolderKid: `${HOLDER}#${HOLDER.slice("did:key:".length)}`,
    session: () => ({}) as never, signSessionBytes: async () => new Uint8Array(64),
    ensureOwnedSpaceHosted: async () => "", credentialSpaceOwnerDid: () => "", kvForSpace: () => ({}) as never, accountAuthorizationCid: () => "",
  };
}
function spies() {
  const seen = { fetch: 0, transport: [] as string[] };
  const fetch = Object.assign(async () => { seen.fetch += 1; return new Response("{}"); }, { preconnect: () => {} }) as typeof globalThis.fetch;
  const transport = new Proxy({}, { get: (_t, name) => async () => { seen.transport.push(String(name)); throw new Error("stop"); } }) as unknown as CredentialAcquisitionTransport;
  return { seen, fetch, transport };
}
const base = (s: ReturnType<typeof spies>) => ({ interaction: "headless" as const, inputs: { email: "alice@example.com" }, openerOrigin: "https://share.example", fetch: s.fetch, transport: s.transport });

describe("CredentialsService refuses the held profile without the opt-in, before any network call", () => {
  for (const method of ["acquire", "ensure"] as const) {
    test(`${method} with a pinned held descriptor: UNSUPPORTED_PROFILE, no fetch, no transport call`, async () => {
      const s = spies();
      const run = (new CredentialsService(client()) as unknown as Record<string, (r: CredentialRequirement, o: unknown) => Promise<unknown>>)[method]!(requirement, { ...base(s), descriptor: held });
      await expect(run).rejects.toMatchObject({ code: "UNSUPPORTED_PROFILE" });
      expect(s.seen).toEqual({ fetch: 0, transport: [] });
    });

    test(`${method} through discovery for a held requirement: refused before the catalog is read`, async () => {
      const s = spies();
      const run = (new CredentialsService(client()) as unknown as Record<string, (r: CredentialRequirement, o: unknown) => Promise<unknown>>)[method]!(requirement, { ...base(s), discoveryUrl: "https://witness.credentials.org/.well-known/opencredentials" });
      await expect(run).rejects.toMatchObject({ code: "UNSUPPORTED_PROFILE" });
      expect(s.seen).toEqual({ fetch: 0, transport: [] });
    });
  }

  test("with allowHeldProfile: true the gate is passed (the driver is then reached); it carries no other trust input", async () => {
    const s = spies();
    await expect(new CredentialsService(client()).acquire(requirement, { ...base(s), descriptor: held, allowHeldProfile: true } as never)).rejects.toBeDefined();
    expect(s.seen.transport.length).toBeGreaterThan(0);
  });
});
