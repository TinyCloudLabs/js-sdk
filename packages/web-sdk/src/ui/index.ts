import { createUiApi, type TinyCloudUI, type UiTarget } from "./api";
import { createPanelClient, type ClientSource } from "./client";
import { resolveUiConfig, type UiConfig } from "./config";
import { canRenderUi } from "./frame-guard";
import { HOST_API_VERSION, REGISTRY_KEY, createHostRuntime, type HostRuntime } from "./host";
import type { ToastRequest } from "./toast-store";

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
}

export interface UiClientOptions {
  readonly ui: UiConfig | false | undefined;
  readonly source: ClientSource;
  /** manifest.app_id, read lazily so setManifest() re-keys the hide flag. */
  readonly manifestAppId: () => string | undefined;
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
  };
}

/**
 * Registers a TinyCloudWeb instance with the page's UI host. `ui: false` and
 * frames/opaque origins never create a host element or listener.
 */
export function registerUiClient(options: UiClientOptions): UiClientHandle {
  if (options.ui === false || !canRenderUi()) return detachedHandle();

  const runtime = acquireRuntime();
  if (!runtime) return detachedHandle();

  const id = runtime.nextClientId();
  const panel = createPanelClient(id, options.source);
  runtime.register(id, {
    handle: panel,
    config: resolveUiConfig(options.ui),
    manifestAppId: options.manifestAppId,
  });

  let target: UiTarget | undefined = {
    open: () => runtime.open(),
    close: () => runtime.close(),
    isOpen: () => runtime.isOpen(),
  };

  return {
    api: createUiApi(() => target),
    reset() {
      if (target) runtime.reset(id);
    },
    unregister() {
      if (!target) return;
      target = undefined;
      runtime.unregister(id);
    },
    toast(request) {
      if (target === undefined) return false;
      runtime.toast(request);
      return true;
    },
  };
}
