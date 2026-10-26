import { createUiApi, type TinyCloudUI, type UiTarget } from "./api";
import { createPanelClient, type ClientSource } from "./client";
import type { PanelDataFactory, PanelDataHost } from "./data";
import { resolveUiConfig, type UiConfig } from "./config";
import { canRenderUi } from "./frame-guard";
import { HOST_API_VERSION, REGISTRY_KEY, armPanelData, createHostRuntime, type HostRuntime } from "./host";
import type { ToastRequest } from "./toast-store";
import { createPromptScope, dismissPrompts, type PromptScope } from "./parts/prompts";

export type { TinyCloudUI } from "./api";
export type { UiConfig, UiPosition } from "./config";
export type { ClientSource } from "./client";

export interface UiClientHandle {
  readonly api: TinyCloudUI;
  /** Sign-out: clears this client's view state and closes the panel. Window listeners stay. */
  reset(): void;
  /** Cleanup: removes this client. The host unmounts when the last client unregisters. */
  unregister(): void;
  /** Shows a toast in the host. False when this client is headless, detached in a frame, or unregistered. */
  toast(request: ToastRequest): boolean;
  /** Prompts this client opens. `uiEnabled` is false for `ui: false` and detached clients. */
  readonly promptScope: PromptScope;
  /** Arms the background panel-data pull for this client. Call once sign-in or restore has produced a session. */
  armPrefetch(host: PanelDataHost): void;
}

export interface UiClientOptions {
  readonly ui: UiConfig | false | undefined;
  readonly source: ClientSource;
  /** manifest.app_id, read lazily so setManifest() re-keys the hide flag. */
  readonly manifestAppId: () => string | undefined;
  /** manifest.name, the display name the panel shows the user. Read lazily like `manifestAppId`. */
  readonly manifestName?: () => string | undefined;
  /** Panel data factory. Production passes the live adapter; the harness passes its stub. */
  readonly data?: PanelDataFactory;
}

interface Registry {
  readonly apiVersion: number;
  readonly runtime: HostRuntime;
}

const VERSION_MISMATCH_WARNING = "[tinycloud] ui-host-version-mismatch";
let warnedVersionMismatch = false;

function acquireRuntime(): HostRuntime | undefined {
  const globalRecord = globalThis as unknown as Record<symbol, unknown>;
  const existing = globalRecord[REGISTRY_KEY] as Registry | undefined;
  if (existing !== undefined) {
    if (existing.apiVersion === HOST_API_VERSION) return existing.runtime;
    if (!warnedVersionMismatch) {
      warnedVersionMismatch = true;
      console.warn(VERSION_MISMATCH_WARNING);
    }
    return undefined;
  }
  const runtime = createHostRuntime();
  globalRecord[REGISTRY_KEY] = { apiVersion: HOST_API_VERSION, runtime } satisfies Registry;
  return runtime;
}

function detachedHandle(): UiClientHandle {
  return {
    api: createUiApi(() => undefined),
    reset() {},
    unregister() {},
    toast: () => false,
    promptScope: createPromptScope(false),
    armPrefetch() {},
  };
}

/**
 * Registers a TinyCloudWeb instance with the page's UI host. `ui: false` and
 * frames/opaque origins never create a host element or listener.
 */
export function registerUiClient(options: UiClientOptions): UiClientHandle {
  if (options.ui === false || typeof globalThis.location === "undefined" || !canRenderUi()) return detachedHandle();

  const runtime = acquireRuntime();
  if (!runtime) return detachedHandle();

  const id = runtime.nextClientId();
  const promptScope = createPromptScope(true);
  const config = resolveUiConfig(options.ui);
  const panel = createPanelClient(id, options.source, options.data, config.platform);
  // An empty display name is no name: the panel then shows the app id.
  const displayName = () => options.manifestName?.()?.trim() || undefined;
  runtime.register(id, {
    handle: panel,
    config,
    manifestAppId: options.manifestAppId,
    manifestName: displayName,
  });

  let target: UiTarget | undefined = {
    open: (section) => runtime.open(section),
    openPage: (section) => runtime.openPage(section),
    close: () => runtime.close(),
    isOpen: () => runtime.isOpen(),
  };

  return {
    api: createUiApi(() => target),
    reset() {
      if (target) {
        dismissPrompts(promptScope);
        runtime.reset(id);
      }
    },
    unregister() {
      if (!target) return;
      target = undefined;
      dismissPrompts(promptScope);
      runtime.unregister(id);
      // Aborts the client's live data source (in-flight reads, retry timer) so a detached client makes no reads.
      // Idempotent: reset listeners only drop per-account state, so a repeat after sign-out has no visible effect.
      panel.reset();
    },
    toast(request) {
      if (target === undefined) return false;
      return runtime.toast(request, id);
    },
    promptScope,
    armPrefetch(host) {
      armPanelData(panel.client, { host, gate: options.source, appName: () => displayName() ?? options.manifestAppId() });
    },
  };
}
