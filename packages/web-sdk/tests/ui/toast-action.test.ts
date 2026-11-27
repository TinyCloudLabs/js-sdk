import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, test } from "bun:test";
import { JSDOM } from "jsdom";

import { createToastsPart } from "../../src/ui/parts/toasts";
import type { HostContext } from "../../src/ui/slots";
import { createToastStore } from "../../src/ui/toast-store";

// A toast with an action button (TC-4344's "finish setup" offer): the button runs the action in the click's tick and
// closes the toast; the toast stays until the owner clicks or closes it.

const g = globalThis as unknown as Record<PropertyKey, unknown>;
let savedDocument: unknown;
let page: Window;
const ctx = { text: (code: string) => `T:${code}` } as unknown as HostContext;

beforeAll(() => {
  savedDocument = g.document;
  page = new JSDOM("", { url: "https://app.example/page" }).window as unknown as Window;
  g.document = page.document;
});
afterAll(() => { g.document = savedDocument; });
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

function mount() {
  const store = createToastStore({ durationMs: 40 });
  const layer = page.document.createElement("div");
  page.document.body.append(layer);
  const stop = createToastsPart(store).start(ctx, layer);
  return { store, layer, stop: () => { stop(); layer.remove(); } };
}

test("the action button runs the action synchronously and closes the toast", () => {
  const { store, layer, stop } = mount();
  const runs: string[] = [];
  store.push({ kind: "info", textCode: "offer", action: { labelCode: "go", run: () => runs.push("run") } });
  const button = layer.querySelector(".toast__action") as HTMLButtonElement;
  expect(button.textContent).toBe("T:go");
  button.click();
  expect(runs).toEqual(["run"]);
  expect(layer.querySelectorAll(".toast").length).toBe(0);
  stop();
});

test("an action toast does not auto-dismiss; closing it does not run the action", () => {
  const { store, layer, stop } = mount();
  const runs: string[] = [];
  store.push({ kind: "info", textCode: "offer", action: { labelCode: "go", run: () => runs.push("run") } });
  store.push({ kind: "info", textCode: "plain" });
  jest.advanceTimersByTime(10_000);
  expect([...layer.querySelectorAll(".toast__message")].map((el) => el.textContent)).toEqual(["T:offer"]);
  (layer.querySelector(".toast__close") as HTMLButtonElement).click();
  expect(layer.querySelectorAll(".toast").length).toBe(0);
  expect(runs).toEqual([]);
  stop();
});
