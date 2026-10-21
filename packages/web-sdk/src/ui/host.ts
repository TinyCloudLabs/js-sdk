import { createButton, type ButtonView } from "./button";
import type { PanelClientHandle } from "./client";
import type { ResolvedUiConfig } from "./config";
import { createPanel, type PanelView } from "./panel";
import { HOST_PARTS } from "./parts";
import { toastStore } from "./parts/toasts";
import type { ToastRequest } from "./toast-store";
import { createButtonHideStore, defaultLocalStorage, resolveUiAppId, type HideScope } from "./persistence";
import { PANEL_SECTIONS } from "./sections";
import type { HostContext, StatusCode } from "./slots";
import { createStatusBoard } from "./status";
import { text } from "./strings";
import { HOST_CSS } from "./styles";

/** Global registry key. Shared across bundled copies of the SDK on one page. */
export const REGISTRY_KEY = Symbol.for("tinycloud.web-sdk.ui-host");
export const HOST_API_VERSION = 1;

/** Below OpenKey (999999); the host stacking context contains every panel element. */
const HOST_STYLE = "position:fixed;inset:0;pointer-events:none;z-index:999990;isolation:isolate;";

export interface ClientRegistration {
  readonly handle: PanelClientHandle;
  readonly config: ResolvedUiConfig;
  readonly manifestAppId: () => string | undefined;
}

export interface HostRuntime {
  nextClientId(): number;
  register(id: number, registration: ClientRegistration): void;
  unregister(id: number): void;
  reset(id: number): void;
  open(): void;
  close(): void;
  isOpen(): boolean;
  toast(request: ToastRequest, owner?: number): void;
}

interface ClientEntry {
  readonly id: number;
  readonly registration: ClientRegistration;
  signedIn: boolean;
  signedInSeq: number;
}

interface Mounted {
  readonly host: HTMLElement;
  readonly panel: PanelView;
  readonly button: ButtonView | undefined;
  readonly stopParts: Array<() => void>;
}

/** Only rejections raised by TinyCloud code. */
function isSdkRejection(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null) return false;
  const { message, stack } = reason as { message?: unknown; stack?: unknown };
  if (typeof message === "string" && /tinycloud|TinyCloud/.test(message)) return true;
  return typeof stack === "string" && stack.includes("tinycloud");
}

function onUnhandledRejection(event: PromiseRejectionEvent): void {
  if (isSdkRejection(event.reason)) {
    toastStore.push({ kind: "error", textCode: "toast.unexpected_error" });
  }
}

export function createHostRuntime(): HostRuntime {
  const clients = new Map<number, ClientEntry>();
  const clientListeners = new Set<() => void>();
  const hideStore = createButtonHideStore(defaultLocalStorage);
  const board = createStatusBoard((top) => {
    mounted?.button?.setStatus(top);
    mounted?.panel.setStatus(top);
  });

  let nextId = 1;
  let signInSeq = 0;
  let isPanelOpen = false;
  let buttonHidden = false;
  let mounted: Mounted | undefined;
  let disposers: Array<() => void> = [];
  let rejectionListening = false;

  /** Host-owned: attached on the first register, detached when the last client leaves. */
  function attachRejectionListener(): void {
    if (rejectionListening) return;
    rejectionListening = true;
    globalThis.addEventListener("unhandledrejection", onUnhandledRejection);
  }

  function detachRejectionListener(): void {
    if (!rejectionListening) return;
    rejectionListening = false;
    globalThis.removeEventListener("unhandledrejection", onUnhandledRejection);
  }

  /** Records the order in which clients were first seen signed in. */
  function observeSignIns(): void {
    for (const entry of clients.values()) {
      const signedIn = entry.registration.handle.client.signedIn();
      if (signedIn && !entry.signedIn) entry.signedInSeq = ++signInSeq;
      entry.signedIn = signedIn;
    }
  }

  /** Most recently signed-in client; else the latest registered. */
  function activeEntry(): ClientEntry | undefined {
    observeSignIns();
    let best: ClientEntry | undefined;
    let latest: ClientEntry | undefined;
    for (const entry of clients.values()) {
      latest = entry;
      if (entry.signedIn && (best === undefined || entry.signedInSeq > best.signedInSeq)) best = entry;
    }
    return best ?? latest;
  }

  /** The first registered client wins for button, position, and appId. */
  function primaryConfig(): ResolvedUiConfig | undefined {
    return [...clients.values()][0]?.registration.config;
  }

  function hideScope(): HideScope {
    return {
      origin: globalThis.location.origin,
      appId: resolveUiAppId(primaryConfig()?.appId, activeEntry()?.registration.manifestAppId()),
    };
  }

  const context: HostContext = {
    client: () => activeEntry()?.registration.handle.client,
    onClientChange(cb) {
      clientListeners.add(cb);
      return () => {
        clientListeners.delete(cb);
      };
    },
    developerMode: () => [...clients.values()].some((entry) => entry.registration.config.developerMode),
    setStatus: (source, status) => board.set(source, status),
    toast: (t) => toastStore.push(t),
    openPanel: () => setOpen(true),
    closePanel: () => setOpen(false),
    text,
  };

  function closeSections(): void {
    for (const dispose of disposers) dispose();
    disposers = [];
  }

  /** Sections are mounted only while the panel is open. */
  function renderSections(): void {
    closeSections();
    if (!mounted || !isPanelOpen) return;
    for (const section of PANEL_SECTIONS) {
      if (!section.isAvailable(context)) continue;
      const el = document.createElement("section");
      el.className = "section";
      el.dataset.section = section.id;
      mounted.panel.body.append(el);
      const dispose = section.mount(el, context);
      disposers.push(() => {
        dispose();
        el.remove();
      });
    }
  }

  function syncDom(): void {
    if (!mounted) return;
    mounted.host.setAttribute("data-tinycloud-ui", isPanelOpen ? "open" : buttonHidden ? "hidden" : "closed");
    mounted.panel.setOpen(isPanelOpen);
    mounted.button?.setExpanded(isPanelOpen);
    mounted.button?.setHidden(buttonHidden);
  }

  function setOpen(next: boolean): void {
    if (next && !mounted) return;
    const wasOpen = isPanelOpen;
    isPanelOpen = next;
    syncDom();
    renderSections();
    if (next && !wasOpen) mounted?.panel.focusFirst();
  }

  /** The panel's hide control: persists the flag and closes. */
  function hideFromPanel(): void {
    hideStore.write(hideScope(), true);
    buttonHidden = true;
    setOpen(false);
  }

  function mount(config: ResolvedUiConfig): Mounted {
    const host = document.createElement("div");
    host.setAttribute("style", HOST_STYLE);
    const root = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = HOST_CSS;

    const layer = document.createElement("div");
    layer.className = "layer";
    layer.setAttribute("data-position", config.position);

    const panel = createPanel({
      hideAvailable: config.button,
      onHide: hideFromPanel,
      onClose: () => setOpen(false),
      onEscape: () => {
        setOpen(false);
        mounted?.button?.focus();
      },
    });
    layer.append(panel.el);

    const button = config.button ? createButton(() => setOpen(!isPanelOpen)) : undefined;
    if (button) layer.append(button.el);

    root.append(style, layer);
    (document.body ?? document.documentElement).append(host);

    const stopParts = HOST_PARTS.map((part) => part.start(context, layer));
    return { host, panel, button, stopParts };
  }

  function ensureMounted(): void {
    if (mounted) return;
    const config = primaryConfig();
    if (!config) return;
    mounted = mount(config);
    mounted.button?.setStatus(board.top());
    mounted.panel.setStatus(board.top());
    buttonHidden = config.button && hideStore.read(hideScope());
    syncDom();
  }

  function unmount(): void {
    detachRejectionListener();
    if (!mounted) return;
    closeSections();
    for (const stop of mounted.stopParts) stop();
    mounted.host.remove();
    mounted = undefined;
    isPanelOpen = false;
    buttonHidden = false;
  }

  function notifyClientChange(): void {
    for (const listener of [...clientListeners]) listener();
    renderSections();
  }

  return {
    nextClientId: () => nextId++,

    register(id, registration) {
      clients.set(id, { id, registration, signedIn: false, signedInSeq: 0 });
      observeSignIns();
      attachRejectionListener();
      ensureMounted();
      notifyClientChange();
    },

    unregister(id) {
      clients.delete(id);
      if (clients.size === 0) {
        unmount();
        return;
      }
      notifyClientChange();
    },

    reset(id) {
      const entry = clients.get(id);
      if (!entry) return;
      toastStore.clearOwner(id);
      const wasActive = activeEntry()?.id === id;
      entry.signedIn = false;
      entry.registration.handle.reset();
      if (wasActive) setOpen(false);
      notifyClientChange();
    },

    /** Clears the hide flag, shows the button (unless button is disabled), and opens the panel. */
    open() {
      if (!mounted) return;
      if (primaryConfig()?.button) {
        hideStore.write(hideScope(), false);
        buttonHidden = false;
      }
      setOpen(true);
    },

    close() {
      setOpen(false);
    },

    isOpen: () => isPanelOpen,
    toast(request, owner) {
      toastStore.push(request, owner);
    },
  };
}
