import { afterAll, beforeAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import {
  canonicalDigest,
  canonicalEmailDomain,
  canonicalMailbox,
  createEmailCredentialRequirement,
  createEmailDomainCredentialRequirement,
  descriptorSatisfiesRequirement,
  mailboxBelongsToDomain,
  validateCredentialFlowDescriptor,
  type CredentialFlowDescriptor,
} from "@tinycloud/sdk-core";
import { InlineCredentialInteraction } from "../src/credentials/browser";
import { CredentialsService } from "../src/credentials/service";
import type { CredentialAcquisitionTransport, CredentialClient, CredentialInputRequest } from "../src/credentials/types";
import { verifiedShareRequirement } from "../src/share/service";

const HOLDER = "did:key:z6MkehRgf7yJbgaGfYsdoAsKdBPE3dj2CYhowQdcjqSJgvVd";
const fixture = await Bun.file(new URL("../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url)).json() as { vectors: { name: string; descriptor: CredentialFlowDescriptor; digest: string }[] };
const exactDescriptor = fixture.vectors.find((vector) => vector.name === "email")!.descriptor;
const domainVector = fixture.vectors.find((vector) => vector.name === "email-domain-proof-v1")!;
const domainDescriptor = validateCredentialFlowDescriptor(domainVector.descriptor);
const profile = { id: "tinycloud.email-domain-proof/v1", version: 1 as const };
const credentialType = { id: "opencredentials.email/v1", version: 1 as const };

test("the domain descriptor is a second profile; the exact-email descriptor digest is unchanged", async () => {
  expect(await canonicalDigest(exactDescriptor)).toBe("1tg-qphmKBVtNwzVg9xyz-xxqt_xtMXAsQyXw46m8S0");
  expect(await canonicalDigest(domainDescriptor)).toBe(domainVector.digest);
  expect(domainDescriptor.claims.map((claim) => claim.name)).toEqual(["email", "emailDomain"]);
  const domainRequirement = createEmailDomainCredentialRequirement({ domain: "tinycloud.xyz", profile, credentialType });
  expect(domainRequirement.claims).toEqual({ emailDomain: "tinycloud.xyz" });
  expect(domainRequirement.maxAgeSeconds).toBe(300);
  expect(descriptorSatisfiesRequirement(domainDescriptor, domainRequirement)).toBe(true);
  // The exact-email descriptor cannot satisfy a domain requirement, and the
  // domain descriptor cannot satisfy an exact-email policy.
  expect(descriptorSatisfiesRequirement(validateCredentialFlowDescriptor(exactDescriptor), { ...domainRequirement, profile: { id: exactDescriptor.profile, version: 1 } })).toBe(false);
  expect(descriptorSatisfiesRequirement(domainDescriptor, createEmailCredentialRequirement({ email: "a@tinycloud.xyz", profile: { id: exactDescriptor.profile, version: 1 }, credentialType }))).toBe(false);
});

test("domains and mailboxes have one canonical ASCII form, and membership is exact", () => {
  expect(canonicalEmailDomain(" @TinyCloud.XYZ ")).toBe("tinycloud.xyz");
  expect(canonicalEmailDomain("xn--bcher-kva.de")).toBe("xn--bcher-kva.de");
  for (const invalid of ["tinycloud", "tinycloud.xyz.", "bücher.de", "tinyclоud.xyz", "192.168.0.1", "[1.2.3.4]", "-tc.xyz", "tc-.xyz", "tinycloud..xyz", "tinycloud.xyz​", ""]) {
    expect(() => canonicalEmailDomain(invalid)).toThrow();
    expect(() => createEmailDomainCredentialRequirement({ domain: invalid, profile, credentialType })).toThrow();
  }
  expect(canonicalMailbox(" Alice@TinyCloud.xyz ")).toEqual({ email: "alice@tinycloud.xyz", domain: "tinycloud.xyz" });
  expect(mailboxBelongsToDomain("alice@tinycloud.xyz", "tinycloud.xyz")).toBe(true);
  for (const outside of [
    "alice@sub.tinycloud.xyz",
    "alice@tinycloud.xyz.evil",
    "alice@eviltinycloud.xyz",
    "alice@tinyclоud.xyz",
    "alice@xn--tinycloud-xyz.example",
    "alice@tinycloud.xyz.",
    "alice@tinycloud.xyz​",
    "alice@TinyCloud.xyz@evil.example",
    "\"alice\"@tinycloud.xyz",
    "álice@tinycloud.xyz",
    "tinycloud.xyz",
  ]) expect(mailboxBelongsToDomain(outside, "tinycloud.xyz")).toBe(false);
});

class RecordingTransport implements Partial<CredentialAcquisitionTransport> {
  created: unknown[] = [];
  async create(input: Parameters<CredentialAcquisitionTransport["create"]>[0]) { this.created.push(input.inputs); throw new Error("stop after create"); }
}

function client(): CredentialClient {
  return {
    sessionDid: HOLDER, credentialHolderDid: HOLDER, credentialHolderKid: `${HOLDER}#${HOLDER.slice("did:key:".length)}`,
    session: () => ({}) as never, signSessionBytes: async () => new Uint8Array(64),
    ensureOwnedSpaceHosted: async () => "", credentialSpaceOwnerDid: () => "", kvForSpace: () => ({}) as never, accountAuthorizationCid: () => "",
  };
}

async function acquireWith(entered: string) {
  const transport = new RecordingTransport();
  const requests: CredentialInputRequest[] = [];
  const surface = { wake: async () => undefined, close: () => undefined, closed: () => false, requestProof: async () => ({}), requestInputs: async (request: CredentialInputRequest) => { requests.push(request); return { email: entered }; } };
  const run = new CredentialsService(client()).acquire(createEmailDomainCredentialRequirement({ domain: "tinycloud.xyz", profile, credentialType }), {
    descriptor: domainDescriptor, interaction: "inline", browser: new InlineCredentialInteraction(async () => surface), transport: transport as unknown as CredentialAcquisitionTransport, openerOrigin: "https://share.example",
  });
  return { run, transport, requests };
}

test("the recipient's mailbox is an acquisition input separate from the policy's domain claim", async () => {
  const { run, transport, requests } = await acquireWith(" Reader@TinyCloud.xyz ");
  await expect(run).rejects.toBeDefined();
  expect(requests).toEqual([{ inputs: [{ id: "email", label: domainDescriptor.inputs[0]!.label, schema: domainDescriptor.inputs[0]!.schema }], mailboxDomain: "tinycloud.xyz", signal: expect.anything() }]);
  // Exactly the canonical mailbox is sent; the domain is never caller-asserted.
  expect(transport.created).toEqual([{ email: "reader@tinycloud.xyz" }]);
});

test("a mailbox outside the exact domain never starts an acquisition", async () => {
  for (const entered of ["reader@sub.tinycloud.xyz", "reader@tinycloud.xyz.evil", "reader@tinyclоud.xyz", "reader@bücher.de", "reader"]) {
    const { run, transport } = await acquireWith(entered);
    await expect(run).rejects.toMatchObject({ code: "VERIFICATION_FAILED", details: { state: "mailbox_domain_mismatch" } });
    expect(transport.created).toEqual([]);
  }
});

test("an exact-email acquisition still sends its committed mailbox without asking", async () => {
  const transport = new RecordingTransport();
  let asked = false;
  const surface = { wake: async () => undefined, close: () => undefined, closed: () => false, requestProof: async () => ({}), requestInputs: async () => { asked = true; return {}; } };
  const exact = createEmailCredentialRequirement({ email: "reader@example.com", profile: { id: exactDescriptor.profile, version: 1 }, credentialType });
  await expect(new CredentialsService(client()).acquire(exact, { descriptor: exactDescriptor, interaction: "inline", browser: new InlineCredentialInteraction(async () => surface), transport: transport as unknown as CredentialAcquisitionTransport, openerOrigin: "https://share.example" })).rejects.toBeDefined();
  expect(asked).toBe(false);
  expect(transport.created).toEqual([{ email: "reader@example.com" }]);
});

test("a domain share's recipient is the canonical domain its signed policy commits to", async () => {
  const committed = createEmailDomainCredentialRequirement({ domain: "tinycloud.xyz", profile, credentialType });
  const envelope = async (value: string) => ({
    recipientMatcher: { kind: "emailDomain", value },
    policy: { schema: "xyz.tinycloud.policy/policy/v2", credentialRequirement: { requirementDigest: await canonicalDigest(committed), profile, credentialType } },
  }) as never;
  expect((await verifiedShareRequirement(await envelope("tinycloud.xyz"))).claims).toEqual({ emailDomain: "tinycloud.xyz" });
  for (const substituted of ["sub.tinycloud.xyz", "tinycloud.xyz.evil", "evil.example"]) {
    await expect(verifiedShareRequirement(await envelope(substituted))).rejects.toThrow("does not match its policy commitment");
  }
  for (const nonCanonical of ["TinyCloud.xyz", "tinyclоud.xyz", "tinycloud.xyz."]) {
    await expect(verifiedShareRequirement(await envelope(nonCanonical))).rejects.toThrow("not canonical");
  }
});

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "customElements"] as const;
const previous = new Map<string, { readonly present: boolean; readonly value: unknown }>();
beforeAll(() => {
  dom = new JSDOM("<!doctype html><body><div id=mount></div></body>", { pretendToBeVisual: true });
  const scope = globalThis as Record<string, unknown>;
  for (const name of globals) { previous.set(name, { present: name in scope, value: scope[name] }); scope[name] = (dom.window as unknown as Record<string, unknown>)[name]; }
});
afterAll(() => {
  const scope = globalThis as Record<string, unknown>;
  for (const name of globals) { const saved = previous.get(name)!; if (saved.present) scope[name] = saved.value; else delete scope[name]; }
  dom.window.close();
});

test("the SDK view asks for a mailbox at the invited domain and refuses look-alikes", async () => {
  const { CredentialAcquisitionController } = await import("../src/credentials/element.ts?jsdom-domain") as typeof import("../src/credentials/element");
  const mount = document.getElementById("mount")!;
  const controller = new CredentialAcquisitionController({ descriptor: domainDescriptor, mountTarget: mount, mailboxDomain: "tinycloud.xyz" });
  const surface = await controller.start({});
  const root = mount.querySelector("tinycloud-credential-acquisition")!.shadowRoot!;
  expect(root.querySelector("h2")?.textContent).toBe("Verify your email");
  const pending = surface.requestInputs!({ inputs: [{ id: "email", label: "Email address", schema: domainDescriptor.inputs[0]!.schema }], mailboxDomain: "tinycloud.xyz" });
  await Promise.resolve();
  expect(root.querySelector("h2")?.textContent).toBe("Enter your email");
  expect(root.querySelector(".lede")?.textContent).toContain("anyone with an address at @tinycloud.xyz");
  const input = root.querySelector<HTMLInputElement>("input#mailbox")!;
  expect([input.type, input.autocomplete, input.inputMode, input.placeholder]).toEqual(["email", "email", "email", "name@tinycloud.xyz"]);
  const submit = (value: string) => { input.value = value; root.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true })); };
  submit("reader@sub.tinycloud.xyz");
  expect(root.querySelector("#mailbox-error")?.textContent).toBe("This invitation needs an address at @tinycloud.xyz. @sub.tinycloud.xyz is a different domain.");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  submit("not-an-address");
  expect(root.querySelector("#mailbox-error")?.textContent).toBe("Enter an email address like name@tinycloud.xyz.");
  submit(" Reader@TinyCloud.xyz ");
  expect(await pending).toEqual({ email: "reader@tinycloud.xyz" });
  expect(root.querySelector(".lede")?.textContent).toBe("We’re sending an 8-digit code to reader@tinycloud.xyz.");
});
