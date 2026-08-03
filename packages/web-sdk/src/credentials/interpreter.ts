import {
  CredentialError,
  encodeBase64Url,
  holderBindingSigningBytes,
  validateCredentialHolderBinding,
  type CredentialFlowDescriptor,
  type CredentialProgressEvent,
  type CredentialRequirement,
} from "@tinycloud/sdk-core";
import type { CredentialAcquisitionTransport, CredentialSigningAdapter, PrimitiveStepHandler } from "./types";

const delay = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
});

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
  readonly transport: CredentialAcquisitionTransport;
  readonly signing: CredentialSigningAdapter;
  readonly handlers?: Partial<Record<"collect_input" | "mailbox_otp", PrimitiveStepHandler>>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: CredentialProgressEvent) => void;
  readonly onWait?: () => Promise<void>;
}): Promise<void> {
  const steps = new Map(input.descriptor.steps.map((step) => [step.type, step]));
  const completed = new Set<string>(); let lastTransition = "";
  for (;;) {
    input.signal?.throwIfAborted();
    const state = await input.transport.state(input.requestId, input.verifier, input.signal);
    if (state.requestId !== input.requestId) throw new CredentialError("REQUEST_SUBSTITUTED", "Credential request identity changed");
    if (state.state === "expired") throw new CredentialError("REQUEST_EXPIRED", "Credential request expired", { state: state.state, correlationId: state.correlationId });
    if (state.state === "canceled") throw new CredentialError("CANCELED", "Credential request was canceled", { state: state.state, correlationId: state.correlationId });
    if (state.state === "issuer_unready") throw new CredentialError("ISSUER_UNREADY", "Credential issuer is not ready", { retryAfterMs: state.retryAfterMs, state: state.state, correlationId: state.correlationId });
    if (state.state === "complete") return;
    if (state.state === "ready_to_issue" || state.state === "issued") {
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
      const binding = validateCredentialHolderBinding(await input.transport.holderBinding(input.requestId, input.verifier, input.signal));
      if (binding.requestId !== input.requestId || binding.descriptorDigest !== input.descriptorDigest || binding.requirementDigest !== input.requirementDigest || binding.holderDid !== input.holderDid || binding.issuer !== input.descriptor.issuer.did || binding.issuerKid !== input.descriptor.issuer.kid || binding.profile !== input.descriptor.profile || binding.openerOrigin !== input.openerOrigin || binding.completionOrigin !== input.openerOrigin || binding.audience !== "tinycloud://credentials") throw new CredentialError("REQUEST_SUBSTITUTED", "Holder binding was substituted");
      const bytes = holderBindingSigningBytes(binding);
      let signature = await input.signing.autoSign?.(binding, bytes, input.signal);
      if (signature === undefined) {
        if (!input.signing.requestApproval) throw new CredentialError("SIGNATURE_REJECTED", "OpenKey approval is required");
        try { signature = await input.signing.requestApproval(binding, bytes, input.signal); } catch (cause) { throw new CredentialError("SIGNATURE_REJECTED", "OpenKey approval was rejected", { cause }); }
      }
      if (!(signature instanceof Uint8Array) || signature.length === 0) throw new CredentialError("SIGNATURE_REJECTED", "OpenKey signature is invalid");
      await input.transport.submitHolderSignature(input.requestId, input.verifier, encodeBase64Url(signature), input.signal);
    } else {
      input.onProgress?.({ state: next.type === "collect_input" ? "collecting" : "proving", stepId: next.id, correlationId: state.correlationId });
      const handler = input.handlers?.[next.type];
      if (!handler) { await (input.onWait?.() ?? delay(state.retryAfterMs ?? 50, input.signal)); continue; }
      if (next.constraints.challengeRequired === true) await input.transport.beginStep(input.requestId, input.verifier, next.type, input.signal);
      const proof = await handler({ descriptor: input.descriptor, requirement: input.requirement, stepId: next.id, constraints: next.constraints, signal: input.signal });
      await input.transport.submitStep(input.requestId, input.verifier, next.id, proof, input.signal);
    }
    completed.add(next.id);
  }
}
