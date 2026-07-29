import { debug } from "../utils/debug";

export interface SpaceCreationModalOptions {
  onCreateSpace: () => Promise<void>;
  onDismiss?: () => void;
}

export interface SpaceCreationResult {
  success: boolean;
  dismissed: boolean;
}

export class TinyCloudSpaceModal extends HTMLElement {
  private options: SpaceCreationModalOptions;
  private isVisible: boolean = false;
  private isCreating: boolean = false;
  private resolveResult: ((result: SpaceCreationResult) => void) | null = null;
  private completionPromise: Promise<SpaceCreationResult>;

  constructor(options: SpaceCreationModalOptions) {
    super();
    this.options = options;
    this.attachShadow({ mode: 'open' });
    this.render();

    // Create completion promise
    this.completionPromise = new Promise<SpaceCreationResult>((resolve) => {
      this.resolveResult = resolve;
    });
  }

  public getCompletionPromise(): Promise<SpaceCreationResult> {
    return this.completionPromise;
  }

  connectedCallback() {
    this.show();
    this.setupEventListeners();
  }

  disconnectedCallback() {
    // The modal can now be torn down programmatically (e.g. when the
    // confirmation times out), not just via hide(), so all document-level
    // state has to be released here too.
    this.isVisible = false;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', this.handleKeyDown);
  }

  private render() {
    this.shadowRoot!.innerHTML = `
      <style>${this.getModalStyles()}</style>
      <div class="modal-backdrop" data-state="hidden">
        <div class="modal-container">
          <div class="modal-content">
            <div class="modal-header">
              <div class="modal-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/>
                  <path d="M8 12l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </div>
              <h2 class="modal-title">Create Your TinyCloud Space</h2>
              <button class="modal-close" aria-label="Close">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
              </button>
            </div>

            <div class="modal-body">
              <p class="modal-description">
                A TinyCloud Space is your personal data container where only you control access.
                Your signature is required for any operations on the data stored there.
              </p>
              <p class="modal-subdescription">
                Sign a message to create your space and start storing data.
              </p>
            </div>

            <div class="modal-actions">
              <button class="modal-button modal-button--secondary" data-action="learn-more">
                Learn More
              </button>
              <button class="modal-button modal-button--primary" data-action="create">
                <span class="button-text">Create TinyCloud Space</span>
                <span class="button-spinner" data-state="hidden">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="9.42 9.42" opacity="0.25"/>
                    <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="9.42 9.42" stroke-dashoffset="9.42">
                      <animateTransform attributeName="transform" type="rotate" values="0 8 8;360 8 8" dur="1s" repeatCount="indefinite"/>
                    </circle>
                  </svg>
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private getModalStyles(): string {
    return `
      :host {
        --modal-bg: hsl(0 0% 3.9%);
        --modal-border: hsl(0 0% 14.9%);
        --modal-foreground: hsl(0 0% 98%);
        --modal-muted: hsl(0 0% 63.9%);
        --modal-accent: hsl(217 91% 60%);
        --modal-accent-hover: hsl(217 91% 65%);
        --modal-secondary: hsl(0 0% 10%);
        --modal-secondary-hover: hsl(0 0% 15%);
        --modal-overlay: rgba(0, 0, 0, 0.5);
      }

      .modal-backdrop {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: var(--modal-overlay);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        z-index: 2000000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        opacity: 0;
        transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        pointer-events: none;
      }

      .modal-backdrop[data-state="visible"] {
        opacity: 1;
        pointer-events: auto;
      }

      .modal-container {
        transform: scale(0.95) translateY(10px);
        transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      }

      .modal-backdrop[data-state="visible"] .modal-container {
        transform: scale(1) translateY(0);
      }

      .modal-content {
        background: var(--modal-bg);
        border: 1px solid var(--modal-border);
        border-radius: 16px;
        box-shadow:
          0 25px 50px -12px rgba(0, 0, 0, 0.25),
          0 0 0 1px rgba(255, 255, 255, 0.05);
        max-width: 480px;
        width: 100%;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        color: var(--modal-foreground);
      }

      .modal-header {
        padding: 24px 24px 0 24px;
        display: flex;
        align-items: flex-start;
        gap: 16px;
        position: relative;
      }

      .modal-icon {
        flex-shrink: 0;
        width: 48px;
        height: 48px;
        background: var(--modal-accent);
        border-radius: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        margin-top: 4px;
      }

      .modal-title {
        flex: 1;
        font-size: 20px;
        font-weight: 600;
        line-height: 1.3;
        margin: 0;
        margin-top: 8px;
      }

      .modal-close {
        position: absolute;
        top: 0;
        right: 0;
        background: transparent;
        border: none;
        color: var(--modal-muted);
        cursor: pointer;
        padding: 8px;
        border-radius: 6px;
        opacity: 0.7;
        transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .modal-close:hover {
        opacity: 1;
        background: var(--modal-secondary);
        color: var(--modal-foreground);
      }

      .modal-body {
        padding: 24px;
        padding-top: 20px;
      }

      .modal-description {
        font-size: 16px;
        line-height: 1.5;
        margin: 0 0 12px 0;
        color: var(--modal-foreground);
      }

      .modal-subdescription {
        font-size: 14px;
        line-height: 1.4;
        margin: 0;
        color: var(--modal-muted);
      }

      .modal-actions {
        padding: 0 24px 24px 24px;
        display: flex;
        gap: 12px;
        justify-content: flex-end;
      }

      .modal-button {
        padding: 12px 20px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
        border: 1px solid transparent;
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 100px;
        justify-content: center;
        position: relative;
      }

      .modal-button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .modal-button--secondary {
        background: var(--modal-secondary);
        border-color: var(--modal-border);
        color: var(--modal-foreground);
      }

      .modal-button--secondary:hover:not(:disabled) {
        background: var(--modal-secondary-hover);
        border-color: hsl(0 0% 25%);
        transform: translateY(-1px);
      }

      .modal-button--primary {
        background: var(--modal-accent);
        color: white;
      }

      .modal-button--primary:hover:not(:disabled) {
        background: var(--modal-accent-hover);
        transform: translateY(-1px);
      }

      .modal-button--primary:active:not(:disabled) {
        transform: translateY(0);
      }

      .button-spinner {
        display: none;
      }

      .button-spinner[data-state="visible"] {
        display: flex;
      }

      .modal-button[data-state="loading"] .button-text {
        opacity: 0;
      }

      .modal-button[data-state="loading"] .button-spinner {
        display: flex;
        position: absolute;
      }

      @media (max-width: 640px) {
        .modal-content {
          max-width: 100%;
          margin: 0 16px;
          border-radius: 12px;
        }

        .modal-header {
          padding: 20px 20px 0 20px;
        }

        .modal-body {
          padding: 20px;
          padding-top: 16px;
        }

        .modal-actions {
          padding: 0 20px 20px 20px;
          flex-direction: column-reverse;
        }

        .modal-button {
          width: 100%;
        }
      }
    `;
  }

  private setupEventListeners(): void {
    const backdrop = this.shadowRoot!.querySelector('.modal-backdrop');
    const closeButton = this.shadowRoot!.querySelector('.modal-close');
    const learnMoreButton = this.shadowRoot!.querySelector('[data-action="learn-more"]');
    const createButton = this.shadowRoot!.querySelector('[data-action="create"]');

    backdrop?.addEventListener('click', (e) => {
      if (e.target === backdrop && !this.isCreating) {
        this.dismiss();
      }
    });

    closeButton?.addEventListener('click', () => {
      if (!this.isCreating) {
        this.dismiss();
      }
    });

    learnMoreButton?.addEventListener('click', () => {
      window.open('https://tinycloud.xyz', '_blank', 'noopener,noreferrer');
    });

    createButton?.addEventListener('click', () => {
      if (!this.isCreating) {
        this.handleCreateSpace();
      }
    });

    // Handle escape key. `handleKeyDown` is already an instance-bound arrow
    // function — binding again here would create a new reference that
    // removeEventListener could never match, leaking the listener.
    document.addEventListener('keydown', this.handleKeyDown);
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this.isVisible && !this.isCreating) {
      this.dismiss();
    }
  };

  private async handleCreateSpace(): Promise<void> {
    this.isCreating = true;
    const createButton = this.shadowRoot!.querySelector('[data-action="create"]') as HTMLElement;

    createButton.setAttribute('data-state', 'loading');
    createButton.setAttribute('disabled', 'true');

    try {
      await this.options.onCreateSpace();
      // Space creation succeeded
      this.resolveResult?.({ success: true, dismissed: false });
      this.hide();
    } catch (error) {
      console.error('[TinyCloud] Space creation failed:', error);
      // Don't close modal on error - let user try again or dismiss manually
    } finally {
      this.isCreating = false;
      createButton.removeAttribute('data-state');
      createButton.removeAttribute('disabled');
    }
  }

  private show(): void {
    this.isVisible = true;
    document.body.style.overflow = 'hidden';

    requestAnimationFrame(() => {
      const backdrop = this.shadowRoot!.querySelector('.modal-backdrop');
      backdrop?.setAttribute('data-state', 'visible');
    });
  }

  private hide(): void {
    const backdrop = this.shadowRoot!.querySelector('.modal-backdrop');
    backdrop?.setAttribute('data-state', 'hidden');

    setTimeout(() => {
      this.remove();
      document.body.style.overflow = '';
      document.removeEventListener('keydown', this.handleKeyDown);
    }, 200);

    this.isVisible = false;
  }

  private dismiss(): void {
    this.resolveResult?.({ success: false, dismissed: true });
    this.options.onDismiss?.();
    this.hide();
  }
}

customElements.define('tinycloud-space-modal', TinyCloudSpaceModal);
