/**
 * Prompt host tests. Permission and space-creation prompts render into the
 * host layer, never `document.body`, and fail closed in frames and with
 * `ui:false`. The real ModalManager and modal classes run against a minimal
 * DOM shim.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type * as ModalManagerNs from "../../src/notifications/ModalManager";
import type { HostContext } from "../../src/ui/slots";
import { createPromptScope, dismissPrompts, hasMountedPrompt, holdPrompt, mountPrompt, prompts } from "../../src/ui/parts/prompts";

// ---------------------------------------------------------------------------
// Minimal DOM shim
// ---------------------------------------------------------------------------

class FakeNode {
  focus(): void {}
  children: FakeNode[] = [];
  parent: FakeNode | undefined;
  innerHTML = "";
  get isConnected(): boolean { return this.parent !== undefined; }
  private attrs = new Map<string, string>();

  appendChild(child: FakeNode): FakeNode {
    child.parent = this;
    this.children.push(child);
    // The DOM calls connectedCallback on insertion; modals open from it.
    // Boundary cast: connectedCallback is only present on custom elements.
    (child as unknown as { connectedCallback?: () => void }).connectedCallback?.();
    return child;
  }
  remove(): void {
    const parent = this.parent;
    if (parent !== undefined) {
      parent.children = parent.children.filter((c) => c !== this);
      // The DOM calls disconnectedCallback on removal; modals release the scroll lock there.
      (this as unknown as { disconnectedCallback?: () => void }).disconnectedCallback?.();
    }
    this.parent = undefined;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }
  querySelector(): FakeNode {
    return new FakeNode();
  }
}

class FakeHTMLElement extends FakeNode {
  shadowRoot: FakeNode | null = null;
  attachShadow(_init: { mode: "open" | "closed" }): FakeNode {
    this.shadowRoot = new FakeNode();
    return this.shadowRoot;
  }
}

class FakeBody extends FakeNode {
  style = { overflow: "" };
}

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

const globals = globalThis as unknown as Record<string, unknown>;
const savedGlobals = {
  HTMLElement: globals.HTMLElement,
  customElements: globals.customElements,
  document: globals.document,
  window: globals.window,
  requestAnimationFrame: globals.requestAnimationFrame,
};
const savedWarn = console.warn;

const warnings: string[] = [];
// Keydown listeners registered on the shim document, so tests can press Escape.
const keydownListeners = new Set<(event: KeyboardEvent) => void>();
const body = new FakeBody();
const fakeWindow = {
  top: undefined as unknown,
  location: { origin: "https://app.test" },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => true,
};
fakeWindow.top = fakeWindow;

let modals: typeof ModalManagerNs;
let layer: FakeNode;
let stopPrompts: () => void;

beforeAll(async () => {
  globals.HTMLElement = FakeHTMLElement;
  globals.customElements = { define() {}, get: () => undefined };
  globals.document = {
    body,
    documentElement: new FakeNode(),
    createElement: () => new FakeNode(),
    addEventListener(type: string, listener: (event: KeyboardEvent) => void) {
      if (type === "keydown") keydownListeners.add(listener);
    },
    removeEventListener(type: string, listener: (event: KeyboardEvent) => void) {
      if (type === "keydown") keydownListeners.delete(listener);
    },
  };
  globals.window = fakeWindow;
  globals.requestAnimationFrame = (cb: () => void) => {
    cb();
    return 0;
  };
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  // Dynamic on purpose: the modal classes extend HTMLElement at module load,
  // so they cannot be imported statically before the shim above is installed.
  modals = await import("../../src/notifications/ModalManager");
});

afterAll(async () => {
  // Exception to the no-timers rule: modal hide() schedules a 200ms timer that
  // touches `document`. Restoring globals first would make that timer throw, so
  // the drain waits for it. No event signals its completion.
  await new Promise((resolve) => setTimeout(resolve, 300));
  globals.HTMLElement = savedGlobals.HTMLElement;
  globals.customElements = savedGlobals.customElements;
  globals.document = savedGlobals.document;
  globals.window = savedGlobals.window;
  globals.requestAnimationFrame = savedGlobals.requestAnimationFrame;
  console.warn = savedWarn;
});

beforeEach(() => {
  warnings.length = 0;
  body.children = [];
  layer = new FakeNode();
  // FakeNode stands in for the host layer. Prompts only append to it and never inspect it.
  stopPrompts = prompts.start(undefined as unknown as HostContext, layer as unknown as HTMLElement);
});

afterEach(() => {
  stopPrompts();
  fakeWindow.top = fakeWindow;
});

function permissionOptions(onDismiss: () => void) {
  return { appName: "Test App", additional: [], onDismiss };
}

function spaceOptions(onDismiss: () => void) {
  return { onCreateSpace: async () => {}, onDismiss };
}

// ---------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------

describe("prompts fail closed", () => {
  test("frame: permission prompt is refused, resolves declined, and mounts nothing", async () => {
    fakeWindow.top = {};
    let dismissed = 0;
    const result = await modals.ModalManager.getInstance().showPermissionRequestModal(
      permissionOptions(() => {
        dismissed += 1;
      }),
      createPromptScope(true),
    );

    expect(result).toEqual({ approved: false });
    expect(dismissed).toBe(1);
    expect(layer.children).toHaveLength(0);
    expect(body.children).toHaveLength(0);
    expect(modals.ModalManager.getInstance().hasActiveModal()).toBe(false);
    expect(warnings).toEqual(["[tinycloud] ui-unavailable-frame"]);
  });

  test("frame: space creation prompt is refused and resolves dismissed", async () => {
    fakeWindow.top = {};
    let dismissed = 0;
    const result = await modals.ModalManager.getInstance().showSpaceCreationModal(
      spaceOptions(() => {
        dismissed += 1;
      }),
      createPromptScope(true),
    );

    expect(result).toEqual({ success: false, dismissed: true });
    expect(dismissed).toBe(1);
    expect(layer.children).toHaveLength(0);
    expect(modals.ModalManager.getInstance().hasActiveModal()).toBe(false);
    expect(warnings).toEqual(["[tinycloud] ui-unavailable-frame"]);
  });

  test("ui:false: permission prompt is refused, resolves declined, and mounts nothing", async () => {
    const result = await modals.ModalManager.getInstance().showPermissionRequestModal(
      permissionOptions(() => {}),
      createPromptScope(false),
    );

    expect(result).toEqual({ approved: false });
    expect(layer.children).toHaveLength(0);
    expect(warnings).toEqual(["[tinycloud] ui-disabled"]);
  });

  test("ui:false: space creation prompt is refused, resolves dismissed, and mounts nothing", async () => {
    const result = await modals.ModalManager.getInstance().showSpaceCreationModal(
      spaceOptions(() => {}),
      createPromptScope(false),
    );

    expect(result).toEqual({ success: false, dismissed: true });
    expect(layer.children).toHaveLength(0);
    expect(warnings).toEqual(["[tinycloud] ui-disabled"]);
  });

  test("no host layer: prompt is refused with ui-disabled", async () => {
    stopPrompts();
    const result = await modals.ModalManager.getInstance().showPermissionRequestModal(
      permissionOptions(() => {}),
      createPromptScope(true),
    );

    expect(result).toEqual({ approved: false });
    expect(warnings).toEqual(["[tinycloud] ui-disabled"]);
  });

  test("refused mount is not registered, so a later dismissal does not call it", () => {
    fakeWindow.top = {};
    const scope = createPromptScope(true);
    let dismissed = 0;
    const mount = mountPrompt(scope, new FakeNode() as unknown as HTMLElement, () => {
      dismissed += 1;
    });

    expect(mount).toEqual({ refusal: "ui-unavailable-frame" });
    dismissPrompts(scope);
    expect(dismissed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Host layer
// ---------------------------------------------------------------------------

describe("prompts render into the host layer", () => {
  test("permission prompt mounts into the layer, not document.body", async () => {
    const scope = createPromptScope(true);
    const pending = modals.ModalManager.getInstance().showPermissionRequestModal(
      permissionOptions(() => {}),
      scope,
    );

    expect(layer.children).toHaveLength(1);
    expect(body.children).toHaveLength(0);
    expect(warnings).toEqual([]);

    dismissPrompts(scope);
    expect(await pending).toEqual({ approved: false });
  });

  test("space creation prompt mounts into the layer, not document.body", async () => {
    const scope = createPromptScope(true);
    const pending = modals.ModalManager.getInstance().showSpaceCreationModal(
      spaceOptions(() => {}),
      scope,
    );

    expect(layer.children).toHaveLength(1);
    expect(body.children).toHaveLength(0);

    dismissPrompts(scope);
    expect(await pending).toEqual({ success: false, dismissed: true });
  });
});

// ---------------------------------------------------------------------------
// Teardown and scope
// ---------------------------------------------------------------------------

describe("teardown settles pending prompts", () => {
  test("host stop resolves a pending permission prompt as declined", async () => {
    let dismissed = 0;
    const pending = modals.ModalManager.getInstance().showPermissionRequestModal(
      permissionOptions(() => {
        dismissed += 1;
      }),
      createPromptScope(true),
    );

    stopPrompts();
    expect(await pending).toEqual({ approved: false });
    expect(dismissed).toBe(1);
  });

  test("host stop resolves a pending space creation prompt as dismissed", async () => {
    const pending = modals.ModalManager.getInstance().showSpaceCreationModal(
      spaceOptions(() => {}),
      createPromptScope(true),
    );

    stopPrompts();
    expect(await pending).toEqual({ success: false, dismissed: true });
  });
});

describe("scoped dismissal", () => {
  test("only a mounted, connected prompt takes focus precedence over the panel", () => {
    const scope = createPromptScope(true);
    const releaseHold = holdPrompt(scope, () => {});
    expect(hasMountedPrompt()).toBe(false);
    const node = new FakeNode();
    const mount = mountPrompt(scope, node as unknown as HTMLElement, () => {});
    if (!("release" in mount)) throw new Error("expected prompt to mount");
    expect(hasMountedPrompt()).toBe(true);
    node.remove();
    expect(hasMountedPrompt()).toBe(false);
    mount.release();
    releaseHold();
  });

  test("dismissPrompts settles only the given scope's prompts", () => {
    const scopeA = createPromptScope(true);
    const scopeB = createPromptScope(true);
    const calls = { a: 0, b: 0 };
    const element = () => new FakeNode() as unknown as HTMLElement;

    mountPrompt(scopeA, element(), () => {
      calls.a += 1;
    });
    mountPrompt(scopeB, element(), () => {
      calls.b += 1;
    });

    dismissPrompts(scopeA);
    expect(calls).toEqual({ a: 1, b: 0 });

    stopPrompts();
    expect(calls).toEqual({ a: 1, b: 1 });
  });

  test("a throwing dismiss does not stop cleanup and surfaces on a microtask", () => {
    const scope = createPromptScope(true);
    const calls = { first: 0, second: 0 };
    const throwing = () => {
      calls.first += 1;
      throw new Error("probe dismiss");
    };
    mountPrompt(scope, new FakeNode() as unknown as HTMLElement, throwing);
    mountPrompt(scope, new FakeNode() as unknown as HTMLElement, () => {
      calls.second += 1;
    });

    const realQueueMicrotask = globalThis.queueMicrotask;
    const queued: Array<() => void> = [];
    globalThis.queueMicrotask = (task: () => void) => {
      queued.push(task);
    };
    try {
      expect(() => dismissPrompts(scope)).not.toThrow();
      expect(calls).toEqual({ first: 1, second: 1 });
      expect(queued).toHaveLength(1);
      expect(() => queued[0]!()).toThrow("probe dismiss");

      queued.length = 0;
      mountPrompt(scope, new FakeNode() as unknown as HTMLElement, throwing);
      mountPrompt(scope, new FakeNode() as unknown as HTMLElement, () => {
        calls.second += 1;
      });
      expect(() => stopPrompts()).not.toThrow();
      expect(calls).toEqual({ first: 2, second: 2 });
      expect(queued).toHaveLength(1);
      expect(() => queued[0]!()).toThrow("probe dismiss");
    } finally {
      globalThis.queueMicrotask = realQueueMicrotask;
    }
  });

  test("a released prompt is no longer dismissed by teardown", () => {
    const scope = createPromptScope(true);
    let dismissed = 0;
    const mount = mountPrompt(scope, new FakeNode() as unknown as HTMLElement, () => {
      dismissed += 1;
    });
    if (!("release" in mount)) throw new Error("expected prompt to mount");

    mount.release();
    dismissPrompts(scope);
    stopPrompts();
    expect(dismissed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Displacement and Escape
// ---------------------------------------------------------------------------

function pressEscape(): void {
  for (const listener of [...keydownListeners]) listener({ key: "Escape" } as KeyboardEvent);
}

describe("opening a prompt while another is open", () => {
  test("settles the displaced permission prompt as declined and keeps the new one", async () => {
    const manager = modals.ModalManager.getInstance();
    const firstScope = createPromptScope(true);
    const secondScope = createPromptScope(true);
    let firstDismissed = 0;
    const first = manager.showPermissionRequestModal(
      permissionOptions(() => {
        firstDismissed += 1;
      }),
      firstScope,
    );
    const second = manager.showPermissionRequestModal(permissionOptions(() => {}), secondScope);

    expect(await first).toEqual({ approved: false });
    expect(firstDismissed).toBe(1);
    expect(manager.hasActiveModal()).toBe(true);

    dismissPrompts(secondScope);
    expect(await second).toEqual({ approved: false });
  });

  test("settles the displaced space creation prompt as dismissed and keeps the new one", async () => {
    const manager = modals.ModalManager.getInstance();
    const firstScope = createPromptScope(true);
    const secondScope = createPromptScope(true);
    let firstDismissed = 0;
    const first = manager.showSpaceCreationModal(
      spaceOptions(() => {
        firstDismissed += 1;
      }),
      firstScope,
    );
    const second = manager.showSpaceCreationModal(spaceOptions(() => {}), secondScope);

    expect(await first).toEqual({ success: false, dismissed: true });
    expect(firstDismissed).toBe(1);
    expect(manager.hasActiveModal()).toBe(true);

    dismissPrompts(secondScope);
    expect(await second).toEqual({ success: false, dismissed: true });
  });

  test("a throwing onDismiss on the displaced space prompt still mounts the new one", async () => {
    const manager = modals.ModalManager.getInstance();
    const deferred: Array<() => void> = [];
    const realQueueMicrotask = globalThis.queueMicrotask;
    // Captures the asynchronous rethrow so it does not fail this test directly.
    globalThis.queueMicrotask = (task: () => void) => {
      deferred.push(task);
    };
    let throwOnce = true;
    try {
      const secondScope = createPromptScope(true);
      const first = manager.showSpaceCreationModal(
        spaceOptions(() => {
          if (throwOnce) {
            throwOnce = false;
            throw new Error("probe onDismiss");
          }
        }),
        createPromptScope(true),
      );
      const displaced = layer.children[0];
      const second = manager.showPermissionRequestModal(permissionOptions(() => {}), secondScope);

      expect(await first).toEqual({ success: false, dismissed: true });
      // Only the new prompt's mount is asserted here. The displaced element's
      // remove() can be JSDOM's when another file loaded the modal classes first,
      // so its removal from this fake layer is covered by the e2e test.
      expect(layer.children.filter((child) => child !== displaced)).toHaveLength(1);
      expect(body.style.overflow).toBe("hidden");
      expect(manager.hasActiveModal()).toBe(true);

      expect(deferred).toHaveLength(1);
      expect(() => deferred[0]!()).toThrow("probe onDismiss");

      dismissPrompts(secondScope);
      expect(await second).toEqual({ approved: false });
    } finally {
      globalThis.queueMicrotask = realQueueMicrotask;
      if (manager.hasActiveModal()) manager.closeActiveModal();
    }
  });

  test("keeps the scroll lock while the displaced permission prompt's hide timer runs", async () => {
    const manager = modals.ModalManager.getInstance();
    const firstScope = createPromptScope(true);
    const secondScope = createPromptScope(true);
    const first = manager.showPermissionRequestModal(permissionOptions(() => {}), firstScope);
    const second = manager.showPermissionRequestModal(permissionOptions(() => {}), secondScope);

    expect(await first).toEqual({ approved: false });
    // Past the displaced modal's 200 ms hide timer.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(body.style.overflow).toBe("hidden");

    dismissPrompts(secondScope);
    expect(await second).toEqual({ approved: false });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(body.style.overflow).toBe("");
  });

  test("keeps the scroll lock while the displaced space creation prompt's hide timer runs", async () => {
    const manager = modals.ModalManager.getInstance();
    const firstScope = createPromptScope(true);
    const secondScope = createPromptScope(true);
    const first = manager.showSpaceCreationModal(spaceOptions(() => {}), firstScope);
    const second = manager.showSpaceCreationModal(spaceOptions(() => {}), secondScope);

    expect(await first).toEqual({ success: false, dismissed: true });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(body.style.overflow).toBe("hidden");

    dismissPrompts(secondScope);
    expect(await second).toEqual({ success: false, dismissed: true });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(body.style.overflow).toBe("");
  });
});

describe("Escape", () => {
  test("Escape settles a permission prompt as declined and calls onDismiss once", async () => {
    const manager = modals.ModalManager.getInstance();
    let dismissed = 0;
    const pending = manager.showPermissionRequestModal(
      permissionOptions(() => {
        dismissed += 1;
      }),
      createPromptScope(true),
    );

    pressEscape();
    expect(await pending).toEqual({ approved: false });
    expect(dismissed).toBe(1);
    expect(manager.hasActiveModal()).toBe(false);

    pressEscape();
    expect(dismissed).toBe(1);
  });

  test("Escape settles a space creation prompt as dismissed and calls onDismiss once", async () => {
    const manager = modals.ModalManager.getInstance();
    let dismissed = 0;
    const pending = manager.showSpaceCreationModal(
      spaceOptions(() => {
        dismissed += 1;
      }),
      createPromptScope(true),
    );

    pressEscape();
    expect(await pending).toEqual({ success: false, dismissed: true });
    expect(dismissed).toBe(1);
    expect(manager.hasActiveModal()).toBe(false);

    pressEscape();
    expect(dismissed).toBe(1);
  });
});
