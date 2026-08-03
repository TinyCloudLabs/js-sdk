import type { CredentialFlowDescriptor, CredentialUxState } from "@tinycloud/sdk-core";

export interface CredentialRendererModel {
  readonly title: string; readonly description: string; readonly consent: string;
  readonly fields: readonly { readonly id: string; readonly label: string; readonly required: true; readonly inputMode: "email" | "text" }[];
  readonly steps: readonly { readonly id: string; readonly primitive: string; readonly title: string; readonly description: string }[];
  readonly stateLabels: Readonly<Record<"progress" | "success" | "recovery", string>>; readonly state: CredentialUxState;
}
const stepCopy = { collect_input: ["Provide details", "Provide the required value."], mailbox_otp: ["Verify mailbox", "Enter the one-time mailbox code."], holder_signature: ["Confirm holder", "Approve holder binding with your active key."] } as const;
/** Shared descriptor-driven UX model. Dispatch is only by the finite primitive registry. */
export function renderCredentialDescriptor(descriptor: CredentialFlowDescriptor, state: CredentialUxState = "collecting"): CredentialRendererModel {
  return Object.freeze({ title: descriptor.display.title, description: descriptor.display.description, consent: descriptor.display.consent, fields: Object.freeze(descriptor.inputs.map((field) => Object.freeze({ id: field.id, label: field.label, required: true as const, inputMode: field.schema.format === "email" ? "email" as const : "text" as const }))), steps: Object.freeze(descriptor.steps.map((step, index) => Object.freeze({ id: `${step.type}-${index}`, primitive: step.type, title: stepCopy[step.type][0], description: stepCopy[step.type][1] }))), stateLabels: Object.freeze({ progress: descriptor.accessibility.progressLabel, success: "Credential acquired", recovery: "Credential acquisition needs attention" }), state });
}
