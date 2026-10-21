import { TinyCloudSpaceModal, type SpaceCreationModalOptions, type SpaceCreationResult } from './SpaceCreationModal';
import {
  TinyCloudPermissionRequestModal,
  type PermissionRequestModalOptions,
  type PermissionRequestResult,
} from './PermissionRequestModal';
import { createPromptScope, mountPrompt, type PromptScope } from '../ui/parts/prompts';

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
    this.closeActiveModal();

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
    this.closeActiveModal();

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

  public closeActiveModal(): void {
    if (this.activeModal) {
      this.releaseActivePrompt?.();
      this.releaseActivePrompt = null;
      this.activeModal.remove();
      this.activeModal = null;
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
