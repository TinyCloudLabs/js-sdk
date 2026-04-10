/**
 * State-machine tests for TinyCloudPermissionRequestModal.
 *
 * The modal is a Web Component that depends on a handful of browser
 * globals (HTMLElement, customElements, document, requestAnimationFrame).
 * Rather than pulling in happy-dom/jsdom as a new dependency just for
 * this, we install a minimal stub for each global the class touches and
 * drive the state machine directly via its private methods.
 *
 * We exercise two scenarios:
 *   1. Approve button → completion promise resolves with `{ approved: true }`
 *   2. Decline/dismiss  → completion promise resolves with `{ approved: false }`
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Minimal DOM shim
// ---------------------------------------------------------------------------

class FakeElement {
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Array<(e: any) => void>>();
  public innerHTML = "";
  private children: FakeElement[] = [];

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
  dispatchEvent(event: { type: string; target?: any; key?: string }): void {
    const list = this.listeners.get(event.type);
    if (list === undefined) return;
    for (const cb of list) cb(event);
  }
  querySelector(_sel: string): FakeElement | null {
    // The modal only uses querySelector to wire event listeners on a few
    // well-known nodes. We return a shared child so the test can fire
    // events on it regardless of selector.
    if (this.children.length === 0) {
      this.children.push(new FakeElement());
    }
    return this.children[0];
  }
  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
  remove(): void {
    // no-op for the shim
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

// Install the shim before the SUT module is imported so the
// `class extends HTMLElement` binding resolves to the fake.
const originalGlobals = {
  HTMLElement: (globalThis as any).HTMLElement,
  customElements: (globalThis as any).customElements,
  document: (globalThis as any).document,
  requestAnimationFrame: (globalThis as any).requestAnimationFrame,
  setTimeout: (globalThis as any).setTimeout,
};

beforeAll(() => {
  (globalThis as any).HTMLElement = FakeHTMLElement;
  (globalThis as any).customElements = {
    define: () => {},
    get: () => undefined,
  };
  const body: any = new FakeElement();
  body.style = {};
  (globalThis as any).document = {
    body,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as any).requestAnimationFrame = (cb: () => void) => {
    // Run synchronously so the test doesn't race the modal's show() delay.
    cb();
    return 0;
  };
  // Run setTimeout synchronously so the modal's hide() animation delay
  // cannot fire after afterAll has restored the globals, which would
  // crash with "document is not defined" deep inside the test runner.
  (globalThis as any).setTimeout = (cb: () => void) => {
    cb();
    return 0;
  };
});

afterAll(() => {
  (globalThis as any).HTMLElement = originalGlobals.HTMLElement;
  (globalThis as any).customElements = originalGlobals.customElements;
  (globalThis as any).document = originalGlobals.document;
  (globalThis as any).requestAnimationFrame =
    originalGlobals.requestAnimationFrame;
  (globalThis as any).setTimeout = originalGlobals.setTimeout;
});

// Dynamic import so the shim is in place before module evaluation.
async function loadModal(): Promise<any> {
  const mod = await import(
    "../src/notifications/PermissionRequestModal"
  );
  return mod.TinyCloudPermissionRequestModal;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TinyCloudPermissionRequestModal", () => {
  const sampleOptions = {
    appName: "Example App",
    appIcon: "https://example.com/icon.png",
    additional: [
      {
        service: "tinycloud.kv",
        space: "default",
        path: "items/",
        actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
      },
    ],
  };

  test("constructor renders the shadow DOM", async () => {
    const Modal = await loadModal();
    const modal = new Modal(sampleOptions);
    expect(modal.shadowRoot).not.toBeNull();
    // The title should include the escaped app name. We assert the
    // rendered HTML contains it rather than poking deeper into the
    // shadow tree shim.
    expect(modal.shadowRoot.innerHTML).toContain("Example App");
    expect(modal.shadowRoot.innerHTML).toContain("tinycloud.kv");
    expect(modal.shadowRoot.innerHTML).toContain("tinycloud.kv/get");
  });

  test("approve resolves with { approved: true }", async () => {
    const Modal = await loadModal();
    const modal = new Modal(sampleOptions);
    // Simulate the connect lifecycle so setupEventListeners runs and the
    // internal state machine is wired.
    modal.connectedCallback();

    // Drive the approve path directly — the shim's querySelector returns
    // a shared fake child element which received the click listener, so
    // we reach into the modal's private method for determinism.
    (modal as any).handleApprove();

    const result = await modal.getCompletionPromise();
    expect(result).toEqual({ approved: true });
  });

  test("dismiss resolves with { approved: false }", async () => {
    const Modal = await loadModal();
    let dismissedFlag = false;
    const modal = new Modal({
      ...sampleOptions,
      onDismiss: () => {
        dismissedFlag = true;
      },
    });
    modal.connectedCallback();

    (modal as any).dismiss();

    const result = await modal.getCompletionPromise();
    expect(result).toEqual({ approved: false });
    expect(dismissedFlag).toBe(true);
  });

  test("HTML-escapes the app name to prevent XSS", async () => {
    const Modal = await loadModal();
    const modal = new Modal({
      ...sampleOptions,
      appName: "<script>alert('pwn')</script>",
    });
    // The escaped title must appear; the raw <script> tag must not.
    expect(modal.shadowRoot.innerHTML).not.toContain(
      "<script>alert('pwn')</script>",
    );
    expect(modal.shadowRoot.innerHTML).toContain("&lt;script&gt;");
  });

  test("renders multiple permission entries", async () => {
    const Modal = await loadModal();
    const modal = new Modal({
      ...sampleOptions,
      additional: [
        {
          service: "tinycloud.kv",
          space: "default",
          path: "items/",
          actions: ["tinycloud.kv/get"],
        },
        {
          service: "tinycloud.sql",
          space: "default",
          path: "/",
          actions: ["tinycloud.sql/read"],
        },
      ],
    });
    expect(modal.shadowRoot.innerHTML).toContain("tinycloud.kv");
    expect(modal.shadowRoot.innerHTML).toContain("tinycloud.sql");
    expect(modal.shadowRoot.innerHTML).toContain("tinycloud.sql/read");
  });
});
