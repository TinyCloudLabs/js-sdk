import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import { activitySection } from "../../src/ui/sections/activity";
import type { PanelClient, RequestLogReader, SectionContext } from "../../src/ui/slots";
import type { ToastRequest } from "../../src/ui/toast-store";
import { panelText } from "../../src/ui/strings-panel";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const GLOBAL_NAMES = [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Event",
  "MouseEvent",
  "requestAnimationFrame",
  "cancelAnimationFrame",
];

let page: Window;
const saved = new Map<string, unknown>();
const cleanups: Array<() => void> = [];
let clipboardDescriptor: PropertyDescriptor | undefined;

// Animation frames run when the test says so.
let frames = new Map<number, () => void>();
let nextFrame = 0;
const runFrames = () => {
  const due = [...frames.values()];
  frames = new Map();
  for (const run of due) run();
};

let copied: string[] = [];
let clipboardFails = false;

beforeAll(() => {
  for (const name of GLOBAL_NAMES) saved.set(name, g[name]);
  page = new JSDOM("", { url: "https://app.example/page" }).window as unknown as Window;
  g.window = page;
  g.document = page.document;
  g.HTMLElement = page.HTMLElement;
  g.Element = page.Element;
  g.Event = page.Event;
  g.MouseEvent = page.MouseEvent;
  g.requestAnimationFrame = (run: () => void) => {
    nextFrame += 1;
    frames.set(nextFrame, run);
    return nextFrame;
  };
  g.cancelAnimationFrame = (id: number) => void frames.delete(id);
  clipboardDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        if (clipboardFails) throw new Error("denied");
        copied.push(value);
      },
    },
  });
});

afterAll(() => {
  for (const name of GLOBAL_NAMES) {
    if (saved.get(name) === undefined) delete g[name];
    else g[name] = saved.get(name);
  }
  if (clipboardDescriptor) Object.defineProperty(globalThis.navigator, "clipboard", clipboardDescriptor);
  else delete (globalThis.navigator as unknown as Loose).clipboard;
});

afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
  page.document.body.innerHTML = "";
  frames = new Map();
  copied = [];
  clipboardFails = false;
});

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const T0 = new Date(2026, 9, 24, 10, 42, 7).getTime();

function entry(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id,
    at: T0,
    service: "kv",
    op: "kv/put",
    path: "notes/",
    space: "personal",
    host: "node.tinycloud.xyz",
    bytes: 3277,
    durationMs: 112,
    attempts: 1,
    ok: true,
    code: "ok",
    source: "network",
    ...over,
  };
}

/** A request log the test drives: push adds an entry and notifies, clear empties and notifies. */
function fakeLog(initial: Array<Record<string, unknown>> = []) {
  let rows = [...initial];
  const pushed = new Set<(event: unknown) => void>();
  const cleared = new Set<() => void>();
  const reader: RequestLogReader = {
    snapshot: () => [...rows],
    subscribe(cb) {
      pushed.add(cb);
      return () => void pushed.delete(cb);
    },
    onClear(cb) {
      cleared.add(cb);
      return () => void cleared.delete(cb);
    },
  };
  return {
    reader,
    listeners: () => pushed.size + cleared.size,
    /** Mimics a reader whose unsubscribe functions do nothing: late events still reach the old callback. */
    ignoreUnsubscribe() {
      reader.subscribe = (cb) => {
        pushed.add(cb);
        return () => undefined;
      };
    },
    /** Replaces the log's content without telling anyone, as a new session's log would start. */
    replace(next: Array<Record<string, unknown>>) {
      rows = [...next];
    },
    push(row: Record<string, unknown>) {
      rows.push(row);
      for (const cb of [...pushed]) cb(row);
    },
    clear() {
      rows = [];
      for (const cb of [...cleared]) cb();
    },
  };
}

interface Harness {
  readonly el: HTMLElement;
  readonly toasts: ToastRequest[];
  readonly renders: () => number;
  readonly dispose: () => void;
  /** The panel's client is replaced by one with this log, as when the host registers another client. */
  readonly swapClient: (reader: RequestLogReader | undefined) => void;
  /** The current client's sign-out / account-switch reset. */
  readonly resetClient: () => void;
}

function mountWith(
  reader: RequestLogReader | undefined,
  extras: { nodes?: unknown; sync?: unknown; app?: string } = {},
): Harness {
  const toasts: ToastRequest[] = [];
  let renders = 0;
  let resetListeners = new Set<() => void>();
  const changeListeners = new Set<() => void>();
  const clientFor = (log: RequestLogReader | undefined) => {
    resetListeners = new Set();
    const mine = resetListeners;
    return {
      id: 1,
      signedIn: () => true,
      requests: log,
      sync: extras.sync,
      onReset(cb: () => void) {
        mine.add(cb);
        return () => void mine.delete(cb);
      },
    } as unknown as PanelClient;
  };
  let client = clientFor(reader);
  const ctx = {
    client: () => client,
    onClientChange(cb: () => void) {
      changeListeners.add(cb);
      return () => void changeListeners.delete(cb);
    },
    text: panelText,
    appLabel: () => extras.app,
    toast: (request: ToastRequest) => {
      toasts.push(request);
      return "t";
    },
    requestRender: () => void (renders += 1),
    data: {
      latest: (key: string) => (key === "nodes" ? extras.nodes : undefined),
      subscribe: () => () => undefined,
    },
  } as unknown as SectionContext;
  const el = page.document.createElement("div");
  el.dataset.section = "activity";
  page.document.body.append(el);
  const dispose = activitySection.mount(el, ctx);
  cleanups.push(dispose);
  return {
    el,
    toasts,
    renders: () => renders,
    dispose,
    swapClient(next) {
      client = clientFor(next);
      for (const cb of [...changeListeners]) cb();
    },
    resetClient() {
      for (const cb of [...resetListeners]) cb();
    },
  };
}

const rowsOf = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".act-ar:not(.act-hd)")];
const cellText = (row: Element, className: string) => row.querySelector(`.${className}`)?.textContent ?? "";
const button = (el: HTMLElement, name: string) =>
  [...el.querySelectorAll("button")].find((node) => node.textContent?.includes(name)) as HTMLButtonElement;
const errorsSwitch = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('button[role="switch"]') as HTMLButtonElement;

describe("request table", () => {
  test("a request is ten cells in column order, copy last, with the header naming the columns", () => {
    const { el } = mountWith(fakeLog([entry(1)]).reader);
    const header = [...el.querySelectorAll(".act-hd [role=columnheader]")].map((node) => node.textContent);
    expect(header).toEqual(["Time", "Operation", "Path", "Space", "Host", "Bytes", "Took", "Result", "Source", "Copy"]);
    const row = rowsOf(el)[0];
    const cells = [...(row?.querySelectorAll(":scope > [role=cell]") ?? [])];
    expect(cells.map((cell) => cell.textContent)).toEqual([
      "10:42:07",
      "kv/put",
      "notes/",
      "personal",
      "node.tinycloud.xyz",
      "3.2 KiB",
      "112 ms",
      "ok",
      "network",
      "",
    ]);
    expect(cells[9]?.querySelector("button")?.getAttribute("aria-label")).toBe("Copy request: kv/put notes/ at 10:42:07");
  });

  test("shows newest first and the count of rows shown against the log", () => {
    const { el } = mountWith(fakeLog([entry(1, { op: "kv/get" }), entry(2, { op: "kv/put" })]).reader);
    expect(rowsOf(el).map((row) => cellText(row, "act-c-op"))).toEqual(["kv/put", "kv/get"]);
    expect(el.querySelector(".act-count")?.textContent).toBe("2 of 2 requests · 0 errors");
  });

  test("missing fields show a dash; a replica read with no host is on this device; sizes use B, KiB and MiB", () => {
    const { el } = mountWith(
      fakeLog([
        entry(1, { path: null, space: null, host: null, bytes: null, durationMs: null, source: "replica" }),
        entry(2, { bytes: 12, host: null }),
        entry(3, { bytes: 5033164 }),
      ]).reader,
    );
    const [mib, bare, replica] = rowsOf(el);
    expect(cellText(mib as Element, "act-c-bytes")).toBe("4.8 MiB");
    expect(cellText(bare as Element, "act-c-bytes")).toBe("12 B");
    expect(cellText(bare as Element, "act-c-host")).toBe("\u2014");
    expect(cellText(replica as Element, "act-c-host")).toBe("this device");
    expect(["act-c-path", "act-c-space", "act-c-bytes", "act-c-took"].map((name) => cellText(replica as Element, name))).toEqual([
      "\u2014",
      "\u2014",
      "\u2014",
      "\u2014",
    ]);
    expect(cellText(replica as Element, "act-c-source")).toBe("replica");
  });

  test("a failure is marked and shows its code; an unsafe code shows 'unknown'", () => {
    const { el } = mountWith(
      fakeLog([entry(1, { ok: false, code: "HTTP_507" }), entry(2, { ok: false, code: "bad code\nline" })]).reader,
    );
    const [odd, failed] = rowsOf(el);
    expect(failed?.classList.contains("act-err")).toBe(true);
    expect(cellText(failed as Element, "act-c-res")).toBe("HTTP_507");
    expect(failed?.querySelector(".act-c-res svg")).not.toBeNull();
    expect(cellText(odd as Element, "act-c-res")).toBe("unknown");
    expect(odd?.classList.contains("act-err")).toBe(true);
  });

  test("the empty log says so, and the empty state does not offer Copy all", () => {
    const { el } = mountWith(fakeLog().reader);
    expect(rowsOf(el)).toHaveLength(0);
    expect(el.querySelector('[role="table"]')?.textContent).toContain("No requests yet.");
    expect(button(el, "Copy all").disabled).toBe(true);
  });

  test("an unknown value is never drawn or copied as zero, success or a default source", async () => {
    const missing = { bytes: undefined, durationMs: undefined, code: undefined, source: undefined, at: undefined, ok: undefined };
    const { el } = mountWith(
      fakeLog([
        entry(1, missing),
        // Not a count: a string, NaN, a negative and an object are all unknown.
        entry(2, { ...missing, bytes: "12", durationMs: Number.NaN }),
        entry(3, { ...missing, bytes: -1, durationMs: {} }),
        // Zero that the log did report stays zero.
        entry(4, { ...missing, bytes: 0, durationMs: 0, ok: true, code: "ok", source: "network" }),
      ]).reader,
    );
    // Newest first: entry 4, which the log reported, then the three it did not.
    const [reported, ...unknown] = rowsOf(el);
    expect(cellText(reported as Element, "act-c-bytes")).toBe("0 B");
    expect(cellText(reported as Element, "act-c-took")).toBe("0 ms");
    expect(unknown).toHaveLength(3);
    for (const row of unknown) {
      expect(cellText(row, "act-c-bytes")).toBe("\u2014");
      expect(cellText(row, "act-c-took")).toBe("\u2014");
      expect(cellText(row, "act-c-time")).toBe("\u2014");
      expect(cellText(row, "act-c-source")).toBe("\u2014");
      expect(cellText(row, "act-c-res")).toBe("unknown");
      expect(row.classList.contains("act-err")).toBe(false);
      expect(row.textContent).not.toMatch(/\b0 (B|ms)\b|network|\bok\b/);
    }
    button(el, "Copy all").click();
    await flush();
    const lines = (copied[0] ?? "").split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("\u2014  kv/put  notes/  personal  node.tinycloud.xyz  0 B  0 ms  ok  network");
    for (const line of lines.slice(1)) {
      expect(line).toBe("\u2014  kv/put  notes/  personal  node.tinycloud.xyz  \u2014  \u2014  unknown  \u2014");
    }
  });

  test("an entry with no id or no result is kept, and two identical ones are two rows", () => {
    const bare = { op: "kv/get", ok: true };
    const { el } = mountWith(fakeLog([bare, bare, entry(2, { ok: "yes" }), "text", null, 7] as Array<Record<string, unknown>>).reader);
    expect(rowsOf(el)).toHaveLength(3);
    expect(rowsOf(el).map((row) => cellText(row, "act-c-res"))).toEqual(["unknown", "ok", "ok"]);
    expect(el.querySelector(".act-count")?.textContent).toBe("3 of 3 requests · \u2014 errors");
  });

  test("with an outcome unknown and no failure seen, errors only does not say everything went through", () => {
    const { el } = mountWith(fakeLog([entry(1), entry(2, { ok: undefined })]).reader);
    errorsSwitch(el).click();
    expect(rowsOf(el)).toHaveLength(0);
    expect(el.querySelector('[role="table"]')?.textContent).toContain("Some requests have no recorded result.");
    expect(el.querySelector('[role="table"]')?.textContent).not.toContain("Everything this app asked for went through");
  });

  test("an unreadable log says so instead of showing an empty table or counts", () => {
    const reader: RequestLogReader = {
      snapshot: () => {
        throw new Error("gone");
      },
      subscribe: () => () => undefined,
      onClear: () => () => undefined,
    };
    const { el } = mountWith(reader);
    expect(rowsOf(el)).toHaveLength(0);
    expect(el.querySelector('[role="table"]')?.textContent).toContain("The request log can't be read right now.");
    expect(el.querySelector('[role="table"]')?.textContent).not.toContain("No requests yet.");
    expect(el.querySelector<HTMLElement>(".act-count")?.hidden).toBe(true);
    expect(button(el, "Copy all").disabled).toBe(true);
  });
});

describe("errors only", () => {
  test("hides successful requests and keeps the total", () => {
    const { el } = mountWith(fakeLog([entry(1), entry(2, { ok: false, code: "HTTP_403" }), entry(3)]).reader);
    errorsSwitch(el).click();
    expect(errorsSwitch(el).getAttribute("aria-checked")).toBe("true");
    expect(rowsOf(el)).toHaveLength(1);
    expect(cellText(rowsOf(el)[0] as Element, "act-c-res")).toBe("HTTP_403");
    expect(el.querySelector(".act-count")?.textContent).toBe("1 of 3 requests · 1 error");
    errorsSwitch(el).click();
    expect(rowsOf(el)).toHaveLength(3);
  });

  test("with no failures it says everything went through", () => {
    const { el } = mountWith(fakeLog([entry(1)]).reader);
    errorsSwitch(el).click();
    expect(rowsOf(el)).toHaveLength(0);
    expect(el.querySelector('[role="table"]')?.textContent).toContain("No errors. Everything this app asked for went through.");
  });
});

describe("render cap", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => entry(i + 1, { op: `kv/op${i + 1}` }));

  test("draws the newest 100 and says so", () => {
    const { el } = mountWith(fakeLog(many(150)).reader);
    const rows = rowsOf(el);
    expect(rows).toHaveLength(100);
    expect(cellText(rows[0] as Element, "act-c-op")).toBe("kv/op150");
    expect(cellText(rows[99] as Element, "act-c-op")).toBe("kv/op51");
    expect(el.querySelector(".act-cap")?.hasAttribute("hidden")).toBe(false);
    expect(el.querySelector(".act-cap")?.textContent).toBe("Showing the newest 100 requests.");
    expect(el.querySelector(".act-count")?.textContent).toBe("100 of 150 requests · 0 errors");
  });

  test("no note at or under the cap", () => {
    const { el } = mountWith(fakeLog(many(100)).reader);
    expect(rowsOf(el)).toHaveLength(100);
    expect(el.querySelector(".act-cap")?.hasAttribute("hidden")).toBe(true);
  });

  test("Copy all copies the rows on screen, not the whole log", async () => {
    const { el } = mountWith(fakeLog(many(150)).reader);
    button(el, "Copy all").click();
    await flush();
    const lines = (copied[0] ?? "").split("\n");
    expect(lines).toHaveLength(100);
    expect(lines[0]).toContain("kv/op150");
    expect(lines[99]).toContain("kv/op51");
  });
});

describe("copy", () => {
  test("one request copies the mockup's plain-text line and raises a success toast", async () => {
    const { el, toasts } = mountWith(fakeLog([entry(1)]).reader);
    el.querySelector<HTMLButtonElement>(".act-c-copy button")?.click();
    await flush();
    expect(copied).toEqual(["10:42:07  kv/put  notes/  personal  node.tinycloud.xyz  3.2 KiB  112 ms  ok  network"]);
    expect(toasts).toEqual([{ kind: "success", textCode: "activity.copied_one" }]);
  });

  test("Copy all copies one line per visible request, newest first, and follows Errors only", async () => {
    const { el, toasts } = mountWith(
      fakeLog([entry(1, { op: "kv/get" }), entry(2, { ok: false, code: "HTTP_403" }), entry(3, { op: "kv/del" })]).reader,
    );
    button(el, "Copy all").click();
    await flush();
    expect(copied[0]?.split("\n").map((line) => line.split("  ")[1])).toEqual(["kv/del", "kv/put", "kv/get"]);
    errorsSwitch(el).click();
    button(el, "Copy all").click();
    await flush();
    expect(copied[1]?.split("\n")).toEqual(["10:42:07  kv/put  notes/  personal  node.tinycloud.xyz  3.2 KiB  112 ms  HTTP_403  network"]);
    expect(toasts.map((toast) => toast.textCode)).toEqual(["activity.copied_many", "activity.copied_many"]);
  });

  test("a failed copy raises an error toast", async () => {
    clipboardFails = true;
    const { el, toasts } = mountWith(fakeLog([entry(1)]).reader);
    el.querySelector<HTMLButtonElement>(".act-c-copy button")?.click();
    await flush();
    expect(copied).toEqual([]);
    expect(toasts).toEqual([{ kind: "error", textCode: "activity.copy_failed" }]);
  });

  test("a token-like field on an entry is neither drawn nor copied; a newline in a field cannot forge a line", async () => {
    const secret = "tok_SECRET_0123456789";
    const { el } = mountWith(
      fakeLog([
        entry(1, {
          token: secret,
          authorization: `Bearer ${secret}`,
          delegation: secret,
          value: secret,
          headers: { cookie: secret },
          path: "notes/\nforged-line",
          op: "kv/get\r\n10:00:00  forged",
        }),
      ]).reader,
    );
    el.querySelector<HTMLButtonElement>(".act-c-copy button")?.click();
    button(el, "Copy all").click();
    await flush();
    expect(el.textContent).toContain("notes/");
    expect(el.innerHTML).not.toContain("tok_SECRET");
    expect(copied).toHaveLength(2);
    for (const payload of copied) {
      expect(payload.split("\n")).toHaveLength(1);
      expect(payload).toContain("kv/get");
    }
    expect(copied.join("")).not.toContain("Bearer");
  });
});

describe("live log", () => {
  test("a new request appears at the top after a frame, and existing rows keep their elements", () => {
    const log = fakeLog([entry(1, { op: "kv/get" })]);
    const { el, renders } = mountWith(log.reader);
    const first = rowsOf(el)[0];
    log.push(entry(2, { op: "kv/put" }));
    expect(rowsOf(el)).toHaveLength(1);
    runFrames();
    const rows = rowsOf(el);
    expect(rows.map((row) => cellText(row, "act-c-op"))).toEqual(["kv/put", "kv/get"]);
    expect(rows[1]).toBe(first as Element);
    expect(rows[0]?.classList.contains("act-new")).toBe(true);
    expect(first?.classList.contains("act-new")).toBe(false);
    expect(renders()).toBe(1);
  });

  test("a burst of requests paints once", () => {
    const log = fakeLog();
    const { el } = mountWith(log.reader);
    for (let id = 1; id <= 5; id++) log.push(entry(id));
    expect(frames.size).toBe(1);
    runFrames();
    expect(rowsOf(el)).toHaveLength(5);
  });

  test("Pause holds the rows; Resume shows what arrived meanwhile", () => {
    const log = fakeLog([entry(1)]);
    const { el, renders } = mountWith(log.reader);
    const pause = button(el, "Pause live");
    pause.click();
    expect(pause.textContent).toBe("Resume live");
    log.push(entry(2));
    runFrames();
    expect(rowsOf(el)).toHaveLength(1);
    // The table is held, but the rail and Overview are told the log changed.
    expect(renders()).toBe(1);
    pause.click();
    expect(pause.textContent).toBe("Pause live");
    expect(rowsOf(el)).toHaveLength(2);
  });

  test("Copy all while paused copies the held rows", async () => {
    const log = fakeLog([entry(1)]);
    const { el } = mountWith(log.reader);
    button(el, "Pause live").click();
    log.push(entry(2));
    button(el, "Copy all").click();
    await flush();
    expect(copied[0]?.split("\n")).toHaveLength(1);
  });

  test("a clear empties the table at once and drops rows held by Pause", () => {
    const log = fakeLog([entry(1), entry(2)]);
    const { el } = mountWith(log.reader);
    button(el, "Pause live").click();
    log.clear();
    expect(rowsOf(el)).toHaveLength(0);
    expect(el.querySelector('[role="table"]')?.textContent).toContain("No requests yet.");
    expect(button(el, "Pause live")).toBeDefined();
    log.push(entry(3));
    runFrames();
    expect(rowsOf(el)).toHaveLength(1);
  });

  test("dispose removes every subscription and stops painting", () => {
    const log = fakeLog([entry(1)]);
    const { el, dispose } = mountWith(log.reader);
    expect(log.listeners()).toBe(2);
    log.push(entry(2));
    expect(frames.size).toBe(1);
    dispose();
    expect(log.listeners()).toBe(0);
    expect(frames.size).toBe(0);
    log.push(entry(3));
    runFrames();
    expect(el.childElementCount).toBe(0);
  });
});

describe("facts under the table", () => {
  test("shows the active node and whether the local copy is on", () => {
    const sync = { state: { effective: "on" }, subscribe: () => () => undefined };
    const nodes = {
      state: "ready",
      data: [
        { origin: "https://other.example", active: false },
        { origin: "https://node.tinycloud.xyz", active: true, version: "0.14.2" },
      ],
    };
    const { el } = mountWith(fakeLog().reader, { nodes, sync });
    const facts = [...el.querySelectorAll(".act-facts > div")].map((row) => row.textContent);
    expect(facts).toEqual(["Nodenode.tinycloud.xyz \u00b7 v0.14.2", "Local copyOn"]);
  });

  test("hides what it cannot read", () => {
    const { el } = mountWith(fakeLog().reader);
    expect(el.querySelector<HTMLElement>(".act-facts")?.hidden).toBe(true);
  });
});

describe("section entry", () => {
  test("without a request log it keeps the neutral placeholder", () => {
    const { el } = mountWith(undefined);
    expect(el.querySelector('[role="table"]')).toBeNull();
    expect(el.querySelector(".sec-title")?.textContent).toBe("Activity");
  });

  test("names the app in the developer-mode note, with a fallback", () => {
    const named = mountWith(fakeLog().reader, { app: "Fieldnotes" });
    expect(named.el.querySelector(".act-devnote")?.textContent).toBe(
      "Developer mode is set by Fieldnotes in code, in the SDK config. It isn't a user setting, and people using Fieldnotes never see this section.",
    );
    const bare = mountWith(fakeLog().reader);
    expect(bare.el.querySelector(".act-devnote")?.textContent).toContain("set by this app in code");
  });

  const statusOf = (reader: unknown) =>
    activitySection.status({ client: () => ({ requests: reader }), text: panelText } as unknown as SectionContext);
  const statusFor = (rows: Array<Record<string, unknown>>) => statusOf(fakeLog(rows).reader);

  test("status counts failures from the log and warns only when there are some", () => {
    expect(statusFor([entry(1), entry(2)])).toEqual({ text: "No errors", tone: "ok", count: "Clear" });
    expect(statusFor([entry(1), entry(2, { ok: false }), entry(3, { ok: false })])).toEqual({ text: "2 errors", tone: "warn" });
    expect(statusFor([])).toEqual({ text: "No errors", tone: "ok", count: "Clear" });
  });

  test("an unreadable log has no status, never 'Clear'", () => {
    expect(statusOf(undefined)).toBeUndefined();
    expect(statusOf({ snapshot: () => { throw new Error("gone"); } })).toBeUndefined();
    expect(statusOf({ snapshot: () => undefined })).toBeUndefined();
    expect(statusOf({ snapshot: () => "not a list" })).toBeUndefined();
  });

  test("a request with no recorded result is not counted as a success: no failure seen means no status", () => {
    expect(statusFor([entry(1), entry(2, { ok: undefined })])).toBeUndefined();
    expect(statusFor([entry(1, { ok: null })])).toBeUndefined();
    // A failure that is known still counts, whatever else is unknown.
    expect(statusFor([entry(1, { ok: undefined }), entry(2, { ok: false })])).toEqual({ text: "1 errors", tone: "warn" });
  });
});

describe("one account's log never feeds another's table", () => {
  test("a replaced client: the old log stops feeding rows and the new log's rows show", () => {
    const first = fakeLog([entry(1, { op: "kv/old" })]);
    const second = fakeLog([entry(1, { op: "kv/new" })]);
    const { el, swapClient } = mountWith(first.reader);
    swapClient(second.reader);
    expect(first.listeners()).toBe(0);
    expect(second.listeners()).toBe(2);
    expect(rowsOf(el).map((row) => cellText(row, "act-c-op"))).toEqual(["kv/new"]);
    first.push(entry(2, { op: "kv/old2" }));
    second.push(entry(3, { op: "kv/new2" }));
    runFrames();
    expect(rowsOf(el).map((row) => cellText(row, "act-c-op"))).toEqual(["kv/new2", "kv/new"]);
  });

  test("a replaced client with no log says the log can't be read, and shows none of the old rows", () => {
    const first = fakeLog([entry(1)]);
    const { el, swapClient } = mountWith(first.reader);
    swapClient(undefined);
    expect(rowsOf(el)).toHaveLength(0);
    expect(el.querySelector('[role="table"]')?.textContent).toContain("The request log can't be read right now.");
    expect(first.listeners()).toBe(0);
  });

  test("an old log that ignores unsubscribe cannot paint after the swap", () => {
    const first = fakeLog([entry(1, { op: "kv/old" })]);
    first.ignoreUnsubscribe();
    const second = fakeLog([entry(1, { op: "kv/new" })]);
    const { el, swapClient, renders } = mountWith(first.reader);
    swapClient(second.reader);
    const before = renders();
    first.push(entry(2, { op: "kv/old2" }));
    expect(frames.size).toBe(0);
    runFrames();
    expect(renders()).toBe(before);
    expect(rowsOf(el).map((row) => cellText(row, "act-c-op"))).toEqual(["kv/new"]);
  });

  test("a reset drops rows held by Pause even when the log sends no clear", () => {
    const log = fakeLog([entry(1, { op: "kv/old" })]);
    const { el, resetClient } = mountWith(log.reader);
    button(el, "Pause live").click();
    log.replace([entry(2, { op: "kv/new" })]);
    resetClient();
    expect(button(el, "Pause live")).toBeDefined();
    expect(rowsOf(el).map((row) => cellText(row, "act-c-op"))).toEqual(["kv/new"]);
  });

  test("after a reset a row with a reused id shows the new content, not the old row", () => {
    const log = fakeLog([entry(1, { op: "kv/old", path: "old/" })]);
    const { el, resetClient } = mountWith(log.reader);
    log.replace([entry(1, { op: "kv/new", path: "new/" })]);
    resetClient();
    const [row] = rowsOf(el);
    expect(cellText(row as Element, "act-c-op")).toBe("kv/new");
    expect(cellText(row as Element, "act-c-path")).toBe("new/");
    expect(row?.classList.contains("act-new")).toBe(false);
  });

  test("a reset listens to the log again, and dispose removes every listener including the client ones", () => {
    const log = fakeLog();
    const { el, resetClient, swapClient, dispose } = mountWith(log.reader);
    resetClient();
    expect(log.listeners()).toBe(2);
    log.push(entry(1));
    runFrames();
    expect(rowsOf(el)).toHaveLength(1);
    const next = fakeLog();
    swapClient(next.reader);
    dispose();
    expect(next.listeners()).toBe(0);
    resetClient();
    swapClient(next.reader);
    expect(next.listeners()).toBe(0);
  });
});
