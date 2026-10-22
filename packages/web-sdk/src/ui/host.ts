import { createButton, type ButtonView } from "./button";
import type { PanelClientHandle } from "./client";
import type { ResolvedUiConfig } from "./config";
import { createPanel, type PanelHandle, type ShellLayout } from "./panel";
import { HOST_PARTS } from "./parts";
import { toastStore } from "./parts/toasts";
import type { ToastRequest } from "./toast-store";
import { createButtonHideStore, defaultLocalStorage, FALLBACK_APP_ID, resolveUiAppId, type HideScope } from "./persistence";
import { PANEL_SECTIONS } from "./sections";
import type { HostContext, SectionId, StatusCode } from "./slots";
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
  open(section?: SectionId): void;
  openPage(section?: SectionId): void;
  close(): void;
  isOpen(): boolean;
  toast(request: ToastRequest, owner?: number): boolean;
}

interface ClientEntry {
  readonly id: number;
  readonly registration: ClientRegistration;
  signedIn: boolean;
  signedInSeq: number;
}

interface Mounted {
  readonly host: HTMLElement;
  readonly layer: HTMLElement;
  readonly panel: PanelHandle;
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
  const statusListeners = new Set<() => void>();
  const hideStore = createButtonHideStore(defaultLocalStorage);
  const board = createStatusBoard((top) => {
    mounted?.button?.setStatus(top);
    mounted?.panel.setStatus(top);
    for (const cb of [...statusListeners]) cb();
  });

  let nextId = 1;
  let signInSeq = 0;
  let isPanelOpen = false;
  let layout: ShellLayout = "drawer";
  let activeSection: SectionId | undefined;
  let buttonHidden = false;
  let mounted: Mounted | undefined;
  let disposers: Array<() => void> = [];
  let rejectionListening = false;

  /** Host-owned: listens while a client is registered and the primary client allows toasts. */
  function syncRejectionListener(): void {
    const listen = clients.size > 0 && primaryConfig()?.toasts !== false;
    if (listen === rejectionListening) return;
    rejectionListening = listen;
    if (listen) globalThis.addEventListener("unhandledrejection", onUnhandledRejection);
    else globalThis.removeEventListener("unhandledrejection", onUnhandledRejection);
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

  /** The first registered client wins for button, position, mode, and appId. */
  function primaryConfig(): ResolvedUiConfig | undefined {
    return [...clients.values()][0]?.registration.config;
  }

  function hideScope(): HideScope {
    return {
      origin: globalThis.location.origin,
      appId: resolveUiAppId(primaryConfig()?.appId, activeEntry()?.registration.manifestAppId()),
    };
  }

  /** `ui.mode` decides the layout: `sidebar` and `page` are fixed; `both` honours the request. */
  function resolveLayout(requested: ShellLayout): ShellLayout {
    const mode = primaryConfig()?.mode ?? "both";
    if (mode === "page") return "page";
    if (mode === "sidebar") return "drawer";
    return requested;
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
    topStatus: () => board.top(),
    onStatusChange(cb) {
      statusListeners.add(cb);
      return () => {
        statusListeners.delete(cb);
      };
    },
    toastsEnabled: () => primaryConfig()?.toasts !== false,
    toast: (t) => (context.toastsEnabled() ? toastStore.push(t) : null),
    text,
    appLabel() {
      const appId = hideScope().appId;
      return appId === FALLBACK_APP_ID ? undefined : appId;
    },
    canHideButton: () => primaryConfig()?.button === true,
    hideButton: hideFromPanel,
  };

  function closeSections(): void {
    for (const dispose of disposers) dispose();
    disposers = [];
  }

  /** Lays out the shell and mounts exactly one available section while open. */
  function renderPanel(): void {
    closeSections();
    if (!mounted) return;
    const available = PANEL_SECTIONS.filter((section) => section.isAvailable(context));
    const current = available.find((section) => section.id === activeSection) ?? available[0];
    activeSection = current?.id;
    mounted.panel.setLayout(layout, (primaryConfig()?.mode ?? "both") === "both");
    mounted.panel.setAppLabel(context.appLabel());
    mounted.panel.setNav(available, activeSection);
    if (!isPanelOpen || !current) return;
    const el = document.createElement("section");
    el.className = "section";
    el.dataset.section = current.id;
    mounted.panel.main.replaceChildren(el);
    const dispose = current.mount(el, context);
    disposers.push(() => {
      dispose();
      el.remove();
    });
  }

  function syncDom(): void {
    if (!mounted) return;
    mounted.host.setAttribute("data-tinycloud-ui", isPanelOpen ? "open" : buttonHidden ? "hidden" : "closed");
    mounted.layer.setAttribute("data-layout", layout);
    mounted.layer.toggleAttribute("data-panel-open", isPanelOpen);
    mounted.panel.setOpen(isPanelOpen);
    mounted.button?.setExpanded(isPanelOpen);
    mounted.button?.setHidden(buttonHidden);
  }

  /** Opens (or switches to) the requested layout. The mode may override the request. */
  function openAt(requested: ShellLayout, section?: SectionId): void {
    if (!mounted) return;
    const wasOpen = isPanelOpen;
    const previous = layout;
    layout = resolveLayout(requested);
    if (section !== undefined) activeSection = section;
    isPanelOpen = true;
    syncDom();
    renderPanel();
    if (!wasOpen || layout !== previous) mounted.panel.focusFirst();
  }

  /** Closing never changes the hidden flag. Focus returns to the button only when the shell owned focus. */
  function closeShell(returnFocus: boolean): void {
    if (!isPanelOpen) return;
    isPanelOpen = false;
    syncDom();
    renderPanel();
    if (returnFocus) mounted?.button?.focus();
  }

  /** Overview's hide control: persists the flag and closes. */
  function hideFromPanel(): void {
    hideStore.write(hideScope(), true);
    buttonHidden = true;
    closeShell(false);
  }

  /** `open()` and `openPage()`: clear the hidden flag, restore the button, then open. */
  function reveal(requested: ShellLayout, section?: SectionId): void {
    if (!mounted) return;
    if (primaryConfig()?.button) {
      hideStore.write(hideScope(), false);
      buttonHidden = false;
    }
    openAt(requested, section);
  }

  function mount(config: ResolvedUiConfig): Mounted {
    const host = document.createElement("div");
    host.setAttribute("style", HOST_STYLE);
    const root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = HOST_CSS;

    const layer = document.createElement("div");
    layer.className = "layer";
    layer.setAttribute("data-position", config.position);

    const panel = createPanel({
      onClose: () => closeShell(true),
      onEscape: () => closeShell(true),
      onLayout: (target) => openAt(target),
      onNavigate(id) {
        activeSection = id;
        renderPanel();
      },
    });
    const button = config.button ? createButton(() => (isPanelOpen ? closeShell(true) : openAt("drawer"))) : undefined;
    if (button) layer.append(button.el);
    layer.append(panel.el);

    root.append(style, layer);
    (document.body ?? document.documentElement).append(host);

    const stopParts = HOST_PARTS.map((part) => part.start(context, layer));
    return { host, layer, panel, button, stopParts };
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
    syncRejectionListener();
    if (!mounted) return;
    closeSections();
    for (const stop of mounted.stopParts) stop();
    mounted.host.remove();
    mounted = undefined;
    isPanelOpen = false;
    buttonHidden = false;
    layout = "drawer";
  }

  function notifyClientChange(): void {
    for (const listener of [...clientListeners]) listener();
    renderPanel();
  }

  return {
    nextClientId: () => nextId++,

    register(id, registration) {
      clients.set(id, { id, registration, signedIn: false, signedInSeq: 0 });
      observeSignIns();
      syncRejectionListener();
      ensureMounted();
      notifyClientChange();
    },

    unregister(id) {
      clients.delete(id);
      if (clients.size === 0) {
        unmount();
        return;
      }
      syncRejectionListener();
      notifyClientChange();
    },

    reset(id) {
      const entry = clients.get(id);
      if (!entry) return;
      toastStore.clearOwner(id);
      const wasActive = activeEntry()?.id === id;
      entry.signedIn = false;
      entry.registration.handle.reset();
      if (wasActive) closeShell(false);
      notifyClientChange();
    },

    open: (section) => reveal("drawer", section),
    openPage: (section) => reveal("page", section),

    close() {
      closeShell(false);
    },

    isOpen: () => isPanelOpen,
    toast(request, owner) {
      if (primaryConfig()?.toasts === false) return false;
      toastStore.push(request, owner);
      return true;
    },
  };
}
