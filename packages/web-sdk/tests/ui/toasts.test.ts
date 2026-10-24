import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "bun:test";
import { JSDOM } from "jsdom";

import { createToastsPart } from "../../src/ui/parts/toasts";
import type { HostContext } from "../../src/ui/slots";
import { createToastStore, type ToastStore, type ToastView } from "../../src/ui/toast-store";

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

function collect(store: ToastStore): { latest: () => readonly ToastView[] } {
  let latest: readonly ToastView[] = [];
  store.subscribe((list) => {
    latest = list;
  });
  return { latest: () => latest };
}

describe("toast store", () => {
  test("auto-dismisses after the configured duration", () => {
    const store = createToastStore({ durationMs: 30 });
    const view = collect(store);
    store.push({ kind: "info", textCode: "sync.error.failed" });
    expect(view.latest().length).toBe(1);
    jest.advanceTimersByTime(29);
    expect(view.latest().length).toBe(1);
    jest.advanceTimersByTime(1);
    expect(view.latest().length).toBe(0);
  });

  test("keeps at most maxVisible toasts and drops the oldest", () => {
    const store = createToastStore({ durationMs: 10_000, maxVisible: 2 });
    const view = collect(store);
    const first = store.push({ kind: "info", textCode: "a" });
    const second = store.push({ kind: "info", textCode: "b" });
    const third = store.push({ kind: "info", textCode: "c" });
    expect(view.latest().map((toast) => toast.id)).toEqual([second, third]);
    expect(view.latest().map((toast) => toast.id)).not.toContain(first);
  });

  test("dismiss removes the toast and notifies subscribers", () => {
    const store = createToastStore({ durationMs: 10_000 });
    const view = collect(store);
    const id = store.push({ kind: "error", textCode: "sync.error.declined" });
    store.dismiss(id);
    expect(view.latest()).toEqual([]);
  });

  test("a dismissed toast's timer no longer fires a change", () => {
    const store = createToastStore({ durationMs: 30 });
    let emissions = 0;
    store.subscribe(() => {
      emissions++;
    });
    const id = store.push({ kind: "info", textCode: "a" });
    store.dismiss(id);
    const afterDismiss = emissions;
    jest.advanceTimersByTime(100);
    expect(emissions).toBe(afterDismiss);
  });

  test("pause holds timers until every hold is released", () => {
    const store = createToastStore({ durationMs: 40 });
    const view = collect(store);
    store.push({ kind: "success", textCode: "a" });
    store.pause();
    store.pause();
    jest.advanceTimersByTime(200);
    expect(view.latest().length).toBe(1);
    store.resume();
    jest.advanceTimersByTime(200);
    expect(view.latest().length).toBe(1);
    store.resume();
    jest.advanceTimersByTime(40);
    expect(view.latest().length).toBe(0);
  });

  test("pause keeps the remaining time, not the full duration", () => {
    const store = createToastStore({ durationMs: 100 });
    const view = collect(store);
    store.push({ kind: "info", textCode: "a" });
    jest.advanceTimersByTime(70);
    store.pause();
    jest.advanceTimersByTime(1_000);
    store.resume();
    jest.advanceTimersByTime(29);
    expect(view.latest().length).toBe(1);
    jest.advanceTimersByTime(1);
    expect(view.latest().length).toBe(0);
  });

  test("a toast pushed while paused starts its timer on resume", () => {
    const store = createToastStore({ durationMs: 30 });
    const view = collect(store);
    store.pause();
    store.push({ kind: "warning", textCode: "a" });
    jest.advanceTimersByTime(100);
    expect(view.latest().length).toBe(1);
    store.resume();
    jest.advanceTimersByTime(30);
    expect(view.latest().length).toBe(0);
  });

  test("keeps only absolute https links and drops the label without a link", () => {
    const store = createToastStore({ durationMs: 10_000, maxVisible: 10 });
    const view = collect(store);
    store.push({ kind: "info", textCode: "a", href: "javascript:alert(1)", hrefLabelCode: "x" });
    store.push({ kind: "info", textCode: "b", href: "/relative", hrefLabelCode: "x" });
    store.push({ kind: "info", textCode: "c", href: "https://example.com/ok", hrefLabelCode: "x" });
    store.push({ kind: "info", textCode: "d", hrefLabelCode: "x" });
    store.push({ kind: "info", textCode: "e", href: "http://example.com/x", hrefLabelCode: "x" });
    const [javascript, relative, secure, noHref, insecure] = view.latest();
    expect(javascript?.href).toBeUndefined();
    expect(javascript?.hrefLabelCode).toBeUndefined();
    expect(relative?.href).toBeUndefined();
    expect(secure?.href).toBe("https://example.com/ok");
    expect(secure?.hrefLabelCode).toBe("x");
    expect(noHref?.href).toBeUndefined();
    expect(insecure?.href).toBeUndefined();
    expect(noHref?.hrefLabelCode).toBeUndefined();
  });

  test("subscribe delivers the current list immediately", () => {
    const store = createToastStore({ durationMs: 10_000 });
    store.push({ kind: "info", textCode: "a" });
    const view = collect(store);
    expect(view.latest().map((toast) => toast.textCode)).toEqual(["a"]);
  });
});

describe("toasts part", () => {
  const ctx = {
    text: (code: string) => `T:${code}`,
  } as unknown as HostContext;

  function mountPart(store: ToastStore): { layer: HTMLElement; stop: () => void } {
    const layer = page.document.createElement("div");
    page.document.body.append(layer);
    const stop = createToastsPart(store).start(ctx, layer);
    return { layer, stop };
  }

  test("renders copy via ctx.text as text content, never as markup", () => {
    const store = createToastStore({ durationMs: 10_000 });
    const { layer, stop } = mountPart(store);
    store.push({ kind: "info", textCode: "<b>x</b>" });
    const message = layer.querySelector(".toast__message") as HTMLElement;
    expect(message.textContent).toBe("T:<b>x</b>");
    expect(message.querySelector("b")).toBeNull();
    stop();
    layer.remove();
  });

  test("renders a link only for a safe href, with noopener noreferrer", () => {
    const store = createToastStore({ durationMs: 10_000 });
    const { layer, stop } = mountPart(store);
    store.push({ kind: "info", textCode: "a", href: "javascript:alert(1)", hrefLabelCode: "label" });
    store.push({ kind: "info", textCode: "b", href: "https://example.com/x", hrefLabelCode: "label" });
    const links = [...layer.querySelectorAll("a")];
    expect(links.length).toBe(1);
    expect(links[0]?.getAttribute("href")).toBe("https://example.com/x");
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[0]?.textContent).toBe("T:label");
    stop();
    layer.remove();
  });

  test("close button dismisses the toast from the DOM", () => {
    const store = createToastStore({ durationMs: 10_000 });
    const { layer, stop } = mountPart(store);
    store.push({ kind: "error", textCode: "a" });
    expect(layer.querySelectorAll(".toast").length).toBe(1);
    (layer.querySelector(".toast__close") as HTMLButtonElement).click();
    expect(layer.querySelectorAll(".toast").length).toBe(0);
    stop();
    layer.remove();
  });

  test("hover holds the auto-dismiss timer; leave releases it", () => {
    const store = createToastStore({ durationMs: 40 });
    const { layer, stop } = mountPart(store);
    store.push({ kind: "info", textCode: "a" });
    const el = layer.querySelector(".toast") as HTMLElement;
    el.dispatchEvent(new page.Event("mouseenter"));
    jest.advanceTimersByTime(200);
    expect(layer.querySelectorAll(".toast").length).toBe(1);
    el.dispatchEvent(new page.Event("mouseleave"));
    jest.advanceTimersByTime(40);
    expect(layer.querySelectorAll(".toast").length).toBe(0);
    stop();
    layer.remove();
  });

  test("stop releases outstanding hover holds and removes the DOM", () => {
    const store = createToastStore({ durationMs: 40 });
    const view = collect(store);
    const { layer, stop } = mountPart(store);
    store.push({ kind: "info", textCode: "a" });
    const el = layer.querySelector(".toast") as HTMLElement;
    el.dispatchEvent(new page.Event("mouseenter"));
    stop();
    layer.remove();
    expect(layer.querySelectorAll(".toast").length).toBe(0);
    jest.advanceTimersByTime(40);
    expect(view.latest().length).toBe(0);
  });
});

describe("store defaults", () => {
  test("shows at most 3 toasts and dismisses all of them after 7 s when no options are passed", () => {
    const store = createToastStore();
    const view = collect(store);
    store.push({ kind: "info", textCode: "a" });
    store.push({ kind: "info", textCode: "b" });
    store.push({ kind: "info", textCode: "c" });
    store.push({ kind: "info", textCode: "d" });
    expect(view.latest().map((toast) => toast.textCode)).toEqual(["b", "c", "d"]);
    jest.advanceTimersByTime(6999);
    expect(view.latest().length).toBe(3);
    jest.advanceTimersByTime(1);
    expect(view.latest().length).toBe(0);
  });
});
