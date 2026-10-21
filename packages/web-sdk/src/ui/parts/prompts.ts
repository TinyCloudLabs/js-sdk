import { canRenderUi } from "../frame-guard";
import type { HostPart } from "../slots";

/**
 * Prompt host. Permission and space-creation prompts render into the host
 * layer, which lives inside the host's open shadow root, never into
 * `document.body`. Fail closed: a prompt that cannot render is refused before
 * it mounts, and the caller resolves it as declined/dismissed.
 */

/** Fixed codes for a refused prompt. Each refusal logs exactly one of these. */
export type PromptRefusal = "ui-unavailable-frame" | "ui-disabled";

/** Identity of one registered UI client. Owns the prompts that client opened. */
export interface PromptScope {
  /** False for `ui: false`. */
  readonly uiEnabled: boolean;
}

/** A prompt is either mounted (`release` detaches it from the registry) or refused. */
export type PromptMount =
  | { readonly refusal: PromptRefusal }
  | { readonly release: () => void };

interface OpenPrompt {
  readonly scope: PromptScope;
  readonly dismiss: () => void;
}

const openPrompts = new Set<OpenPrompt>();
let promptLayer: HTMLElement | undefined;

export function createPromptScope(uiEnabled: boolean): PromptScope {
  return { uiEnabled };
}

/**
 * Checked at show time, not at registration: a page can move between
 * top-level and a frame. `ui-unavailable-frame` wins over `ui-disabled`.
 */
function refusalFor(scope: PromptScope): PromptRefusal | undefined {
  if (!canRenderUi()) return "ui-unavailable-frame";
  if (!scope.uiEnabled || promptLayer === undefined) return "ui-disabled";
  return undefined;
}

/**
 * Mounts `element` into the host layer, or refuses it. `dismiss` must settle
 * the prompt as dismissed and remove it; teardown and `dismissPrompts` call it.
 */
export function mountPrompt(
  scope: PromptScope,
  element: HTMLElement,
  dismiss: () => void,
): PromptMount {
  const refusal = refusalFor(scope);
  if (refusal !== undefined) {
    console.warn(`[tinycloud] ${refusal}`);
    return { refusal };
  }
  // refusalFor() returned undefined, so the layer exists.
  promptLayer?.appendChild(element);
  const entry: OpenPrompt = { scope, dismiss };
  openPrompts.add(entry);
  return {
    release: () => {
      openPrompts.delete(entry);
    },
  };
}

/** Dismisses every pending prompt opened by `scope`. Used on reset and unregister. */
export function dismissPrompts(scope: PromptScope): void {
  let failed = false;
  let firstError: unknown;
  for (const entry of [...openPrompts]) {
    if (entry.scope !== scope) continue;
    openPrompts.delete(entry);
    try {
      entry.dismiss();
    } catch (error) {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    }
  }
  if (failed) throw firstError;
}

export const prompts: HostPart = {
  id: "prompts",
  start(_context, layer) {
    promptLayer = layer;
    return () => {
      promptLayer = undefined;
      let failed = false;
      let firstError: unknown;
      for (const entry of [...openPrompts]) {
        openPrompts.delete(entry);
        try {
          entry.dismiss();
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
        }
      }
      if (failed) throw firstError;
    };
  },
};
