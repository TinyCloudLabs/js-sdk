/**
 * Regression tests for TC-362: sign-in hanging forever on an invisible
 * space-creation dialog.
 *
 * `ModalSpaceCreationHandler.confirmSpaceCreation` used to return a promise
 * that only ever settled on a DOM click inside a shadow root. When that dialog
 * was not reachable — hidden behind the app's own "Connecting to your encrypted
 * TinyCloud…" overlay — `ensureSpaceExists` awaited it forever and sign-in
 * appeared frozen with nothing in the light DOM to explain why.
 *
 * These tests drive the real modal through the real ModalManager against a
 * minimal DOM shim (same approach as PermissionRequestModal.test.ts), so the
 * "nobody clicks" case is exercised end to end rather than against a stub.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Minimal DOM shim
// ---------------------------------------------------------------------------

class FakeElement {
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Array<(e: any) => void>>();
  private bySelector = new Map<string, FakeElement>();
  public innerHTML = "";
  public children: FakeElement[] = [];
  public removed = false;

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  addEventListener(name: string, cb: (e: any) => void): void {
    const list = this.listeners.get(name);
    if (list === undefined) {
      this.listeners.set(name, [cb]);
    } else {
      list.push(cb);
    }
  }
  removeEventListener(name: string, cb: (e: any) => void): void {
    const list = this.listeners.get(name);
    if (list !== undefined) {
      const idx = list.indexOf(cb);
      if (idx >= 0) list.splice(idx, 1);
    }
  }
  dispatchEvent(event: { type: string; target?: any; key?: string }): boolean {
    const list = this.listeners.get(event.type);
    if (list !== undefined) {
      for (const cb of [...list]) cb(event);
    }
    return true;
  }
  /** Stable element per selector, so `[data-action="create"]` and `.modal-backdrop` differ. */
  querySelector(sel: string): FakeElement {
    let found = this.bySelector.get(sel);
    if (found === undefined) {
      found = new FakeElement();
      this.bySelector.set(sel, found);
    }
    return found;
  }
  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
  remove(): void {
    this.removed = true;
  }
}

class FakeShadowRoot extends FakeElement {}

class FakeHTMLElement extends FakeElement {
  public shadowRoot: FakeShadowRoot | null = null;
  attachShadow(_opts: { mode: "open" | "closed" }): FakeShadowRoot {
    this.shadowRoot = new FakeShadowRoot();
    return this.shadowRoot;
  }
}

class FakeCustomEvent<T> {
  readonly type: string;
  readonly detail: T | undefined;
  constructor(type: string, init?: { detail?: T }) {
    this.type = type;
    this.detail = init?.detail;
  }
}

const dispatchedWindowEvents: Array<{ type: string; detail: any }> = [];

const originalGlobals = {
  HTMLElement: (globalThis as any).HTMLElement,
  customElements: (globalThis as any).customElements,
  document: (globalThis as any).document,
  window: (globalThis as any).window,
  CustomEvent: (globalThis as any).CustomEvent,
  requestAnimationFrame: (globalThis as any).requestAnimationFrame,
  consoleWarn: console.warn,
};

let documentElement: FakeElement;

beforeAll(() => {
  (globalThis as any).HTMLElement = FakeHTMLElement;
  (globalThis as any).customElements = { define: () => {}, get: () => undefined };
  const body: any = new FakeElement();
  body.style = {};
  documentElement = new FakeElement();
  (globalThis as any).document = {
    body,
    documentElement,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as any).CustomEvent = FakeCustomEvent;
  (globalThis as any).window = {
    dispatchEvent: (event: any) => {
      dispatchedWindowEvents.push({ type: event.type, detail: event.detail });
      return true;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as any).requestAnimationFrame = (cb: () => void) => {
    cb();
    return 0;
  };
  // The handler intentionally warns when it starts blocking on the user.
  // Keep the test output readable while still recording the calls.
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
});

afterAll(async () => {
  // The modal's hide() animation runs on a 200ms timer that touches `document`.
  // Let it drain before the globals are restored.
  await new Promise((resolve) => setTimeout(resolve, 300));
  (globalThis as any).HTMLElement = originalGlobals.HTMLElement;
  (globalThis as any).customElements = originalGlobals.customElements;
  (globalThis as any).document = originalGlobals.document;
  (globalThis as any).window = originalGlobals.window;
  (globalThis as any).CustomEvent = originalGlobals.CustomEvent;
  (globalThis as any).requestAnimationFrame = originalGlobals.requestAnimationFrame;
  console.warn = originalGlobals.consoleWarn;
});

const warnings: string[] = [];

beforeEach(() => {
  dispatchedWindowEvents.length = 0;
  warnings.length = 0;
});

// Dynamic import so the shim is in place before module evaluation
// (SpaceCreationModal does `class ... extends HTMLElement` at module scope).
async function loadHandlerModule(): Promise<any> {
  return await import("../src/authorization/WebSpaceCreationHandler");
}

async function loadModalManager(): Promise<any> {
  return await import("../src/notifications/ModalManager");
}

async function loadBeacon(): Promise<any> {
  return await import("../src/notifications/awaitingUserInput");
}

const context = {
  spaceId: "tinycloud:pkh:eip155:1:0xabc:default",
  address: "0xabc",
  chainId: 1,
  host: "https://node.tinycloud.test",
};

/**
 * The dialog that is currently on screen, as ModalManager sees it.
 *
 * Note: the modal's own shadow tree is not asserted on here. Bun shares the
 * module registry across test files, and `signInManifestRestore.test.ts` may
 * evaluate `SpaceCreationModal` first under its own (much thinner) HTMLElement
 * stub, so the shadow root's shape is not ours to rely on. What matters for
 * this regression is the handler's contract with the modal's callbacks.
 */
function activeModal(manager: any): any {
  return (manager.ModalManager.getInstance() as any).activeModal;
}

describe("ModalSpaceCreationHandler", () => {
  test("rejects instead of hanging when nobody answers the dialog", async () => {
    const { ModalSpaceCreationHandler, SpaceCreationTimeoutError } =
      await loadHandlerModule();
    const modals = await loadModalManager();
    const { AWAITING_USER_INPUT_ATTRIBUTE, pendingUserInputKind } =
      await loadBeacon();

    const handler = new ModalSpaceCreationHandler({ timeoutMs: 40 });
    const pending = handler.confirmSpaceCreation(context);

    // While blocked, the wait is observable from the light DOM.
    expect(pendingUserInputKind()).toBe("space-creation");
    expect(documentElement.getAttribute(AWAITING_USER_INPUT_ATTRIBUTE)).toBe(
      "space-creation",
    );
    expect(
      dispatchedWindowEvents.some(
        (e) => e.type === "tinycloud:awaiting-user-input",
      ),
    ).toBe(true);
    expect(warnings.join("\n")).toContain("tinycloud-space-modal");

    // No click ever happens. Before the fix this promise never settled.
    let caught: unknown;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SpaceCreationTimeoutError);
    expect((caught as Error).name).toBe("SpaceCreationTimeoutError");
    expect((caught as any).code).toBe("SPACE_CREATION_TIMEOUT");
    // Actionable, not generic.
    expect((caught as Error).message).toContain("autoCreateSpace: true");
    expect((caught as Error).message).toContain("tinycloud-space-modal");

    // The wait is no longer advertised, and the unanswerable dialog is gone.
    expect(pendingUserInputKind()).toBeUndefined();
    expect(modals.ModalManager.getInstance().hasActiveModal()).toBe(false);
    const resolved = dispatchedWindowEvents.find(
      (e) => e.type === "tinycloud:awaiting-user-input-resolved",
    );
    expect(resolved?.detail?.outcome).toBe("timeout");
  });

  test("resolves true when the user clicks Create", async () => {
    const { ModalSpaceCreationHandler } = await loadHandlerModule();
    const modals = await loadModalManager();
    const { pendingUserInputKind } = await loadBeacon();

    const handler = new ModalSpaceCreationHandler({ timeoutMs: 5_000 });
    const pending = handler.confirmSpaceCreation(context);

    // Exactly what the modal's Create button invokes.
    await activeModal(modals).options.onCreateSpace();

    expect(await pending).toBe(true);
    expect(pendingUserInputKind()).toBeUndefined();
    const resolved = dispatchedWindowEvents.find(
      (e) => e.type === "tinycloud:awaiting-user-input-resolved",
    );
    expect(resolved?.detail?.outcome).toBe("confirmed");
  });

  test("resolves false when the user dismisses the dialog", async () => {
    const { ModalSpaceCreationHandler } = await loadHandlerModule();
    const modals = await loadModalManager();
    const { pendingUserInputKind } = await loadBeacon();

    const handler = new ModalSpaceCreationHandler({ timeoutMs: 5_000 });
    const pending = handler.confirmSpaceCreation(context);

    activeModal(modals).dismiss();

    expect(await pending).toBe(false);
    expect(pendingUserInputKind()).toBeUndefined();
  });

  test("timeoutMs: 0 restores the unbounded wait for callers who opt in", async () => {
    const { ModalSpaceCreationHandler } = await loadHandlerModule();
    const modals = await loadModalManager();

    const handler = new ModalSpaceCreationHandler({ timeoutMs: 0 });
    const pending = handler.confirmSpaceCreation(context);

    const settled = await Promise.race([
      pending.then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 60)),
    ]);
    expect(settled).toBe("still waiting");

    // Do not leave a dangling promise behind.
    activeModal(modals).dismiss();
    expect(await pending).toBe(false);
  });
});

describe("resolveSpaceCreationHandler", () => {
  test("autoCreateSpace: true creates the space without showing a dialog", async () => {
    const { resolveSpaceCreationHandler, ModalSpaceCreationHandler } =
      await loadHandlerModule();
    const modals = await loadModalManager();

    const handler = resolveSpaceCreationHandler({ autoCreateSpace: true });
    expect(handler).toBeDefined();
    expect(handler).not.toBeInstanceOf(ModalSpaceCreationHandler);

    // The whole point: it confirms immediately, with no modal to click.
    expect(await handler!.confirmSpaceCreation(context)).toBe(true);
    expect(modals.ModalManager.getInstance().hasActiveModal()).toBe(false);
  });

  test("autoCreateSpace: false skips creation entirely (no handler)", async () => {
    const { resolveSpaceCreationHandler } = await loadHandlerModule();
    expect(resolveSpaceCreationHandler({ autoCreateSpace: false })).toBeUndefined();
  });

  test("unset autoCreateSpace keeps the modal confirmation default", async () => {
    const { resolveSpaceCreationHandler, ModalSpaceCreationHandler } =
      await loadHandlerModule();
    expect(resolveSpaceCreationHandler({})).toBeInstanceOf(
      ModalSpaceCreationHandler,
    );
  });

  test("an explicit handler wins over autoCreateSpace", async () => {
    const { resolveSpaceCreationHandler } = await loadHandlerModule();
    const custom = { confirmSpaceCreation: async () => true };
    expect(
      resolveSpaceCreationHandler({
        autoCreateSpace: true,
        spaceCreationHandler: custom,
      }),
    ).toBe(custom);
  });

  test("spaceCreationTimeoutMs is forwarded to the modal handler", async () => {
    const { resolveSpaceCreationHandler, SpaceCreationTimeoutError } =
      await loadHandlerModule();

    const handler = resolveSpaceCreationHandler({ spaceCreationTimeoutMs: 30 });
    let caught: unknown;
    try {
      await handler!.confirmSpaceCreation(context);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SpaceCreationTimeoutError);
    expect((caught as any).timeoutMs).toBe(30);
  });
});
