import {
  CredentialError,
  encodeBase64Url,
  holderBindingSigningBytes,
  validateCredentialHolderBinding,
  type CredentialFlowDescriptor,
  type CredentialProgressEvent,
  type CredentialRequirement,
} from "@tinycloud/sdk-core";
import { assertHeldBinding } from "./held-binding";
import type { CredentialAcquisitionTransport, CredentialProofSubject, CredentialSigningAdapter, InlineCredentialProofHandler, InlineCredentialProofRequest, PrimitiveStepHandler } from "./types";

const delay = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
});

/** The mailbox named by an email requirement, which the issuer delivers the code to. */
export function mailboxSubject(requirement: CredentialRequirement): CredentialProofSubject | undefined {
  const email = requirement.claims.email;
  return typeof email === "string" && email.length > 0 ? Object.freeze({ kind: "email" as const, value: email }) : undefined;
}

/** Finite step interpreter. Dispatch is exclusively by registered primitive and version. */
export async function interpretCredentialFlow(input: {
  readonly descriptor: CredentialFlowDescriptor;
  readonly requirement: CredentialRequirement;
  readonly requestId: string;
  readonly verifier: string;
  readonly holderDid: string;
  readonly descriptorDigest: string;
  readonly requirementDigest: string;
  readonly openerOrigin: string;
  /** `expiresAt` of the create response. Required for a held (account) descriptor: the signed binding must carry it. */
  readonly expiresAt?: string;
  readonly transport: CredentialAcquisitionTransport;
  readonly signing: CredentialSigningAdapter;
  /**
   * Fallback for a host-owned surface. It receives every declared proof step,
   * including primitives added by a later protocol version.
   */
  readonly proofHandler?: InlineCredentialProofHandler;
  readonly handlers?: Partial<Record<"collect_input" | "mailbox_otp", PrimitiveStepHandler>>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: CredentialProgressEvent) => void;
  readonly onWait?: () => Promise<void>;
  /**
   * Passed only by the email-proof functions, after the per-call held opt-in was accepted. Without it an account-bound (held, EIP191)
   * descriptor is refused before the first transport call (TC-2254 A2.5).
   */
  readonly allowAccountSubject?: true;
}): Promise<void> {
  const held = input.descriptor.subjectRelationship === "account_is_subject";
  if (held && input.allowAccountSubject !== true) throw new CredentialError("UNSUPPORTED_PROFILE", "The held credential profile requires an explicit opt-in");
  const steps = new Map(input.descriptor.steps.map((step) => [step.type, step]));
  const completed = new Set<string>(); let lastTransition = "";
  /** The identity checks on a holder binding, and for a held request all of S11 (a). One function, called wherever a held binding is read. */
  const checkBinding = async (value: unknown) => {
    const binding = validateCredentialHolderBinding(value);
    if (binding.requestId !== input.requestId || binding.descriptorDigest !== input.descriptorDigest || binding.requirementDigest !== input.requirementDigest || binding.holderDid !== input.holderDid || binding.issuer !== input.descriptor.issuer.did || binding.issuerKid !== input.descriptor.issuer.kid || binding.profile !== input.descriptor.profile || binding.openerOrigin !== input.openerOrigin || binding.completionOrigin !== input.openerOrigin || binding.audience !== "tinycloud://credentials") throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding was substituted");
    const alg = input.descriptor.holderBinding.alg;
    if (binding.type !== input.descriptor.holderBinding.domain || (alg === "EIP191" && !input.transport.challengeNonce)) throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding was substituted");
    if (alg === "EIP191") await assertHeldBinding(binding, { descriptor: input.descriptor, requirement: input.requirement, requestId: input.requestId, descriptorDigest: input.descriptorDigest, requirementDigest: input.requirementDigest, holderDid: input.holderDid, openerOrigin: input.openerOrigin, challengeNonce: input.transport.challengeNonce!(input.requestId), serverExpiresAt: input.expiresAt });
    return binding;
  };
  /**
   * S11 (e): a held request found past the signature (a retry after a failed notice, or after a lost issue response) has no binding read in
   * this call. Read it and check it in full before R7 or R8, so (vi) and (viii) are judged against the binding of THIS call. No R6, no wallet.
   */
  const ensureHeldBinding = async () => {
    if (!held || input.transport.signedBinding?.(input.requestId) !== undefined) return;
    await checkBinding(await input.transport.holderBinding(input.requestId, input.verifier, input.signal));
  };
  for (;;) {
    input.signal?.throwIfAborted();
    const state = await input.transport.state(input.requestId, input.verifier, input.signal);
    if (state.requestId !== input.requestId) throw new CredentialError("REQUEST_SUBSTITUTED", "Credential request identity changed");
    if (state.state === "expired") throw new CredentialError("REQUEST_EXPIRED", "Credential request expired", { state: state.state, correlationId: state.correlationId });
    if (state.state === "canceled") throw new CredentialError("CANCELED", "Credential request was canceled", { state: state.state, correlationId: state.correlationId });
    if (state.state === "issuer_unready") throw new CredentialError("ISSUER_UNREADY", "Credential issuer is not ready", { retryAfterMs: state.retryAfterMs, state: state.state, correlationId: state.correlationId });
    if (state.state === "complete") { await ensureHeldBinding(); return; }
    if (state.state === "ready_to_issue" || state.state === "issued") {
      await ensureHeldBinding();
      if (state.state === "ready_to_issue" && !completed.has("issue")) { await input.transport.issue(input.requestId, input.verifier, input.signal); completed.add("issue"); }
      else await (input.onWait?.() ?? delay(state.retryAfterMs ?? 50, input.signal));
      continue;
    }
    const next = state.nextStep;
    if (!next) { await (input.onWait?.() ?? delay(state.retryAfterMs ?? 50, input.signal)); continue; }
    const declared = steps.get(next.type);
    if (next.id !== next.type || !declared || declared.type !== next.type || declared.version !== next.version) throw new CredentialError("REQUEST_SUBSTITUTED", "Server selected an undeclared credential step");
    if (completed.has(next.id) || state.transitionId === lastTransition) { await (input.onWait?.() ?? delay(state.retryAfterMs ?? 50, input.signal)); continue; }
    lastTransition = state.transitionId;
    if (next.type === "holder_signature") {
      input.onProgress?.({ state: "signing", stepId: next.id, correlationId: state.correlationId });
      const binding = await checkBinding(await input.transport.holderBinding(input.requestId, input.verifier, input.signal));
      // Held (account, EIP-191) and ticket (did:key, EdDSA) never mix: the descriptor, the binding type and the holder key agree, or nothing is signed.
      const alg = input.descriptor.holderBinding.alg;
      if ((alg === "EIP191") !== (input.signing.holderKey?.alg === "EIP191")) throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding was substituted");
      const bytes = holderBindingSigningBytes(binding);
      let signature = await input.signing.autoSign?.(binding, bytes, input.signal);
      if (signature === undefined) {
        if (!input.signing.requestApproval) throw new CredentialError("SIGNATURE_REJECTED", "OpenKey approval is required");
        try { signature = await input.signing.requestApproval(binding, bytes, input.signal); } catch (cause) { if (cause instanceof CredentialError) throw cause; throw new CredentialError("SIGNATURE_REJECTED", "OpenKey approval was rejected", { cause }); }
      }
      if (!(signature instanceof Uint8Array) || signature.length === 0) throw new CredentialError("SIGNATURE_REJECTED", "OpenKey signature is invalid");
      await input.transport.submitHolderSignature(input.requestId, input.verifier, alg === "EIP191" ? `0x${Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("")}` : encodeBase64Url(signature), input.signal, input.signing.holderKey);
    } else {
      input.onProgress?.({ state: next.type === "collect_input" ? "collecting" : "proving", stepId: next.id, correlationId: state.correlationId });
      const handler = input.handlers?.[next.type];
      const inlineHandler = input.proofHandler;
      if (!handler && !inlineHandler) { await (input.onWait?.() ?? delay(state.retryAfterMs ?? 50, input.signal)); continue; }
      if (next.constraints.challengeRequired === true) await input.transport.beginStep(input.requestId, input.verifier, next.type, input.signal);
      if (handler) {
        const proof = await handler({ descriptor: input.descriptor, requirement: input.requirement, stepId: next.id, constraints: next.constraints, signal: input.signal });
        await input.transport.submitStep(input.requestId, input.verifier, next.id, proof, input.signal);
      } else {
        let feedback: InlineCredentialProofRequest["feedback"];
        // A mistyped code is re-entered against the same challenge; the issuer
        // counts every attempt and reports when the bounded budget is spent.
        for (let attempt = 1; ; attempt += 1) {
          const proof = await inlineHandler!({
            stepId: next.id,
            constraints: next.constraints,
            display: {
              title: input.descriptor.display.title,
              description: input.descriptor.display.description,
              consent: input.descriptor.display.consent,
              progressLabel: input.descriptor.accessibility.progressLabel,
              errorLiveRegion: input.descriptor.accessibility.errorLiveRegion,
            },
            inputs: input.descriptor.inputs.map(({ id, label, schema }) => ({ id, label, schema })),
            ...(feedback === undefined ? {} : { feedback }),
            signal: input.signal,
          });
          try {
            await input.transport.submitStep(input.requestId, input.verifier, next.id, proof, input.signal);
            break;
          } catch (cause) {
            if (!(cause instanceof CredentialError) || cause.code !== "PROOF_REJECTED") throw cause;
            const attemptsRemaining = input.descriptor.lifecycle.maxProofAttempts - attempt;
            // Once this view stops re-prompting, the rejection is final: a
            // host must not silently start a new acquisition on its behalf.
            if (next.type !== "mailbox_otp" || attemptsRemaining <= 0) throw new CredentialError("VERIFICATION_FAILED", "The proof was not accepted", { state: attemptsRemaining <= 0 ? "proof_attempts_exhausted" : "proof_rejected", cause });
            feedback = { kind: "rejected", attemptsRemaining };
          }
        }
      }
    }
    completed.add(next.id);
  }
}
