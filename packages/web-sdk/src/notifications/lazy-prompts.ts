import { createPromptScope, holdPrompt, type PromptScope } from "../ui/parts/prompts";
import type { PermissionRequestModalOptions, PermissionRequestResult } from "./PermissionRequestModal";
import type { SpaceCreationModalOptions, SpaceCreationResult } from "./SpaceCreationModal";
import { MODALS_KEY, type LoadedModals } from "./modals-registry";

/**
 * Eager front for the permission and space-creation dialogs. The dialogs themselves load on the first
 * prompt. A prompt that cannot load is refused the way the host refuses one (declined, `onDismiss` called,
 * one console error): the request is never approved and never left pending.
 *
 * A prompt waiting for the chunk is registered with the host's prompt registry under its scope, so a reset,
 * sign-out, account change or unregister declines it at once, as it would a prompt on screen. It can never show
 * under a different account once the chunk arrives.
 *
 * A failed chunk load is not fetched again by the browser: it keeps the rejected import for that URL. Every
 * later prompt therefore also fails its load straight away and is declined, each with its own console error.
 * That is deliberate: a declined prompt is the safe outcome, and a retry would not change it.
 */

const loadedModals = (): LoadedModals | undefined =>
  (globalThis as Record<symbol, unknown>)[MODALS_KEY] as LoadedModals | undefined;

/** Scope of a prompt raised without a client's scope: no client can reset it, only the host's teardown. */
const NO_SCOPE: PromptScope = createPromptScope(true);

export interface LazyPrompts {
  showPermissionRequestModal(options: PermissionRequestModalOptions, promptScope?: PromptScope): Promise<PermissionRequestResult>;
  showSpaceCreationModal(options: SpaceCreationModalOptions, promptScope?: PromptScope): Promise<SpaceCreationResult>;
  /**
   * Settles the open prompt as dismissed, and refuses any space-creation prompt still waiting for its dialog to
   * load. Permission prompts waiting for the dialog are not its to withdraw.
   */
  closeActiveModal(): void;
}

/** `loadChunk` imports the dialog chunk, which registers its dialogs when it runs. Exposed so tests can fail or delay it. */
export function createLazyPrompts(loadChunk: () => Promise<unknown>): LazyPrompts {
  let loading: Promise<LoadedModals> | undefined;

  function load(): Promise<LoadedModals> {
    // One shared promise, so waiting prompts resume in the order they were raised.
    if (loading) return loading;
    const ready = loadedModals();
    if (ready) return Promise.resolve(ready);
    loading = loadChunk().then(
      () => {
        const modals = loadedModals();
        if (!modals) throw new Error("the dialog module did not register");
        return modals;
      },
      (error: unknown) => {
        loading = undefined;
        throw error;
      },
    );
    return loading;
  }

  /** Prompts waiting for the dialog chunk. */
  interface Waiting {
    readonly kind: "permission" | "space";
    /** Settles the prompt as refused. Safe to call more than once. */
    readonly refuse: () => void;
  }
  const waiting = new Set<Waiting>();

  function show<T>(
    kind: Waiting["kind"],
    options: { readonly onDismiss?: () => void },
    promptScope: PromptScope | undefined,
    refused: T,
    run: (modals: LoadedModals) => Promise<T>,
  ): Promise<T> {
    const ready = loadedModals();
    // Behind any prompt still waiting for the load: prompts are shown in the order they were raised.
    if (ready && waiting.size === 0) return run(ready);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let release: () => void = () => undefined;
      const entry: Waiting = {
        kind,
        refuse() {
          if (settled) return;
          settled = true;
          waiting.delete(entry);
          release();
          try {
            options.onDismiss?.();
          } finally {
            resolve(refused);
          }
        },
      };
      waiting.add(entry);
      release = holdPrompt(promptScope ?? NO_SCOPE, entry.refuse);
      load().then(
        (modals) => {
          if (settled) return;
          settled = true;
          waiting.delete(entry);
          release();
          try {
            run(modals).then(resolve, reject);
          } catch (error) {
            reject(error);
          }
        },
        (error: unknown) => {
          console.error("TinyCloud: a prompt could not be shown because its dialog failed to load, so it was declined.", error);
          entry.refuse();
        },
      );
    });
  }

  return {
    showPermissionRequestModal: (options, promptScope) =>
      show<PermissionRequestResult>("permission", options, promptScope, { approved: false }, (modals) => modals.showPermissionRequestModal(options, promptScope)),
    showSpaceCreationModal: (options, promptScope) =>
      show<SpaceCreationResult>("space", options, promptScope, { success: false, dismissed: true }, (modals) => modals.showSpaceCreationModal(options, promptScope)),
    closeActiveModal() {
      for (const entry of [...waiting]) if (entry.kind === "space") entry.refuse();
      loadedModals()?.closeActiveModal();
    },
  };
}

// ts-no-dynamic-import: a static import would put both dialogs into the eager root.
export const { showPermissionRequestModal, showSpaceCreationModal, closeActiveModal } = createLazyPrompts(
  () => import("./modals-entry"),
);
