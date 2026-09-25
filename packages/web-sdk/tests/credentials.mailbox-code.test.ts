import { afterAll, beforeAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { CredentialError, canonicalDigest, createHolderBinding, type CredentialFlowDescriptor, type CredentialRequirement } from "@tinycloud/sdk-core";
import { interpretCredentialFlow } from "../src/credentials/interpreter";
import { OpenCredentialsHttpTransport } from "../src/credentials/transport";
import type { CredentialAcquisitionTransport, CredentialRequestState, InlineCredentialProofRequest } from "../src/credentials/types";

const HOLDER = "did:key:z6MkActive";
const REQUEST = "R".repeat(32);
const fixture = await Bun.file(new URL("../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url)).json() as { vectors: { descriptor: CredentialFlowDescriptor }[] };
const email = fixture.vectors[0]!.descriptor;
const requirement: CredentialRequirement = { type: "TinyCloudCredentialRequirement", version: 1, profile: { id: email.profile, version: 1 }, credentialType: { id: email.format.vct, version: 1 }, claims: { email: "reader@example.com" } };

function errorResponse(status: number, code: string, recoverable: boolean): Response {
  return new Response(JSON.stringify({ type: "tinycloud.credentials/error/v1", code, recoverable, state: "proof_rejected", correlationId: "C".repeat(16) }), { status, headers: { "content-type": "application/json" } });
}

test("transport separates a retryable rejected code from an exhausted or expired challenge", async () => {
  const submit = async (response: Response) => {
    const transport = new OpenCredentialsHttpTransport(email, async (url) => String(url).endsWith("/challenge")
      ? new Response(JSON.stringify({ type: "tinycloud.credentials/challenge/v1", step: "mailbox_otp", stepVersion: 1, challengeNonce: "N".repeat(32) }), { status: 200 })
      : response);
    await transport.beginStep(REQUEST, "V".repeat(43), "mailbox_otp");
    return transport.submitStep(REQUEST, "V".repeat(43), "mailbox_otp", { otp: "00000000" });
  };
  await expect(submit(errorResponse(422, "PROOF_REJECTED", true))).rejects.toMatchObject({ code: "PROOF_REJECTED", recoverable: true });
  await expect(submit(errorResponse(422, "PROOF_REJECTED", false))).rejects.toMatchObject({ code: "VERIFICATION_FAILED", recoverable: false, details: { state: "proof_attempts_exhausted" } });
  await expect(submit(errorResponse(409, "CHALLENGE_EXPIRED", false))).rejects.toMatchObject({ code: "REQUEST_EXPIRED", recoverable: true });
});

class RejectingTransport implements CredentialAcquisitionTransport {
  index = 0; challenges = 0; proofs: unknown[] = [];
  constructor(readonly states: readonly CredentialRequestState[], readonly holder: unknown, readonly rejections: number) {}
  async create(): Promise<never> { throw new Error("unused"); }
  async state() { return this.states[Math.min(this.index, this.states.length - 1)]!; }
  async beginStep() { this.challenges += 1; }
  async submitStep(_id: string, _verifier: string, _step: string, proof: unknown) {
    this.proofs.push(proof);
    if (this.proofs.length <= this.rejections) throw new CredentialError("PROOF_REJECTED", "The proof was not accepted");
    this.index += 1;
  }
  async holderBinding(): Promise<never> { return this.holder as never; }
  async submitHolderSignature() { this.index += 1; }
  async issue() { this.index += 1; }
  async result(): Promise<never> { throw new Error("unused"); }
  async issuerMetadata(): Promise<never> { throw new Error("unused"); }
  async checkStatus() { return true; }
}

async function runRejections(rejections: number) {
  const descriptorDigest = await canonicalDigest(email);
  const requirementDigest = await canonicalDigest(requirement);
  const states: CredentialRequestState[] = [
    { type: "OpenCredentialsAcquisitionState", version: 1, requestId: REQUEST, transitionId: "challenge", state: "pending", nextStep: { id: "mailbox_otp", type: "mailbox_otp", version: 1, constraints: { challengeRequired: true } }, correlationId: REQUEST },
    { type: "OpenCredentialsAcquisitionState", version: 1, requestId: REQUEST, transitionId: "complete", state: "complete", correlationId: REQUEST },
  ];
  const holder = createHolderBinding({ requestId: REQUEST, profile: email.profile, profileVersion: 1, descriptorDigest, requirementDigest, issuer: email.issuer.did, issuerKid: email.issuer.kid, holderDid: HOLDER, normalizedClaimsDigest: "N".repeat(43), challengeNonce: "C".repeat(32), audience: "tinycloud://credentials", openerOrigin: "https://app.test", completionOrigin: "https://app.test", completionContext: "sdk-acquisition", jti: "J".repeat(32), issuedAt: "2030-01-01T00:00:00Z", expiresAt: "2030-01-01T00:10:00Z" } as never);
  const transport = new RejectingTransport(states, holder, rejections);
  const requests: InlineCredentialProofRequest[] = [];
  const run = interpretCredentialFlow({ descriptor: email, requirement, requestId: REQUEST, verifier: "V".repeat(32), holderDid: HOLDER, descriptorDigest, requirementDigest, openerOrigin: "https://app.test", transport, signing: { autoSign: async () => new Uint8Array([1]) }, proofHandler: async (request) => { requests.push(request); return { otp: String(requests.length).padStart(8, "0") }; } });
  return { run, transport, requests };
}

test("a rejected mailbox code is re-entered against the same challenge with the remaining attempts", async () => {
  const { run, transport, requests } = await runRejections(2);
  await run;
  expect(transport.challenges).toBe(1);
  expect(transport.proofs).toEqual([{ otp: "00000001" }, { otp: "00000002" }, { otp: "00000003" }]);
  expect(requests.map((request) => request.feedback)).toEqual([undefined, { kind: "rejected", attemptsRemaining: 4 }, { kind: "rejected", attemptsRemaining: 3 }]);
  // Host proof handlers still never receive requirement values.
  expect(JSON.stringify(requests)).not.toContain("reader@example.com");
});

test("the interpreter stops re-prompting once the declared attempt budget is spent", async () => {
  const { run, transport, requests } = await runRejections(email.lifecycle.maxProofAttempts);
  await expect(run).rejects.toMatchObject({ code: "VERIFICATION_FAILED", recoverable: false, details: { state: "proof_attempts_exhausted" } });
  expect(requests).toHaveLength(email.lifecycle.maxProofAttempts);
  expect(transport.challenges).toBe(1);
});

let dom: JSDOM;
// Only the globals the element reads; events are constructed from `dom.window`.
const globals = ["window", "document", "HTMLElement", "customElements"] as const;
const previous = new Map<string, { readonly present: boolean; readonly value: unknown }>();
beforeAll(() => {
  dom = new JSDOM("<!doctype html><body><div id=mount></div></body>", { pretendToBeVisual: true });
  const scope = globalThis as Record<string, unknown>;
  for (const name of globals) {
    previous.set(name, { present: name in scope, value: scope[name] });
    scope[name] = (dom.window as unknown as Record<string, unknown>)[name];
  }
});
afterAll(() => {
  const scope = globalThis as Record<string, unknown>;
  for (const name of globals) {
    const saved = previous.get(name)!;
    if (saved.present) scope[name] = saved.value;
    else delete scope[name];
  }
  dom.window.close();
});

async function mountedElement() {
  // A fresh module instance binds the element to this test's jsdom globals even
  // when another test file already imported it without a DOM.
  const { CredentialAcquisitionController, normalizeMailboxCode, MAILBOX_OTP_LENGTH } = await import("../src/credentials/element.ts?jsdom") as typeof import("../src/credentials/element");
  const mount = document.getElementById("mount")!;
  mount.replaceChildren();
  const controller = new CredentialAcquisitionController({ descriptor: email, mountTarget: mount, subject: { kind: "email", value: "reader@example.com" } });
  const surface = await controller.start({});
  const host = mount.querySelector("tinycloud-credential-acquisition")!;
  return { controller, surface, root: host.shadowRoot!, normalizeMailboxCode, MAILBOX_OTP_LENGTH };
}

function prompt(feedback?: InlineCredentialProofRequest["feedback"]): InlineCredentialProofRequest {
  return { stepId: "mailbox_otp", constraints: {}, display: { title: email.display.title, description: email.display.description, consent: email.display.consent, progressLabel: email.accessibility.progressLabel, errorLiveRegion: "assertive" }, inputs: [], ...(feedback === undefined ? {} : { feedback }) };
}

test("mailbox codes are normalized from typed, grouped, full-width, and pasted text", async () => {
  const { normalizeMailboxCode, MAILBOX_OTP_LENGTH } = await mountedElement();
  expect(MAILBOX_OTP_LENGTH).toBe(8);
  expect(normalizeMailboxCode("1234")).toBe("1234");
  expect(normalizeMailboxCode("1234 5678")).toBe("12345678");
  expect(normalizeMailboxCode("1234-5678")).toBe("12345678");
  expect(normalizeMailboxCode("１２３４５６７８")).toBe("12345678");
  expect(normalizeMailboxCode("Your 8-digit OpenCredentials code is 40817263. It expires in five minutes.")).toBe("40817263");
  expect(normalizeMailboxCode("123456789")).toBe("12345678");
});

test("the SDK view names the verified mailbox and exposes one accessible one-time-code field", async () => {
  const { surface, root } = await mountedElement();
  expect(root.querySelector("h2")?.textContent).toBe("Verify your email");
  expect(root.querySelector(".subject")?.textContent).toBe("reader@example.com");
  expect(root.querySelector("[role=status]")?.textContent).toContain("Sending your code");

  const pending = surface.requestProof!(prompt());
  await Promise.resolve();
  const input = root.querySelector<HTMLInputElement>("input#otp")!;
  expect(root.querySelector("h2")?.textContent).toBe("Check your email");
  expect(root.querySelector(".lede")?.textContent).toBe("Enter the 8-digit code we sent to reader@example.com.");
  expect(root.querySelector(`label[for="otp"]`)?.textContent).toBe("Verification code");
  expect([input.autocomplete, input.inputMode, input.pattern, input.getAttribute("aria-describedby")]).toEqual(["one-time-code", "numeric", "[0-9]{8}", "otp-hint otp-error"]);
  expect(input.hasAttribute("maxlength")).toBe(false);
  expect(root.querySelectorAll(".slot")).toHaveLength(8);
  expect(root.querySelector(".slots")?.getAttribute("aria-hidden")).toBe("true");
  expect(root.querySelector(".hint")?.textContent).toContain("expires in 5 minutes");
  expect(root.activeElement).toBe(input);

  // An incomplete code is refused locally with an announced, recoverable error.
  input.value = "1234";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  root.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  expect(root.querySelector("#otp-error")?.getAttribute("role")).toBe("alert");
  expect(root.querySelector("#otp-error")?.textContent).toBe("Enter all 8 digits of the code.");
  expect(input.getAttribute("aria-invalid")).toBe("true");

  // Typing the final digit submits exactly the eight ASCII digits once.
  input.value = "1234 5678";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  expect(await pending).toEqual({ otp: "12345678" });
  expect(input.readOnly).toBe(true);
  expect(root.querySelector("button[type=submit]")?.textContent).toBe("Verifying…");
  expect(root.querySelector<HTMLButtonElement>("[data-cancel]")?.disabled).toBe(true);
  expect(root.querySelector("#otp-error")?.hasAttribute("hidden")).toBe(true);
});

test("a rejected code re-prompts with the remaining attempts and accepts a pasted code", async () => {
  const { surface, root, controller } = await mountedElement();
  const pending = surface.requestProof!(prompt({ kind: "rejected", attemptsRemaining: 1 }));
  await Promise.resolve();
  expect(root.querySelector("#otp-error")?.textContent).toBe("That code didn’t match. You can try 1 more time.");
  const input = root.querySelector<HTMLInputElement>("input#otp")!;
  const paste = new dom.window.Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData?: { getData(type: string): string } };
  Object.defineProperty(paste, "clipboardData", { value: { getData: () => "Your code: 8765 4321" } });
  input.dispatchEvent(paste);
  expect(paste.defaultPrevented).toBe(true);
  expect(await pending).toEqual({ otp: "87654321" });

  controller.progress("signing");
  expect(root.querySelector("form")?.hasAttribute("hidden")).toBe(true);
  controller.finish();
  expect(root.querySelector("[role=status]")?.textContent).toBe("Email verified.");
});

test("cancel rejects the pending proof as a recoverable cancellation", async () => {
  const { surface, root } = await mountedElement();
  const pending = surface.requestProof!(prompt());
  await Promise.resolve();
  root.querySelector<HTMLButtonElement>("[data-cancel]")!.click();
  await expect(pending).rejects.toMatchObject({ code: "CANCELED", recoverable: true });
});
