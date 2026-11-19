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
  readonly element?: HTMLElement;
}

/**
 * The open prompts and the layer they mount into. Kept on `globalThis` because the dialogs load in their own
 * chunk, which carries its own copy of this module: both copies must see one registry, or `dismissPrompts`
 * would miss a prompt the lazy copy mounted.
 */
interface PromptState {
  readonly open: Set<OpenPrompt>;
  layer: HTMLElement | undefined;
}
const STATE_KEY = Symbol.for("tinycloud.web-sdk.prompt-state");
const state = ((globalThis as Record<symbol, PromptState | undefined>)[STATE_KEY] ??= {
  open: new Set<OpenPrompt>(),
  layer: undefined,
});

export const PROMPT_SETTLED_EVENT = "tinycloud-prompt-settled";

export function createPromptScope(uiEnabled: boolean): PromptScope {
  return { uiEnabled };
}

/** A held lazy dialog has no visible element and must not displace panel focus. */
export function hasMountedPrompt(): boolean {
  for (const prompt of state.open) {
    if (prompt.element?.isConnected && !prompt.element.hidden) return true;
  }
  return false;
}

/**
 * Checked at show time, not at registration: a page can move between
 * top-level and a frame. `ui-unavailable-frame` wins over `ui-disabled`.
 */
function refusalFor(scope: PromptScope): PromptRefusal | undefined {
  if (!canRenderUi()) return "ui-unavailable-frame";
  if (!scope.uiEnabled || state.layer === undefined) return "ui-disabled";
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
  state.layer?.appendChild(element);
  const entry: OpenPrompt = { scope, dismiss, element };
  state.open.add(entry);
  return {
    release: () => {
      state.open.delete(entry);
      state.layer?.dispatchEvent(new Event(PROMPT_SETTLED_EVENT));
    },
  };
}

/**
 * Registers a prompt that has no dialog on screen yet (its dialog chunk is still loading). `dismissPrompts` and
 * the part's teardown decline it like a mounted one, so a reset, sign-out or account change reaches it. Returns
 * the release that takes it out of the registry.
 */
export function holdPrompt(scope: PromptScope, dismiss: () => void): () => void {
  const entry: OpenPrompt = { scope, dismiss };
  state.open.add(entry);
  return () => {
    state.open.delete(entry);
  };
}

/**
 * Runs every entry's dismiss, removing each from the registry first. A throwing
 * caller callback must not stop cleanup, so the first error is rethrown on a
 * microtask after all entries have been settled.
 */
function dismissEntries(entries: readonly OpenPrompt[]): void {
  let failed = false;
  let firstError: unknown;
  for (const entry of entries) {
    state.open.delete(entry);
    try {
      entry.dismiss();
    } catch (error) {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    }
  }
  if (failed) {
    queueMicrotask(() => {
      throw firstError;
    });
  }
}

/** Dismisses every pending prompt opened by `scope`. Used on reset and unregister. */
export function dismissPrompts(scope: PromptScope): void {
  dismissEntries([...state.open].filter((entry) => entry.scope === scope));
}

export const prompts: HostPart = {
  id: "prompts",
  start(_context, layer) {
    state.layer = layer;
    return () => {
      state.layer = undefined;
      dismissEntries([...state.open]);
    };
  },
};
