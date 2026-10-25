import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "bun:test";
import { JSDOM } from "jsdom";

import { mountToastRegion, type ToastRegion } from "../../src/ui/panel-toasts";
import { createToastStore, type ToastRequest, type ToastStore } from "../../src/ui/toast-store";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const saved = new Map<string, unknown>();
let page: Window;

beforeAll(() => {
  saved.set("document", g.document);
  page = new JSDOM("", { url: "https://app.example/page" }).window as unknown as Window;
  g.document = page.document;
});

afterAll(() => {
  g.document = saved.get("document");
});

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

interface Mounted {
  readonly layer: HTMLElement;
  readonly region: ToastRegion;
  readonly store: ToastStore;
  readonly pushed: ToastRequest[];
  stop(): void;
}

function mount(): Mounted {
  const layer = document.createElement("div");
  document.body.append(layer);
  const store = createToastStore();
  const pushed: ToastRequest[] = [];
  const region = mountToastRegion(layer, store, (request) => pushed.push(request));
  return {
    layer,
    region,
    store,
    pushed,
    stop() {
      region.dispose();
      layer.remove();
    },
  };
}

const RECEIPT = {
  titleCode: "panel.title",
  rows: [
    { labelCode: "panel.close", value: "<b>rcpt-1</b>" },
    { labelCode: "panel.back", value: "bafy-9" },
  ],
} as const;

describe("toast region", () => {
  test("mounting takes over from the launcher stack, so each toast is in the page once", () => {
    const layer = document.createElement("div");
    document.body.append(layer);
    const eager = document.createElement("div");
    eager.className = "toasts";
    layer.append(eager);
    const store = createToastStore();
    const region = mountToastRegion(layer, store, () => null);
    store.push({ kind: "info", textCode: "panel.title" });
    expect(layer.querySelector(".toasts")).toBeNull();
    expect(layer.querySelectorAll(".toast").length).toBe(1);
    region.dispose();
    layer.remove();
  });

  test("a toast already showing when the region mounts is drawn in the region", () => {
    const layer = document.createElement("div");
    document.body.append(layer);
    const store = createToastStore();
    store.push({ kind: "warning", textCode: "panel.title" });
    const region = mountToastRegion(layer, store, () => null);
    expect(layer.querySelectorAll(".tstack .toast--warning").length).toBe(1);
    region.dispose();
    layer.remove();
  });

  test("renders a store toast with an icon, its text and a labelled 44px-class dismiss button", () => {
    const m = mount();
    m.store.push({ kind: "success", textCode: "panel.title" });
    const toast = m.layer.querySelector(".toast--success");
    expect(toast?.getAttribute("role")).toBe("status");
    expect(toast?.querySelector(".toast__icon svg")).not.toBeNull();
    expect(toast?.querySelector(".toast__message")?.textContent).toBe("TinyCloud");
    expect(toast?.querySelector(".toast__close")?.getAttribute("aria-label")).toBe("Dismiss");
    m.stop();
  });

  test("an error toast is announced as an alert", () => {
    const m = mount();
    m.store.push({ kind: "error", textCode: "panel.title" });
    expect(m.layer.querySelector(".toast--error")?.getAttribute("role")).toBe("alert");
    m.stop();
  });

  test("dismiss removes the store toast and clears its timer", () => {
    const m = mount();
    m.store.push({ kind: "info", textCode: "panel.title" });
    (m.layer.querySelector(".toast__close") as HTMLButtonElement).click();
    expect(m.layer.querySelectorAll(".toast").length).toBe(0);
    m.stop();
  });

  test("hovering a store toast holds its timer until the pointer leaves", () => {
    const m = mount();
    m.store.push({ kind: "info", textCode: "panel.title" });
    const toast = m.layer.querySelector(".toast") as HTMLElement;
    toast.dispatchEvent(new page.Event("mouseenter"));
    jest.advanceTimersByTime(20_000);
    expect(m.layer.querySelectorAll(".toast").length).toBe(1);
    toast.dispatchEvent(new page.Event("mouseleave"));
    jest.advanceTimersByTime(7000);
    expect(m.layer.querySelectorAll(".toast").length).toBe(0);
    m.stop();
  });

  test("renders receipt rows as text, never as markup", () => {
    const m = mount();
    expect(m.region.receipt(RECEIPT)).toBe(true);
    const rows = [...m.layer.querySelectorAll(".slip > div")];
    expect(rows.map((row) => row.textContent)).toEqual(["Close <b>rcpt-1</b>", "Back to bafy-9"]);
    expect(m.layer.querySelector(".slip b")).toBeNull();
    m.stop();
  });

  test("an identical receipt is not shown twice, a different one is", () => {
    const m = mount();
    expect(m.region.receipt(RECEIPT)).toBe(true);
    expect(m.region.receipt(RECEIPT)).toBe(false);
    expect(m.region.receipt({ ...RECEIPT, rows: [{ labelCode: "panel.close", value: "other" }] })).toBe(true);
    expect(m.layer.querySelectorAll(".slip").length).toBe(2);
    m.stop();
  });

  test("a receipt stays 7 s, then goes", () => {
    const m = mount();
    m.region.receipt(RECEIPT);
    jest.advanceTimersByTime(6999);
    expect(m.layer.querySelectorAll(".slip").length).toBe(1);
    jest.advanceTimersByTime(1);
    expect(m.layer.querySelectorAll(".slip").length).toBe(0);
    m.stop();
  });

  test("only the three newest receipts stay", () => {
    const m = mount();
    for (const n of [1, 2, 3, 4]) m.region.receipt({ ...RECEIPT, rows: [{ labelCode: "panel.close", value: `r${n}` }] });
    const shown = [...m.layer.querySelectorAll(".slip")].map((slip) => slip.textContent);
    expect(shown).toEqual(["Close r2", "Close r3", "Close r4"]);
    m.stop();
  });

  test("hovering a receipt holds its timer; leaving resumes the time that was left", () => {
    const m = mount();
    m.region.receipt(RECEIPT);
    jest.advanceTimersByTime(5000);
    const toast = m.layer.querySelector(".toast") as HTMLElement;
    toast.dispatchEvent(new page.Event("mouseenter"));
    jest.advanceTimersByTime(60_000);
    expect(m.layer.querySelectorAll(".slip").length).toBe(1);
    toast.dispatchEvent(new page.Event("mouseleave"));
    jest.advanceTimersByTime(1999);
    expect(m.layer.querySelectorAll(".slip").length).toBe(1);
    jest.advanceTimersByTime(1);
    expect(m.layer.querySelectorAll(".slip").length).toBe(0);
    m.stop();
  });

  test("Copy receipt writes each row as label and value, then confirms with a toast", async () => {
    const written: string[] = [];
    const realNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: async (text: string) => { written.push(text); } } },
    });
    try {
      const m = mount();
      m.region.receipt(RECEIPT);
      (m.layer.querySelector(".toast__copy") as HTMLButtonElement).click();
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
      expect(written).toEqual(["Close <b>rcpt-1</b>\nBack to bafy-9"]);
      expect(m.pushed).toEqual([{ kind: "success", textCode: "toast.copied" }]);
      m.stop();
    } finally {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: realNavigator });
    }
  });

  test("a row's copyValue is what Copy receipt writes; the slip still shows the short value", async () => {
    const written: string[] = [];
    const realNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: async (text: string) => { written.push(text); } } },
    });
    try {
      const m = mount();
      m.region.receipt({
        titleCode: "panel.title",
        rows: [
          { labelCode: "panel.close", value: "bafy…9z", copyValue: "bafy-the-full-cid-9z" },
          { labelCode: "panel.back", value: "rc-7" },
        ],
      });
      expect([...m.layer.querySelectorAll(".slip > div")].map((row) => row.textContent)).toEqual(["Close bafy…9z", "Back to rc-7"]);
      (m.layer.querySelector(".toast__copy") as HTMLButtonElement).click();
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
      expect(written).toEqual(["Close bafy-the-full-cid-9z\nBack to rc-7"]);
      m.stop();
    } finally {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: realNavigator });
    }
  });

  test("receipts with the same shown value but different copy values are both shown", () => {
    const m = mount();
    const receipt = (copyValue: string) => ({ titleCode: "panel.title", rows: [{ labelCode: "panel.close", value: "bafy…", copyValue }] });
    expect(m.region.receipt(receipt("bafy-one"))).toBe(true);
    expect(m.region.receipt(receipt("bafy-one"))).toBe(false);
    expect(m.region.receipt(receipt("bafy-two"))).toBe(true);
    m.stop();
  });

  test("clearReceipts drops every receipt slip and leaves store toasts alone", () => {
    const m = mount();
    m.store.push({ kind: "info", textCode: "panel.title" });
    m.region.receipt(RECEIPT);
    m.region.receipt({ ...RECEIPT, rows: [{ labelCode: "panel.close", value: "other" }] });
    m.region.clearReceipts();
    expect(m.layer.querySelectorAll(".slip").length).toBe(0);
    expect(m.layer.querySelectorAll(".toast--info").length).toBe(1);
    // A cleared receipt can be shown again.
    expect(m.region.receipt(RECEIPT)).toBe(true);
    m.stop();
  });

  test("a refused clipboard write is reported, not swallowed", async () => {
    const realNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: async () => { throw new Error("denied"); } } },
    });
    try {
      const m = mount();
      m.region.receipt(RECEIPT);
      (m.layer.querySelector(".toast__copy") as HTMLButtonElement).click();
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
      expect(m.pushed).toEqual([{ kind: "error", textCode: "toast.copy_failed" }]);
      m.stop();
    } finally {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: realNavigator });
    }
  });

  test("dispose removes the region, drops receipts and releases a hover hold", () => {
    const m = mount();
    m.store.push({ kind: "info", textCode: "panel.title" });
    m.region.receipt(RECEIPT);
    (m.layer.querySelector(".toast--info") as HTMLElement).dispatchEvent(new page.Event("mouseenter"));
    m.stop();
    expect(m.layer.querySelectorAll(".toast").length).toBe(0);
    m.store.push({ kind: "info", textCode: "panel.close" });
    let count = -1;
    m.store.subscribe((list) => {
      count = list.length;
    });
    jest.advanceTimersByTime(7000);
    expect(count).toBe(0);
  });
});
