import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { TinyCloudWeb as TinyCloudWebType } from "../../src/modules/tcw";
import { REGISTRY_KEY } from "../../src/ui/host";
import { text } from "../../src/ui/strings";

type Config = NonNullable<ConstructorParameters<typeof TinyCloudWebType>[0]>;
type Loose = Record<PropertyKey, unknown>;
type Sink = (request: { kind: string; textCode: string }) => void;
type Scheduled = { callback: () => void; delay: number | undefined };

const g = globalThis as unknown as Loose;
const ORIGIN = "https://app.example";
const GLOBAL_NAMES = [
  "window",
  "document",
  "location",
  "localStorage",
  "customElements",
  "HTMLElement",
  "Element",
  "Event",
  "KeyboardEvent",
];
const ERROR_CODE = "toast.space_creation_failed";

let page: Window;
let TinyCloudWeb: typeof TinyCloudWebType;
const saved = new Map<string, unknown>();
const realSetTimeout = globalThis.setTimeout;
const scheduled: Scheduled[] = [];

beforeAll(async () => {
  for (const name of GLOBAL_NAMES) saved.set(name, g[name]);
  page = new JSDOM("", { url: `${ORIGIN}/page` }).window as unknown as Window;
  g.window = page;
  g.document = page.document;
  g.location = page.location;
  g.localStorage = page.localStorage;
  g.customElements = page.customElements;
  g.HTMLElement = page.HTMLElement;
  g.Element = page.Element;
  g.Event = page.Event;
  g.KeyboardEvent = page.KeyboardEvent;
  // Same dynamic import and query suffix as tcw-app-id.test.ts.
  TinyCloudWeb = (await import("../../src/modules/tcw.ts?real-tcw")).TinyCloudWeb;
});

afterAll(() => {
  for (const name of GLOBAL_NAMES) {
    if (saved.get(name) === undefined) delete g[name];
    else g[name] = saved.get(name);
  }
});

beforeEach(() => {
  delete g[REGISTRY_KEY];
  page.document.body.innerHTML = "";
  page.localStorage.clear();
  scheduled.length = 0;
  // Capture timers instead of running them, so nothing throws into the
  // test runner and no real wall-clock timer is involved.
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    scheduled.push({ callback, delay });
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
});

// The toast store also schedules its own 5 s auto-dismiss timer. Only the
// zero-delay timer is the throw path under test.
function throwTimers(): Scheduled[] {
  return scheduled.filter((entry) => entry.delay === 0);
}

function sinkFor(config: Config): Sink {
  const tc = new TinyCloudWeb({ persistSession: false, ...config }) as unknown as Loose;
  return tc.showToast as Sink;
}

describe("TinyCloudWeb notifications.throwErrors", () => {
  test("a shown error toast schedules one zero-delay throw with the fixed copy", () => {
    const sink = sinkFor({ notifications: { throwErrors: true } });
    sink({ kind: "error", textCode: ERROR_CODE });
    const timers = throwTimers();
    expect(timers.length).toBe(1);
    expect(() => timers[0]?.callback()).toThrow(text(ERROR_CODE));
  });

  test("the sink itself does not throw synchronously", () => {
    const sink = sinkFor({ notifications: { throwErrors: true } });
    expect(() => sink({ kind: "error", textCode: ERROR_CODE })).not.toThrow();
  });

  test("a success toast schedules no throw even with throwErrors", () => {
    const sink = sinkFor({ notifications: { throwErrors: true } });
    sink({ kind: "success", textCode: "toast.done" });
    expect(throwTimers()).toEqual([]);
  });

  test("without throwErrors an error toast schedules no throw", () => {
    const sink = sinkFor({});
    sink({ kind: "error", textCode: ERROR_CODE });
    expect(throwTimers()).toEqual([]);
  });

  test("an error that was not shown (headless ui) schedules no throw", () => {
    const sink = sinkFor({ ui: false, notifications: { throwErrors: true } });
    sink({ kind: "error", textCode: ERROR_CODE });
    expect(throwTimers()).toEqual([]);
  });
});
