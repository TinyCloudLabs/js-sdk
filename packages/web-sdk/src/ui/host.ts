import { createButton, type ButtonView } from "./button";
import type { PanelClientHandle } from "./client";
import type { ResolvedUiConfig } from "./config";
import type { ShellLayout } from "./panel";
import type { ArmOptions } from "./panel-data-entry";
import type * as PanelEntry from "./panel-entry";
import { createPendingPanel, type PendingPanel } from "./pending";
import { HOST_PARTS } from "./parts";
import { hasMountedPrompt } from "./parts/prompts";
import { toastStore } from "./parts/toasts";
import type { ToastRequest } from "./toast-store";
import { createButtonHideStore, defaultLocalStorage, FALLBACK_APP_ID, resolveUiAppId, type HideScope } from "./persistence";
import { watchPhone } from "./phone";
import type { HostContext, PanelClient, SectionId, StatusCode } from "./slots";
import { createStatusBoard } from "./status";
import { text } from "./strings";
import { HOST_CSS } from "./styles";

/** Global registry key. Shared across bundled copies of the SDK on one page. */
export const REGISTRY_KEY = Symbol.for("tinycloud.web-sdk.ui-host");
export const HOST_API_VERSION = 1;

/** The only eager import of the lazy panel-data entry. Every gate lives in that module. */
export function armPanelData(client: PanelClient, opts: ArmOptions): void {
  void import("./panel-data-entry").then((m) => m.arm(client, opts), () => undefined);
}

/** Below OpenKey (999999); the host stacking context contains every panel element. */
const HOST_STYLE = "position:fixed;inset:0;pointer-events:none;z-index:999990;isolation:isolate;";

type PanelEntryModule = typeof PanelEntry;

export interface ClientRegistration {
  readonly handle: PanelClientHandle;
  readonly config: ResolvedUiConfig;
  readonly manifestAppId: () => string | undefined;
  readonly manifestName?: () => string | undefined;
}

export interface HostRuntime {
  nextClientId(): number;
  register(id: number, registration: ClientRegistration): void;
  unregister(id: number): void;
  reset(id: number): void;
  open(section?: SectionId): void;
  /** Absent on a runtime created by an older web-sdk bundle that shares the page. */
  setButtonVisible?(visible: boolean): void;
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
  readonly root: ShadowRoot;
  readonly layer: HTMLElement;
  readonly pending: PendingPanel;
  /** Set once the lazy panel chunk has attached to this mount. */
  panel?: PanelEntry.ShellPanel;
  button: ButtonView | undefined;
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
  const buttonListeners = new Set<() => void>();
  const hideStore = createButtonHideStore(defaultLocalStorage);
  const board = createStatusBoard((top) => {
    mounted?.button?.setStatus(top);
    mounted?.panel?.setStatus(top);
    for (const cb of [...statusListeners]) cb();
  });

  let nextId = 1;
  let signInSeq = 0;
  let isPanelOpen = false;
  let layout: ShellLayout = "drawer";
  /** Phone state while mounted. Phones show the full page; `layout` keeps the desktop choice. */
  let phone = false;
  let stopPhone: (() => void) | undefined;
  let pendingSection: SectionId | undefined;
  let buttonHidden = false;
  /** The host's `setButtonVisible` choice for this page session; undefined until it is called. */
  let buttonOverride: boolean | undefined;
  let mounted: Mounted | undefined;
  let rejectionListening = false;
  /** Cached per page: the panel chunk loads once, then attaches to each mount. */
  let panelModule: PanelEntryModule | undefined;
  /** The mount whose panel chunk is in flight; cleared when that load settles. */
  let loadingFor: Mounted | undefined;

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

  /** What the shell shows. Phones always get the full page; `layout` keeps the desktop choice for a resize back. */
  function shownLayout(): ShellLayout {
    return phone ? "page" : layout;
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
      const named = activeEntry()?.registration.manifestName?.();
      if (named !== undefined) return named;
      const appId = hideScope().appId;
      return appId === FALLBACK_APP_ID ? undefined : appId;
    },
    canHideButton: buttonOn,
    onButtonChange(cb) {
      buttonListeners.add(cb);
      return () => {
        buttonListeners.delete(cb);
      };
    },
    hideButton: hideFromPanel,
  };

  /** Hands the shell its view. The shell keeps the mounted section; `pendingSection` applies once. */
  function renderPanel(): void {
    const panel = mounted?.panel;
    if (!panel) return;
    const section = pendingSection;
    pendingSection = undefined;
    panel.render({
      open: isPanelOpen,
      layout: shownLayout(),
      phone,
      showLayoutToggle: !phone && (primaryConfig()?.mode ?? "both") === "both",
      section,
    });
  }

  function syncDom(): void {
    if (!mounted) return;
    mounted.host.setAttribute("data-tinycloud-ui", isPanelOpen ? "open" : buttonHidden ? "hidden" : "closed");
    mounted.layer.setAttribute("data-layout", shownLayout());
    mounted.layer.toggleAttribute("data-phone", phone);
    mounted.layer.toggleAttribute("data-panel-open", isPanelOpen);
    (mounted.panel ?? mounted.pending).setOpen(isPanelOpen);
    mounted.button?.setExpanded(isPanelOpen);
    mounted.button?.setHidden(buttonHidden);
  }

  /** Opens (or switches to) the requested layout. The mode may override the request. */
  function openAt(requested: ShellLayout, section?: SectionId): void {
    if (!mounted) return;
    const wasOpen = isPanelOpen;
    const previous = shownLayout();
    layout = resolveLayout(requested);
    if (section !== undefined) pendingSection = section;
    isPanelOpen = true;
    syncDom();
    const panel = mounted.panel;
    if (!panel) {
      requestPanel();
      return;
    }
    renderPanel();
    if ((!wasOpen || shownLayout() !== previous) && !hasMountedPrompt()) panel.focusFirst();
  }

  /** Closing never changes the hidden flag. Focus returns to the drawer's opener, else the button, only when the shell owned focus. */
  function closeShell(returnFocus: boolean): void {
    if (!isPanelOpen) return;
    isPanelOpen = false;
    syncDom();
    renderPanel();
    if (returnFocus && !mounted?.panel?.restoreFocus()) mounted?.button?.focus();
  }

  /** Overview's hide control: persists the flag and closes. */
  function hideFromPanel(): void {
    hideStore.write(hideScope(), true);
    buttonHidden = true;
    closeShell(false);
  }

  /** Whether the button is part of the page: the host's `setButtonVisible` choice, else `ui.button`. */
  function buttonOn(): boolean {
    return buttonOverride ?? primaryConfig()?.button === true;
  }

  /** Creates the floating button as the layer's first child, ahead of the panel stand-in. */
  function makeButton(layer: HTMLElement): ButtonView {
    const button = createButton(() => (isPanelOpen ? closeShell(true) : openAt("drawer")), requestPanel);
    button.setStatus(board.top());
    layer.prepend(button.el);
    return button;
  }

  /** `true` shows the button (even under `ui.button: false`) and clears the stored hidden flag; `false` hides it and leaves the stored flag alone. */
  function setButtonVisible(visible: boolean): void {
    buttonOverride = visible;
    if (!mounted) return;
    if (visible) {
      hideStore.write(hideScope(), false);
      buttonHidden = false;
      if (mounted.button === undefined) mounted.button = makeButton(mounted.layer);
    } else {
      buttonHidden = true;
    }
    syncDom();
    for (const listener of [...buttonListeners]) listener();
  }

  /** `open()` and `openPage()`: clear the hidden flag, restore the button, then open. */
  function reveal(requested: ShellLayout, section?: SectionId): void {
    if (!mounted) return;
    if (buttonOn()) {
      hideStore.write(hideScope(), false);
      buttonHidden = false;
      if (mounted.button === undefined) mounted.button = makeButton(mounted.layer);
    }
    openAt(requested, section);
  }

  /**
   * Loads the panel chunk on first open or launcher hover/focus. The module is
   * cached for the page; each mount attaches its own panel. The pending
   * stand-in shows loading, then a neutral error with Retry if the chunk fails.
   */
  function requestPanel(): void {
    const client = activeEntry()?.registration.handle.client;
    if (client) armPanelData(client, { now: true });
    const owner = mounted;
    if (!owner || owner.panel || loadingFor === owner) return;
    if (panelModule) {
      attachPanel(owner, panelModule);
      return;
    }
    loadingFor = owner;
    owner.pending.showLoading();
    // ts-no-dynamic-import: a static import would put the panel shell, sections and
    // PANEL_CSS into the eager root and break its 12 KiB gzip budget (contracts-ade §1.4).
    import("./panel-entry")
      .then((entry) => {
        panelModule = entry;
        if (loadingFor === owner) loadingFor = undefined;
        if (mounted === owner) attachPanel(owner, entry);
      })
      .catch(() => {
        if (loadingFor === owner) loadingFor = undefined;
        if (mounted === owner) owner.pending.showError(requestPanel);
      });
  }

  /** Replaces the pending stand-in with the real panel. Focuses it if it opened meanwhile. */
  function attachPanel(owner: Mounted, entry: PanelEntryModule): void {
    const panel = entry.mountPanel(owner.root, {
      onClose: () => closeShell(true),
      onEscape: () => closeShell(true),
      onLayout: (target) => openAt(target),
    }, context, toastStore);
    owner.pending.el.replaceWith(panel.el);
    owner.panel = panel;
    panel.setStatus(board.top());
    syncDom();
    renderPanel();
    if (isPanelOpen && !hasMountedPrompt()) panel.focusFirst();
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

    const pending = createPendingPanel(() => closeShell(true));
    const button = (buttonOverride ?? config.button) ? makeButton(layer) : undefined;
    layer.append(pending.el);

    root.append(style, layer);
    (document.body ?? document.documentElement).append(host);

    const stopParts = HOST_PARTS.map((part) => part.start(context, layer));
    return { host, root, layer, pending, button, stopParts };
  }

  function ensureMounted(): void {
    if (mounted) return;
    const config = primaryConfig();
    if (!config) return;
    mounted = mount(config);
    const watch = watchPhone(onPhoneChange);
    phone = watch.phone;
    stopPhone = watch.stop;
    mounted.button?.setStatus(board.top());
    buttonHidden = buttonOverride === false || (buttonOn() && hideStore.read(hideScope()));
    syncDom();
  }

  function unmount(): void {
    syncRejectionListener();
    if (!mounted) return;
    mounted.panel?.dispose();
    for (const stop of mounted.stopParts) stop();
    mounted.host.remove();
    mounted = undefined;
    isPanelOpen = false;
    buttonHidden = false;
    layout = "drawer";
    stopPhone?.();
    stopPhone = undefined;
    phone = false;
  }

  function notifyClientChange(): void {
    for (const listener of [...clientListeners]) listener();
    renderPanel();
  }

  /** A breakpoint crossing keeps open state and section. Focus moves to the panel if the replaced section held it. */
  function onPhoneChange(next: boolean): void {
    if (!mounted || phone === next) return;
    phone = next;
    const hadFocus = mounted.root.activeElement !== null;
    syncDom();
    renderPanel();
    if (hadFocus && mounted.root.activeElement === null) mounted.panel?.focusFirst();
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
    setButtonVisible,
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
