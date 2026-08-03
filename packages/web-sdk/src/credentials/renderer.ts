import type { CredentialFlowDescriptor, CredentialUxState } from "@tinycloud/sdk-core";

export interface CredentialRendererModel {
  readonly title: string;
  readonly description: string;
  readonly consent: string;
  readonly fields: readonly { readonly id: string; readonly label: string; readonly required: boolean; readonly inputMode: "email" | "text"; readonly description?: string }[];
  readonly steps: readonly { readonly id: string; readonly primitive: string; readonly title: string; readonly description: string }[];
  readonly stateLabels: Readonly<Record<"progress" | "success" | "recovery", string>>;
  readonly state: CredentialUxState;
}

/** Shared descriptor-driven UX model. It never inspects credential or profile names. */
export function renderCredentialDescriptor(descriptor: CredentialFlowDescriptor, state: CredentialUxState = "idle"): CredentialRendererModel {
  return Object.freeze({ title: descriptor.presentation.title, description: descriptor.presentation.description, consent: descriptor.presentation.consent, fields: Object.freeze(descriptor.inputs.map((field) => Object.freeze({ id: field.id, label: field.accessibility.label, required: field.required, inputMode: field.schema.format === "email" ? "email" as const : "text" as const, ...(field.accessibility.description === undefined ? {} : { description: field.accessibility.description }) }))), steps: Object.freeze(descriptor.steps.map((step) => Object.freeze({ id: step.id, primitive: step.type, title: step.title, description: step.description }))), stateLabels: Object.freeze({ progress: descriptor.presentation.progressLabel, success: descriptor.presentation.successLabel, recovery: descriptor.presentation.recoveryLabel }), state });
}
