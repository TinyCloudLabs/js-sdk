import { projectDiagnosticData } from "./diagnostics";

export type TinyCloudDebugLevel = "debug";

export interface TinyCloudDebugEvent {
  sequence: number;
  timestamp: number;
  timestampIso: string;
  level: TinyCloudDebugLevel;
  event: string;
  message?: string;
  data?: unknown;
  durationMs?: number;
  startedAt?: number;
  endedAt?: number;
}

export interface TinyCloudDebugEnableOptions {
  /**
   * Persist the debug flag in browser localStorage. Defaults to true.
   * Node runtimes intentionally do not persist this setting.
   */
  persist?: boolean;
}

export interface TinyCloudDebugTimer {
  stop: (data?: unknown) => TinyCloudDebugEvent | undefined;
}

type TinyCloudDebugGlobal = typeof globalThis & {
  TinyCloud_debug?: boolean | string;
  TinyCloudDebug?: TinyCloudDebugLogger;
  window?: unknown;
  enableTinyCloudDebug?: typeof enableTinyCloudDebug;
  disableTinyCloudDebug?: typeof disableTinyCloudDebug;
  getTinyCloudDebugLogs?: typeof getTinyCloudDebugLogs;
  clearTinyCloudDebugLogs?: typeof clearTinyCloudDebugLogs;
};

interface TinyCloudDebugStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const DEBUG_FLAG = "TinyCloud_debug";
const MAX_EVENTS = 1000;

function getGlobal(): TinyCloudDebugGlobal {
  return globalThis as TinyCloudDebugGlobal;
}

function nowMs(): number {
  const performanceNow = globalThis.performance?.now?.bind(globalThis.performance);
  return typeof performanceNow === "function" ? performanceNow() : Date.now();
}

function isTrue(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function getProcessDebugFlag(): unknown {
  const processLike = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return processLike?.env?.[DEBUG_FLAG];
}

function isBrowserWindow(): boolean {
  const global = getGlobal();
  return global.window === globalThis;
}

function getLocalStorage(): TinyCloudDebugStorage | undefined {
  if (!isBrowserWindow()) {
    return undefined;
  }

  try {
    return (globalThis as typeof globalThis & { localStorage?: TinyCloudDebugStorage }).localStorage;
  } catch {
    return undefined;
  }
}

function getStoredDebugFlag(): unknown {
  const storage = getLocalStorage();
  if (!storage) {
    return undefined;
  }

  try {
    return storage.getItem(DEBUG_FLAG);
  } catch {
    return undefined;
  }
}

function setStoredDebugFlag(enabled: boolean): void {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    if (enabled) {
      storage.setItem(DEBUG_FLAG, "true");
    } else {
      storage.removeItem(DEBUG_FLAG);
    }
  } catch {
    // localStorage can be unavailable in private browsing or restricted contexts.
  }
}

function shouldStartEnabled(): boolean {
  const global = getGlobal();
  return (
    isTrue(global[DEBUG_FLAG]) ||
    isTrue(getStoredDebugFlag()) ||
    isTrue(getProcessDebugFlag())
  );
}

export class TinyCloudDebugLogger {
  private enabled: boolean = shouldStartEnabled();
  private sequence: number = 0;
  private events: TinyCloudDebugEvent[] = [];
  private maxEvents: number = MAX_EVENTS;

  isEnabled(): boolean {
    return (
      this.enabled ||
      isTrue(getGlobal()[DEBUG_FLAG]) ||
      isTrue(getProcessDebugFlag())
    );
  }

  enable(options: TinyCloudDebugEnableOptions = {}): void {
    this.enabled = true;
    getGlobal()[DEBUG_FLAG] = true;

    if (options.persist !== false) {
      setStoredDebugFlag(true);
    }

    this.log("debug.enabled", { persisted: options.persist !== false });
  }

  disable(options: TinyCloudDebugEnableOptions = {}): void {
    this.log("debug.disabled", { persisted: options.persist !== false });
    this.enabled = false;
    getGlobal()[DEBUG_FLAG] = false;

    if (options.persist !== false) {
      setStoredDebugFlag(false);
    }
  }

  clear(): void {
    this.events = [];
  }

  getLogs(): TinyCloudDebugEvent[] {
    return [...this.events];
  }

  log(event: string, data?: unknown, message?: string): TinyCloudDebugEvent | undefined {
    if (!this.isEnabled()) {
      return undefined;
    }

    return this.record({
      event,
      data,
      message,
      level: "debug",
      timestamp: Date.now(),
      timestampIso: new Date().toISOString(),
    });
  }

  startTimer(event: string, data?: unknown): TinyCloudDebugTimer {
    if (!this.isEnabled()) {
      return { stop: () => undefined };
    }

    const startedAt = nowMs();
    this.log(`${event}.start`, data);

    return {
      stop: (finishData?: unknown) => {
        const endedAt = nowMs();
        return this.record({
          event: `${event}.end`,
          data: finishData,
          durationMs: endedAt - startedAt,
          startedAt,
          endedAt,
          level: "debug",
          timestamp: Date.now(),
          timestampIso: new Date().toISOString(),
        });
      },
    };
  }

  async timeAsync<T>(
    event: string,
    operation: () => Promise<T>,
    data?: unknown,
  ): Promise<T> {
    if (!this.isEnabled()) {
      return operation();
    }

    const timer = this.startTimer(event, data);
    try {
      const result = await operation();
      timer.stop({ ok: true });
      return result;
    } catch (error) {
      timer.stop({ ok: false, error });
      throw error;
    }
  }

  time<T>(event: string, operation: () => T, data?: unknown): T {
    if (!this.isEnabled()) {
      return operation();
    }

    const timer = this.startTimer(event, data);
    try {
      const result = operation();
      timer.stop({ ok: true });
      return result;
    } catch (error) {
      timer.stop({ ok: false, error });
      throw error;
    }
  }

  private record(
    event: Omit<TinyCloudDebugEvent, "sequence">,
  ): TinyCloudDebugEvent {
    const debugEvent: TinyCloudDebugEvent = {
      ...event,
      ...(event.data === undefined
        ? {}
        : { data: projectDiagnosticData(event.data) }),
      ...(event.message === undefined ? {} : { message: "[REDACTED]" }),
      sequence: ++this.sequence,
    };

    this.events.push(debugEvent);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }

    try {
      globalThis.console?.debug?.("[TinyCloud]", debugEvent.event, debugEvent);
    } catch {
      // Debug logging should never affect SDK behavior.
    }

    return debugEvent;
  }
}

export const tinyCloudDebugLogger = new TinyCloudDebugLogger();

export function enableTinyCloudDebug(
  options?: TinyCloudDebugEnableOptions,
): TinyCloudDebugLogger {
  tinyCloudDebugLogger.enable(options);
  return tinyCloudDebugLogger;
}

export function disableTinyCloudDebug(
  options?: TinyCloudDebugEnableOptions,
): TinyCloudDebugLogger {
  tinyCloudDebugLogger.disable(options);
  return tinyCloudDebugLogger;
}

export function getTinyCloudDebugLogs(): TinyCloudDebugEvent[] {
  return tinyCloudDebugLogger.getLogs();
}

export function clearTinyCloudDebugLogs(): void {
  tinyCloudDebugLogger.clear();
}

export function installTinyCloudDebugGlobals(): void {
  const global = getGlobal();
  global.TinyCloudDebug = tinyCloudDebugLogger;
  global.enableTinyCloudDebug = enableTinyCloudDebug;
  global.disableTinyCloudDebug = disableTinyCloudDebug;
  global.getTinyCloudDebugLogs = getTinyCloudDebugLogs;
  global.clearTinyCloudDebugLogs = clearTinyCloudDebugLogs;
}

installTinyCloudDebugGlobals();
