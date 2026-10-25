import { TinyCloudSpaceModal, type SpaceCreationModalOptions, type SpaceCreationResult } from './SpaceCreationModal';
import {
  TinyCloudPermissionRequestModal,
  type PermissionRequestModalOptions,
  type PermissionRequestResult,
} from './PermissionRequestModal';
import { createPromptScope, mountPrompt, type PromptScope } from '../ui/parts/prompts';
import { MODALS_KEY, type LoadedModals } from './modals-registry';

/** Used when a caller shows a prompt without a UI client scope. Tracked by the host like any other. */
const DEFAULT_PROMPT_SCOPE = createPromptScope(true);

type PromptModal = TinyCloudSpaceModal | TinyCloudPermissionRequestModal;

export class ModalManager {
  private static instance: ModalManager;
  private activeModal: PromptModal | null = null;
  private releaseActivePrompt: (() => void) | null = null;

  private constructor() { }

  public static getInstance(): ModalManager {
    if (!ModalManager.instance) {
      ModalManager.instance = new ModalManager();
    }
    return ModalManager.instance;
  }

  public showSpaceCreationModal(
    options: SpaceCreationModalOptions,
    promptScope: PromptScope = DEFAULT_PROMPT_SCOPE,
  ): Promise<SpaceCreationResult> {
    // Close any existing modal first
    this.displaceActiveModal();

    const modal = new TinyCloudSpaceModal({
      ...options,
      onDismiss: () => {
        this.clearActive(modal);
        options.onDismiss?.();
      }
    });

    // Fail closed: a refused prompt is never shown and resolves as dismissed.
    if (!this.present(modal, promptScope, () => modal.dismiss())) {
      options.onDismiss?.();
      return Promise.resolve({ success: false, dismissed: true });
    }

    // Return completion promise and clean up when resolved
    return modal.getCompletionPromise().finally(() => {
      this.clearActive(modal);
    });
  }

  public showPermissionRequestModal(
    options: PermissionRequestModalOptions,
    promptScope: PromptScope = DEFAULT_PROMPT_SCOPE,
  ): Promise<PermissionRequestResult> {
    this.displaceActiveModal();

    const modal = new TinyCloudPermissionRequestModal({
      ...options,
      onDismiss: () => {
        this.clearActive(modal);
        options.onDismiss?.();
      },
    });

    // Fail closed: a refused prompt is never shown and resolves as declined.
    if (!this.present(modal, promptScope, () => modal.dismiss())) {
      options.onDismiss?.();
      return Promise.resolve({ approved: false });
    }

    return modal.getCompletionPromise().finally(() => {
      this.clearActive(modal);
    });
  }

  /** Mounts into the prompt host. Returns true when the prompt mounted, false when it was refused. */
  private present(modal: PromptModal, promptScope: PromptScope, dismiss: () => void): boolean {
    const mount = mountPrompt(promptScope, modal, dismiss);
    if ('refusal' in mount) return false;
    this.activeModal = modal;
    this.releaseActivePrompt = mount.release;
    return true;
  }

  private clearActive(modal: PromptModal): void {
    if (this.activeModal !== modal) return;
    this.releaseActivePrompt?.();
    this.releaseActivePrompt = null;
    this.activeModal = null;
  }

  /**
   * Displaces the open prompt for a new one. A throwing caller onDismiss must not
   * stop the new prompt from mounting, so its error is rethrown asynchronously.
   */
  private displaceActiveModal(): void {
    try {
      this.closeActiveModal();
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }

  /**
   * Settles the open prompt, if any, as dismissed, so its promise never stays
   * pending. The resolved value matches the prompt's close control. Its caller's
   * onDismiss runs once; a prompt that already settled is not dismissed again.
   * The element is removed now, not after its hide delay, so its scroll lock is
   * released before the prompt that replaces it takes the lock.
   */
  public closeActiveModal(): void {
    const modal = this.activeModal;
    if (!modal) return;
    try {
      if (modal.isOpen) modal.dismiss();
    } finally {
      modal.remove();
      this.clearActive(modal);
    }
  }

  public hasActiveModal(): boolean {
    return this.activeModal !== null;
  }
}

// Export convenience function
export const showSpaceCreationModal = (
  options: SpaceCreationModalOptions,
  promptScope?: PromptScope,
): Promise<SpaceCreationResult> => {
  return ModalManager.getInstance().showSpaceCreationModal(options, promptScope);
};

export const showPermissionRequestModal = (
  options: PermissionRequestModalOptions,
  promptScope?: PromptScope,
): Promise<PermissionRequestResult> => {
  return ModalManager.getInstance().showPermissionRequestModal(options, promptScope);
};

// The eager front (lazy-prompts.ts) finds this module through the registry, not through an import.
(globalThis as Record<symbol, unknown>)[MODALS_KEY] = {
  showPermissionRequestModal,
  showSpaceCreationModal,
  closeActiveModal: () => ModalManager.getInstance().closeActiveModal(),
} satisfies LoadedModals;
