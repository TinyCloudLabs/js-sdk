import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { TinyCloudWeb } from "../src/modules/tcw";
import { ModalSpaceCreationHandler } from "../src/authorization/WebSpaceCreationHandler";
import { prompts } from "../src/ui/parts/prompts";
import type { HostContext } from "../src/ui/slots";
import { closeActiveModal } from "../src/notifications/lazy-prompts";

class FakeElement {
  private attrs = new Map<string, string>();
  private selectors = new Map<string, FakeElement>();
  public children: FakeElement[] = [];
  public parent: FakeElement | undefined;
  public innerHTML = "";
  public style: { overflow?: string } = {};
  public shadowRoot: FakeElement | null = null;
  public activeElement: FakeElement | null = null;
  get isConnected(): boolean { return this.parent !== undefined; }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    (child as unknown as { connectedCallback?: () => void }).connectedCallback?.();
    if (this === host) reportMounted?.(child);
    return child;
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = undefined;
    (this as unknown as { disconnectedCallback?: () => void }).disconnectedCallback?.();
  }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean { return true; }
  focus(): void {}
  contains(node: unknown): boolean { return node === this || this.children.some((child) => child.contains(node)); }
  querySelector(selector: string): FakeElement {
    let element = this.selectors.get(selector);
    if (!element) {
      element = new FakeElement();
      this.selectors.set(selector, element);
    }
    return element;
  }
  querySelectorAll(): FakeElement[] { return []; }
  attachShadow(): FakeElement {
    this.shadowRoot = new FakeElement();
    return this.shadowRoot;
  }
}

class FakeHTMLElement extends FakeElement {}
let reportMounted: ((element: FakeElement) => void) | undefined;
const globals = globalThis as unknown as Record<string, unknown>;
const saved = {
  HTMLElement: globals.HTMLElement,
  customElements: globals.customElements,
  document: globals.document,
  window: globals.window,
  requestAnimationFrame: globals.requestAnimationFrame,
};
const host = new FakeElement();
const body = new FakeElement();
body.style = { overflow: "" };
let stopPrompts: (() => void) | undefined;

beforeAll(() => {
  globals.HTMLElement = FakeHTMLElement;
  globals.customElements = { define: () => {}, get: () => undefined };
  globals.document = {
    body,
    activeElement: body,
    documentElement: new FakeElement(),
    createElement: () => new FakeElement(),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const fakeWindow = { location: { origin: "https://app.test" }, addEventListener() {}, removeEventListener() {} } as Record<string, unknown>;
  fakeWindow.top = fakeWindow;
  globals.window = fakeWindow;
  globals.requestAnimationFrame = (callback: () => void) => { callback(); return 0; };
  stopPrompts = prompts.start(undefined as unknown as HostContext, host as unknown as HTMLElement);
});

afterEach(() => {
  closeActiveModal();
});

afterAll(async () => {
  // The modal schedules a 200 ms hide animation even when teardown removes it immediately.
  await new Promise((resolve) => setTimeout(resolve, 250));
  stopPrompts?.();
  globals.HTMLElement = saved.HTMLElement;
  globals.customElements = saved.customElements;
  globals.document = saved.document;
  globals.window = saved.window;
  globals.requestAnimationFrame = saved.requestAnimationFrame;
});

const address = "0x1234567890abcdef1234567890abcdef12345678";
const restoredSession = {
  address,
  walletAddress: address,
  chainId: 1,
  sessionKey: {},
  siwe: "restored session SIWE",
  signature: "0xrestored",
};

async function createTcw() {
  const methods: string[] = [];
  let delegates = 0;
  const provider = {
    request: async ({ method }: { method: string }) => {
      methods.push(method);
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [address];
      if (method === "personal_sign") return "0xsigned";
      throw new Error(`Unexpected provider method: ${method}`);
    },
  };
  const handler = new ModalSpaceCreationHandler({ timeoutMs: 0 });
  const tcw = new TinyCloudWeb({
    provider,
    tinycloudHosts: ["https://node.test"],
    sessionStorage: {
      save: async () => undefined,
      load: async () => null,
      clear: async () => undefined,
      activeAddress: () => address,
    },
    includeAccountRegistryPermissions: false,
    autoBootstrapAccount: false,
    autoCreateSpace: false,
    spaceCreationHandler: handler,
  });
  await tcw._initPromise;
  const node = {
    address,
    session: restoredSession,
    spaceId: `tinycloud:pkh:eip155:1:${address}:default`,
    spaceHosting: "not-hosted" as "hosted" | "not-hosted" | "unknown",
    restorableSession: { address, chainId: 1, spaceId: `tinycloud:pkh:eip155:1:${address}:default` },
    hasRuntimePermissions: () => true,
    signOut: async () => { node.spaceHosting = "unknown"; node.restorableSession = undefined; },
    ensurePrimarySpaceHosted: async () => {
      const approved = await handler.confirmSpaceCreation({
        address,
        chainId: 1,
        spaceId: node.spaceId,
        host: "https://node.test",
      });
      if (!approved) return;
      await provider.request({ method: "personal_sign" });
      delegates++;
      node.spaceHosting = "hosted";
    },
  };
  tcw._node = node as never;
  tcw._initPromise = Promise.resolve();
  tcw.restoreSession = async () => ({ status: "restored", session: restoredSession }) as never;
  return { tcw, node, methods, delegateCount: () => delegates };
}


for (const path of ["ensureSpaceHosted", "signIn"] as const) {
  test(`${path} sign-out dismisses the modal and rejects with its documented error`, async () => {
    const { tcw, node, methods, delegateCount } = await createTcw();
    const mounted = Promise.withResolvers<FakeElement>();
    reportMounted = mounted.resolve;
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", recordUnhandled);
    try {
      const operation = path === "ensureSpaceHosted" ? tcw.ensureSpaceHosted() : tcw.signIn();
      const settled = operation.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const started = await Promise.race([
        mounted.promise.then((modal) => ({ modal })),
        settled.then((outcome) => ({ outcome })),
      ]);
      expect(started).toHaveProperty("modal");
      if (!("modal" in started)) return;
      reportMounted = undefined;
      const modal = started.modal;

      await tcw.signOut();
      expect(modal.isConnected).toBe(false);
      expect(host.children).not.toContain(modal);
      const outcome = await settled;
      expect("error" in outcome).toBe(true);
      if (!("error" in outcome)) return;
      expect(outcome.error.message).toBe(
        path === "ensureSpaceHosted"
          ? "Space hosting was cancelled by sign-out."
          : "Sign-in was cancelled by sign-out.",
      );
      expect(methods.filter((method) => method === "personal_sign")).toHaveLength(0);
      expect(delegateCount()).toBe(0);
      expect(node.spaceHosting).toBe("unknown");
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      reportMounted = undefined;
      process.off("unhandledRejection", recordUnhandled);
    }
  });
}
