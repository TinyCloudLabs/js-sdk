/**
 * Toast queue for the always-on toasts part. Pure state, no DOM: the part
 * subscribes and renders. Text is a strings.ts code, never raw text.
 */

export type ToastKind = "info" | "success" | "warning" | "error";

export interface ToastRequest {
  readonly kind: ToastKind;
  /** A launcher code, or a panel or section code when the panel raises the toast. Unknown codes render the neutral line. */
  readonly textCode: string;
  readonly href?: string;
  readonly hrefLabelCode?: string;
}

/** Delivers a toast to the page's host. Returns false when nothing was shown. */
export type ToastSink = (request: ToastRequest) => boolean;

export interface ToastView {
  readonly id: string;
  readonly kind: ToastKind;
  readonly textCode: string;
  /** Present only when it is an absolute https URL. */
  readonly href?: string;
  readonly hrefLabelCode?: string;
}

export interface ToastStoreOptions {
  /** Auto-dismiss delay per toast. Default 7000. */
  readonly durationMs?: number;
  /** Oldest toasts are dropped past this count. Default 3. */
  readonly maxVisible?: number;
}

export interface ToastStore {
  /**
   * Returns the toast id. A request identical to a visible toast (same kind,
   * text code, and link) returns that toast's id and shows nothing new; that
   * toast keeps its original owner.
   */
  push(request: ToastRequest, owner?: number): string;
  dismiss(id: string): void;
  /** Removes every toast pushed with `owner`. Ownerless toasts are untouched. */
  clearOwner(owner: number): void;
  /** Ref-counted hold: auto-dismiss stops while any hold is outstanding. */
  pause(): void;
  resume(): void;
  /** Calls `listener` with the current list immediately, then on every change. */
  subscribe(listener: (toasts: readonly ToastView[]) => void): () => void;
}

interface Entry {
  readonly key: string;
  readonly owner: number | undefined;
  readonly view: ToastView;
  timer: ReturnType<typeof setTimeout> | undefined;
  remainingMs: number;
  startedAt: number;
}

/** Only absolute https links render. Anything else (http:, javascript:, relative) is dropped. */
function safeHref(href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  try {
    const url = new URL(href);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function createToastStore(options: ToastStoreOptions = {}): ToastStore {
  const durationMs = options.durationMs ?? 7000;
  const maxVisible = options.maxVisible ?? 3;
  const entries = new Map<string, Entry>();
  const listeners = new Set<(toasts: readonly ToastView[]) => void>();
  let holds = 0;
  let nextId = 1;

  function emit(): void {
    const current = [...entries.values()].map((entry) => entry.view);
    for (const listener of [...listeners]) listener(current);
  }

  function arm(entry: Entry): void {
    if (entry.timer !== undefined || holds > 0) return;
    entry.startedAt = Date.now();
    const id = entry.view.id;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (remove(id)) emit();
    }, entry.remainingMs);
  }

  function disarm(entry: Entry): void {
    if (entry.timer === undefined) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.remainingMs = Math.max(0, entry.remainingMs - (Date.now() - entry.startedAt));
  }

  function remove(id: string): boolean {
    const entry = entries.get(id);
    if (!entry) return false;
    disarm(entry);
    entries.delete(id);
    return true;
  }

  return {
    push(request, owner) {
      const href = safeHref(request.href);
      const linkLabel = href !== undefined ? request.hrefLabelCode : undefined;
      const key = `${request.kind}|${request.textCode}|${href ?? ""}`;
      for (const entry of entries.values()) {
        if (entry.key === key) return entry.view.id;
      }

      const id = `toast-${nextId++}`;
      const view: ToastView = {
        id,
        kind: request.kind,
        textCode: request.textCode,
        ...(href !== undefined && linkLabel !== undefined
          ? { href, hrefLabelCode: linkLabel }
          : {}),
      };
      const entry: Entry = { key, owner, view, timer: undefined, remainingMs: durationMs, startedAt: 0 };
      entries.set(id, entry);
      while (entries.size > maxVisible) {
        const oldest = entries.keys().next().value as string;
        remove(oldest);
      }
      arm(entry);
      emit();
      return id;
    },

    clearOwner(owner) {
      const owned = [...entries.values()].filter((entry) => entry.owner === owner);
      for (const entry of owned) remove(entry.view.id);
      if (owned.length > 0) emit();
    },

    dismiss(id) {
      if (remove(id)) emit();
    },

    pause() {
      holds++;
      for (const entry of entries.values()) disarm(entry);
    },

    resume() {
      if (holds === 0) return;
      holds--;
      if (holds === 0) for (const entry of entries.values()) arm(entry);
    },

    subscribe(listener) {
      listeners.add(listener);
      listener([...entries.values()].map((entry) => entry.view));
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
