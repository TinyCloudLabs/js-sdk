import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { DelegationRow, PanelDataSource, RevokeOutcome, ViewResult } from "../../src/ui/data";
import { createSectionData } from "../../src/ui/section-data";
import { createSectionDialogs } from "../../src/ui/section-dialogs";
import {
  delegationsSection,
  describeAbilities,
  groupRows,
  refusalPhase,
  shownStatus,
} from "../../src/ui/sections/delegations";
import type { PanelClient, SectionContext, SectionStatus } from "../../src/ui/slots";
import { createStubPanelData } from "../../src/ui/stub/index";
import { panelText } from "../../src/ui/strings-panel";

type Loose = Record<PropertyKey, unknown>;

const g = globalThis as unknown as Loose;
const GLOBAL_NAMES = ["window", "document", "HTMLElement", "Element", "Event", "MouseEvent", "KeyboardEvent", "Node"];
const saved = new Map<string, unknown>();
let page: Window;
const cleanups: Array<() => void> = [];

beforeAll(() => {
  for (const name of GLOBAL_NAMES) saved.set(name, g[name]);
  page = new JSDOM("", { url: "https://app.example/page" }).window as unknown as Window;
  // Rows leave at once, as they do under reduced motion.
  Object.assign(page, { matchMedia: () => ({ matches: true }) });
  for (const name of GLOBAL_NAMES) g[name] = (page as unknown as Loose)[name];
});

afterAll(() => {
  for (const name of GLOBAL_NAMES) {
    if (saved.get(name) === undefined) delete g[name];
    else g[name] = saved.get(name);
  }
});

afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
  page.document.body.innerHTML = "";
});

const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};

const NOW = Date.now();
const minutes = (n: number) => new Date(NOW + n * 60_000);

function row(cid: string, over: Partial<DelegationRow> = {}): DelegationRow {
  return {
    source: "stub",
    cid,
    direction: "granted",
    status: "active",
    group: "to-others",
    label: { text: `Helper ${cid}`, source: "stub" },
    delegatorDid: "did:key:z6MkOwnerOwnerOwnerOwnerOwner",
    delegateDid: `did:key:z6MkDelegate${cid}Delegate${cid}`,
    resources: [{ resource: "tinycloud.kv/notes/", actions: ["tinycloud.kv/get", "tinycloud.kv/list"] }],
    parents: [],
    issuedAt: minutes(-120),
    notBefore: null,
    expiresAt: minutes(60 * 24 * 5),
    expiringSoon: false,
    ...over,
  };
}

interface Harness {
  readonly el: HTMLElement;
  readonly revoked: string[];
  readonly receipts: Array<{ titleCode: string; bodyCode?: string; rows: ReadonlyArray<{ labelCode: string; value: string }> }>;
  readonly toasts: string[];
  readonly reads: { count: number };
  refresh(): Promise<void>;
  unmount(): void;
  remount(): Promise<HTMLElement>;
  status(): SectionStatus | undefined;
  setPage(result: ViewResult<{ rows: readonly DelegationRow[]; nextCursor?: string }>): void;
}

interface Options {
  rows?: readonly DelegationRow[];
  result?: ViewResult<{ rows: readonly DelegationRow[]; nextCursor?: string }>;
  revoke?: (cid: string) => Promise<RevokeOutcome>;
  requestAuthority?: PanelClient["requestAuthority"];
  source?: boolean;
  toasts?: boolean;
  slip?: boolean;
  /** `null`: the host gives no app name. */
  appLabel?: string | null;
}

async function mountSection(options: Options = {}): Promise<Harness> {
  let current: ViewResult<{ rows: readonly DelegationRow[]; nextCursor?: string }> = options.result ?? {
    state: "ready",
    data: { rows: options.rows ?? [] },
  };
  const revoked: string[] = [];
  const reads = { count: 0 };
  const source = {
    subscribe: () => () => undefined,
    delegations: async () => {
      reads.count += 1;
      return current;
    },
    revoke:
      options.revoke ??
      (async (cid: string): Promise<RevokeOutcome> => {
        revoked.push(cid);
        return { ok: true, cid };
      }),
  } as unknown as PanelDataSource;
  if (options.revoke !== undefined) {
    const inner = options.revoke;
    (source as unknown as { revoke: (cid: string) => Promise<RevokeOutcome> }).revoke = async (cid) => {
      revoked.push(cid);
      return inner(cid);
    };
  }

  const el = page.document.createElement("section");
  el.className = "section";
  el.dataset.section = "delegations";
  page.document.body.append(el);

  const data = createSectionData(() => (options.source === false ? undefined : source));
  if (options.source !== false) await data.refresh("delegations");
  let host = el;
  const dialogs = createSectionDialogs(() => host);
  const receipts: Harness["receipts"] = [];
  const toasts: string[] = [];
  const client = { signedIn: () => true, requestAuthority: options.requestAuthority, data: source } as unknown as PanelClient;
  const ctx = {
    client: () => client,
    text: panelText,
    appLabel: () => (options.appLabel === null ? undefined : (options.appLabel ?? "Fieldnotes")),
    requestRender: () => undefined,
    toastsEnabled: () => options.toasts !== false,
    toast: (request: { textCode: string }) => {
      toasts.push(request.textCode);
      return "t";
    },
    receipt: (request: Harness["receipts"][number]) => {
      receipts.push(request);
      return options.slip !== false;
    },
    data,
    confirm: (request: Parameters<typeof dialogs.confirm>[0]) => dialogs.confirm(request),
    openDrawer: (request: Parameters<typeof dialogs.openDrawer>[0]) => dialogs.openDrawer(request),
  } as unknown as SectionContext;

  const dispose = delegationsSection.mount(el, ctx);
  cleanups.push(dispose);
  cleanups.push(() => dialogs.closeAll());
  await flush();
  return {
    el,
    revoked,
    receipts,
    toasts,
    reads,
    refresh: () => data.refresh("delegations"),
    status: () => delegationsSection.status(ctx),
    unmount: () => {
      dialogs.closeAll();
      dispose();
    },
    // The panel was closed and opened again: the shell mounts a fresh section element against the same cache.
    remount: async () => {
      const again = page.document.createElement("section");
      again.className = "section";
      again.dataset.section = "delegations";
      page.document.body.append(again);
      host = again;
      cleanups.push(delegationsSection.mount(again, ctx));
      await flush();
      return again;
    },
    setPage: (result) => {
      current = result;
    },
  };
}

const cards = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>("article.dl-card")];
const names = (el: HTMLElement) => cards(el).map((card) => card.querySelector(".dl-name")?.firstChild?.textContent);
const buttonIn = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label);
const active = () => (page.document as Document).activeElement;

describe("describeAbilities", () => {
  test("known kv actions read as words, in the order read, write, list, delete", () => {
    const described = describeAbilities([
      { resource: "tinycloud.kv/notes/", actions: ["tinycloud.kv/list", "tinycloud.kv/put", "tinycloud.kv/get", "tinycloud.kv/del"] },
    ]);
    expect(described.plain).toBe("Can read, write, list and delete notes/");
    expect(described.chips).toEqual(["Read", "Write", "List", "Delete"]);
  });

  test("bare action names and a single action", () => {
    expect(describeAbilities([{ resource: "tinycloud.kv/notes/", actions: ["get"] }]).plain).toBe("Can read notes/");
    expect(describeAbilities([{ resource: "tinycloud.kv/notes/", actions: ["put"] }]).plain).toBe("Can write notes/");
    expect(describeAbilities([{ resource: "tinycloud.kv/notes/", actions: ["list"] }]).plain).toBe("Can list notes/");
    expect(describeAbilities([{ resource: "tinycloud.kv/notes/", actions: ["del"] }]).plain).toBe("Can delete notes/");
  });

  test("resources with the same actions share one clause; different actions get their own", () => {
    const same = describeAbilities([
      { resource: "tinycloud.kv/notes/", actions: ["get", "put", "list"] },
      { resource: "tinycloud.kv/recordings/", actions: ["get", "put", "list"] },
    ]);
    expect(same.plain).toBe("Can read, write and list notes/ and recordings/");
    const different = describeAbilities([
      { resource: "tinycloud.kv/notes/", actions: ["get", "list"] },
      { resource: "tinycloud.kv/recordings/", actions: ["put"] },
    ]);
    expect(different.plain).toBe("Can read and list notes/; write recordings/");
  });

  test("the path comes from a full space URI, and an empty path means everything", () => {
    const described = describeAbilities([
      { resource: "tinycloud:pkh:eip155:1:0x1234567890abcdef1234567890abcdef12345678:default/kv/notes/", actions: ["get"] },
      { resource: "tinycloud:pkh:eip155:1:0x1234567890abcdef1234567890abcdef12345678:default/kv/", actions: ["list"] },
    ]);
    expect(described.plain).toBe("Can read notes/; list everything");
  });

  test("unknown actions appear as they are, in the line and in the chips", () => {
    const described = describeAbilities([{ resource: "tinycloud.sql/db/", actions: ["tinycloud.sql/read", "get"] }]);
    expect(described.plain).toBe("Can read and tinycloud.sql/read db/");
    expect(described.chips).toEqual(["Read", "tinycloud.sql/read"]);
  });

  test("hostile or malformed input never throws and never carries control characters", () => {
    const hostile = [
      null,
      undefined,
      "x",
      {},
      { resource: 5, actions: ["get"] },
      { resource: "tinycloud.kv/a/", actions: "get" },
      { resource: "tinycloud.kv/a/", actions: [1, null, "constructor", "__proto__", "toString"] },
      { resource: "tinycloud.kv/a/", actions: ["\u202eevil\u0000\n" + "x".repeat(500)] },
    ];
    for (const entry of hostile) {
      expect(() => describeAbilities([entry] as never)).not.toThrow();
    }
    expect(() => describeAbilities(undefined as never)).not.toThrow();
    const described = describeAbilities(hostile as never);
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001f\u202e]/.test(described.plain + described.chips.join(""))).toBe(false);
    expect(described.chips.every((chip) => chip.length <= 64)).toBe(true);
    // Prototype names are plain unknown actions, not known verbs.
    expect(described.chips).toContain("constructor");
    expect(describeAbilities([]).plain).toBe("No actions listed");
  });
});

describe("the stub's revoke behaves like the adapter's active check", () => {
  const seeded = (cid: string, status: DelegationRow["status"]) => ({
    cid,
    direction: "granted" as const,
    status,
    group: "to-others" as const,
    label: { text: cid, source: "stub" as const },
    delegatorDid: "did:example:owner",
    delegateDid: `did:example:${cid}`,
    resources: [],
    parents: [],
    issuedAt: null,
    notBefore: null,
    expiresAt: null,
    expiringSoon: false,
  });
  const stub = () =>
    createStubPanelData({
      delegations: { rows: [seeded("live", "active"), seeded("done", "revoked"), seeded("old", "expired"), seeded("wait", "pending")] },
    })({ sync: undefined } as unknown as PanelClient);

  test("a revoke of a row that is not active is refused as not-revocable and changes nothing", async () => {
    const source = stub();
    for (const cid of ["done", "old", "wait"]) expect(await source.revoke(cid)).toEqual({ ok: false, code: "not-revocable" });
    const listed = await source.delegations();
    if (listed.state !== "ready") throw new Error("not ready");
    expect(listed.data.rows.map((r) => [r.cid, r.status])).toEqual([
      ["live", "active"],
      ["done", "revoked"],
      ["old", "expired"],
      ["wait", "pending"],
    ]);
  });

  test("an active row is revoked once: the list then shows it revoked and a second revoke is refused", async () => {
    const source = stub();
    expect(await source.revoke("live")).toEqual({ ok: true, cid: "live" });
    const listed = await source.delegations();
    if (listed.state !== "ready") throw new Error("not ready");
    expect(listed.data.rows.find((r) => r.cid === "live")?.status).toBe("revoked");
    expect(await source.revoke("live")).toEqual({ ok: false, code: "not-revocable" });
  });

  test("a seeded failure code is returned and the row stays active", async () => {
    const source = createStubPanelData({ delegations: { rows: [seeded("live", "active")], revokeFails: { live: "NETWORK_ERROR" } } })({
      sync: undefined,
    } as unknown as PanelClient);
    expect(await source.revoke("live")).toEqual({ ok: false, code: "NETWORK_ERROR" });
    const listed = await source.delegations();
    if (listed.state !== "ready") throw new Error("not ready");
    expect(listed.data.rows[0]?.status).toBe("active");
  });
});

describe("availability", () => {
  test("is unavailable without a signed-in session and available with one", () => {
    const hostFor = (signedIn: boolean) =>
      ({ client: () => ({ signedIn: () => signedIn }) as unknown as PanelClient }) as unknown as SectionContext;
    expect(delegationsSection.isAvailable(hostFor(false))).toBe(false);
    expect(delegationsSection.isAvailable(hostFor(true))).toBe(true);
    // No client at all reads as signed out.
    expect(delegationsSection.isAvailable({ client: () => undefined } as unknown as SectionContext)).toBe(false);
  });
});

describe("status mapping and grouping", () => {
  test("an active row is Active, within a day Expiring soon, past its end Expired", () => {
    expect(shownStatus(row("a"), NOW)).toBe("active");
    expect(shownStatus(row("a", { expiringSoon: true }), NOW)).toBe("soon");
    expect(shownStatus(row("a", { expiresAt: minutes(-5) }), NOW)).toBe("expired");
    expect(shownStatus(row("a", { status: "expired" }), NOW)).toBe("expired");
    expect(shownStatus(row("a", { status: "revoked" }), NOW)).toBe("revoked");
    expect(shownStatus(row("a", { status: "ancestor_revoked" }), NOW)).toBe("revoked");
    expect(shownStatus(row("a", { status: "pending" }), NOW)).toBe("pending");
  });

  test("rows fall into this app, others and received, in list order", () => {
    const grouped = groupRows([
      row("1", { group: "to-others" }),
      row("2", { group: "this-app" }),
      row("3", { group: "received" }),
      row("4", { group: "this-app" }),
    ]);
    expect(grouped["this-app"].map((r) => r.cid)).toEqual(["2", "4"]);
    expect(grouped["to-others"].map((r) => r.cid)).toEqual(["1"]);
    expect(grouped.received.map((r) => r.cid)).toEqual(["3"]);
  });

  test("refusal codes: not-active is stale, permission is denied, anything else failed", () => {
    expect(refusalPhase("not-revocable")).toBe("stale");
    expect(refusalPhase("PERMISSION_DENIED")).toBe("denied");
    expect(refusalPhase("unknown")).toBe("failed");
    expect(refusalPhase("constructor")).toBe("failed");
  });
});

describe("the body states", () => {
  test("the cache has not answered yet: a loading skeleton, no cards", async () => {
    const h = await mountSection({ result: { state: "loading" } });
    expect(h.el.querySelector(".dl-skel")?.hasAttribute("hidden")).toBe(false);
    expect(cards(h.el)).toHaveLength(0);
  });

  test("no data source: a neutral line", async () => {
    const h = await mountSection({ source: false });
    expect(h.el.textContent).toContain("Delegations aren't available here.");
  });

  test("no rows: the empty state, no groups", async () => {
    const h = await mountSection({ rows: [] });
    expect(h.el.textContent).toContain("No one has access yet");
    expect(cards(h.el)).toHaveLength(0);
  });

  test("needs permission: a neutral card with no Allow button unless the client can ask", async () => {
    const without = await mountSection({ result: { state: "needs-permission", ability: "delegation/list" } });
    expect(without.el.textContent).toContain("can't list delegations yet");
    expect(without.el.textContent).not.toContain("OpenKey");
    expect(buttonIn(without.el, "Allow delegation list")).toBeUndefined();
  });

  test("needs permission with a client that can ask: Allow asks for delegation/list, then re-reads", async () => {
    const asked: string[] = [];
    const h = await mountSection({
      result: { state: "needs-permission", ability: "delegation/list" },
      requestAuthority: async (kind) => {
        asked.push(kind);
        return { approved: true };
      },
    });
    const before = h.reads.count;
    h.setPage({ state: "ready", data: { rows: [row("a")] } });
    buttonIn(h.el, "Allow delegation list")?.click();
    await flush();
    expect(asked).toEqual(["delegation/list"]);
    expect(h.reads.count).toBeGreaterThan(before);
    expect(cards(h.el)).toHaveLength(1);
  });

  test("a declined ask changes nothing and says so", async () => {
    const h = await mountSection({
      result: { state: "needs-permission", ability: "delegation/list" },
      requestAuthority: async () => ({ approved: false }),
    });
    buttonIn(h.el, "Allow delegation list")?.click();
    await flush();
    expect(h.el.textContent).toContain("nothing changed");
    expect(cards(h.el)).toHaveLength(0);
  });

  test("a read error: a retry that reads again", async () => {
    const h = await mountSection({ result: { state: "error", code: "unknown" } });
    expect(h.el.textContent).toContain("didn't load");
    h.setPage({ state: "ready", data: { rows: [row("a")] } });
    buttonIn(h.el, "Try again")?.click();
    await flush();
    expect(cards(h.el)).toHaveLength(1);
  });

  test("groups with counts, the app's group first, Received only when present, Nothing here for an empty one", async () => {
    const h = await mountSection({ rows: [row("a", { group: "this-app" }), row("b"), row("c", { group: "received", direction: "received" })] });
    const headings = [...h.el.querySelectorAll(".dl-h")].map((node) => node.textContent);
    expect(headings).toEqual(["Granted to Fieldnotes1", "Granted to others1", "Received1"]);

    const onlyOthers = await mountSection({ rows: [row("b")] });
    const second = [...onlyOthers.el.querySelectorAll(".dl-h")].map((node) => node.textContent);
    expect(second).toEqual(["Granted to Fieldnotes0", "Granted to others1"]);
    expect(onlyOthers.el.textContent).toContain("Nothing here.");
  });

  test("a cursor on the page says the list is the first page", async () => {
    const h = await mountSection({ result: { state: "ready", data: { rows: [row("a"), row("b")], nextCursor: "c" } } });
    expect(h.el.textContent).toContain("Showing the first 2+");
  });

  test("the card: label, plain-words line, chips, a Terminal chip only when the data says so, status word", async () => {
    const h = await mountSection({
      rows: [
        row("a", { terminal: true, resources: [{ resource: "tinycloud.kv/notes/", actions: ["get", "put", "list"] }] }),
        row("b"),
        row("c", { expiringSoon: true }),
        row("d", { status: "expired", expiresAt: minutes(-60) }),
        row("e", { status: "revoked" }),
      ],
    });
    const [a, b, c, d, e] = cards(h.el);
    expect(a?.querySelector(".dl-what")?.textContent).toBe("Can read, write and list notes/");
    expect([...(a?.querySelectorAll(".dl-chip") ?? [])].map((chip) => chip.textContent)).toEqual(["Read", "Write", "List", "Terminal"]);
    expect([...(b?.querySelectorAll(".dl-chip") ?? [])].map((chip) => chip.textContent)).toEqual(["Read", "List"]);
    expect(a?.querySelector(".st")?.textContent).toBe("Active");
    expect(c?.querySelector(".st")?.textContent).toBe("Expiring soon");
    expect(c?.querySelector(".st")?.className).toContain("st-warn");
    expect(d?.querySelector(".st")?.textContent).toBe("Expired");
    expect(e?.querySelector(".st")?.textContent).toBe("Revoked");
    // Revoke is offered for the two active rows and never for an ended one.
    expect([a, b, c, d, e].map((card) => card?.querySelector<HTMLButtonElement>(".dl-acts .action:nth-of-type(2)")?.hidden)).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  test("a received grant is named after the other party, not after the delegate", async () => {
    const h = await mountSection({
      rows: [
        row("r", {
          group: "received",
          direction: "received",
          delegatorDid: "did:key:z6MkGrantorGrantorGrantorGrantor",
          delegateDid: "did:key:z6MkMeMeMeMeMeMeMeMeMeMeMe",
          label: { text: "did:key:z6MkMe…MeMeMe", source: "derived" },
        }),
      ],
    });
    expect(names(h.el)[0]).toBe("did:key:z6MkGr…rantor");
  });
});

describe("revoke", () => {
  async function openConfirm(h: Harness): Promise<HTMLElement> {
    buttonIn(h.el, "Revoke")?.click();
    await flush();
    const box = h.el.querySelector<HTMLElement>('[role="alertdialog"]');
    if (box === null) throw new Error("no confirm box");
    return box;
  }

  test("Revoke asks first: the box names what stops, says OpenKey, focuses Keep access, and calls nothing", async () => {
    const h = await mountSection({ rows: [row("a", { label: { text: "Research helper", source: "stub" } })] });
    const box = await openConfirm(h);
    const words = box.textContent ?? "";
    expect(words).toContain("Revoke access for Research helper?");
    expect(words).toContain("Research helper will stop being able to read and list notes/");
    expect(words).toContain("You'll confirm with your wallet in OpenKey. You can give access again later; this can't be undone from here.");
    const [keep, go] = [...box.querySelectorAll<HTMLButtonElement>("button")];
    expect(keep?.textContent).toBe("Keep access");
    expect(go?.textContent).toBe("Revoke access");
    expect(active()).toBe(keep ?? null);
    expect(h.revoked).toEqual([]);
    expect(box.getAttribute("aria-labelledby")).not.toBeNull();
  });

  test("the app's own grant names the app on this device, says what happens next, and never the DID", async () => {
    const h = await mountSection({ rows: [row("a", { group: "this-app", label: { text: "did:key:z6MkAp…AppKey", source: "derived" } })] });
    const words = (await openConfirm(h)).textContent ?? "";
    expect(words).toContain("Revoke access for Fieldnotes on this device?");
    expect(words).toContain("Fieldnotes will stop being able to read and list notes/");
    expect(words).toContain("Fieldnotes will stop working here until you sign in again.");
    expect(words).toContain("You'll confirm with your wallet in OpenKey.");
    expect(words).not.toContain("did:key");
    expect(words).not.toContain("z6Mk");
  });

  test("without an app name the app's grant says 'This app'", async () => {
    const h = await mountSection({ rows: [row("a", { group: "this-app" })], appLabel: null });
    const words = (await openConfirm(h)).textContent ?? "";
    expect(words).toContain("Revoke access for This app on this device?");
    expect(words).toContain("This app will stop working here until you sign in again.");
  });

  test("other groups keep the grantee's name and add no this-device line", async () => {
    const h = await mountSection({ rows: [row("a", { label: { text: "Research helper", source: "stub" } })] });
    const words = (await openConfirm(h)).textContent ?? "";
    expect(words).toContain("Revoke access for Research helper?");
    expect(words).not.toContain("on this device");
    expect(words).not.toContain("sign in again");
  });

  test("the receipt and the live line follow the same naming", async () => {
    const app = await mountSection({ rows: [row("a", { group: "this-app" })] });
    buttonIn(await openConfirm(app), "Revoke access")?.click();
    await flush();
    expect(panelText(app.receipts[0]?.bodyCode ?? "")).toBe("Fieldnotes can no longer read and list notes/ on this device.");
    expect(app.el.querySelector(".dl-live")?.textContent).toBe("Access revoked for Fieldnotes.");

    const other = await mountSection({ rows: [row("a", { label: { text: "Research helper", source: "stub" } })] });
    buttonIn(await openConfirm(other), "Revoke access")?.click();
    await flush();
    expect(panelText(other.receipts[0]?.bodyCode ?? "")).toBe("Research helper can no longer read and list notes/.");
  });

  test("Escape takes the safe action, calls nothing and returns focus to Revoke", async () => {
    const h = await mountSection({ rows: [row("a")] });
    const box = await openConfirm(h);
    const event = new (page as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    box.querySelector("button")?.dispatchEvent(event);
    await flush();
    expect(h.el.querySelector('[role="alertdialog"]')).toBeNull();
    expect(h.revoked).toEqual([]);
    expect(cards(h.el)).toHaveLength(1);
    expect(active()).toBe(buttonIn(h.el, "Revoke") ?? null);
  });

  test("Keep access closes the box without a call", async () => {
    const h = await mountSection({ rows: [row("a")] });
    const box = await openConfirm(h);
    buttonIn(box, "Keep access")?.click();
    await flush();
    expect(h.el.querySelector('[role="alertdialog"]')).toBeNull();
    expect(h.revoked).toEqual([]);
  });

  test("confirming revokes that CID once, shows busy, then removes the row, shows a CID receipt and re-reads", async () => {
    let finish: (outcome: RevokeOutcome) => void = () => undefined;
    const pending = new Promise<RevokeOutcome>((resolve) => {
      finish = resolve;
    });
    const h = await mountSection({
      rows: [row("bafyEXAMPLEcidcidcidk2dq"), row("b")],
      revoke: () => pending,
    });
    const box = await openConfirm(h);
    const go = buttonIn(box, "Revoke access");
    go?.click();
    go?.click();
    await flush();
    expect(h.revoked).toEqual(["bafyEXAMPLEcidcidcidk2dq"]);
    // Busy: the first card says so and no other Revoke is live.
    expect(h.el.textContent).toContain("Revoking…");
    const live = [...h.el.querySelectorAll<HTMLButtonElement>(".dl-acts .action")].filter((b) => b.textContent === "Revoke" && !b.hidden);
    expect(live.every((b) => b.disabled)).toBe(true);
    expect(h.receipts).toHaveLength(0);

    const readsBefore = h.reads.count;
    h.setPage({ state: "ready", data: { rows: [row("b")] } });
    finish({ ok: true, cid: "bafyEXAMPLEcidcidcidk2dq" });
    await flush();
    expect(cards(h.el)).toHaveLength(1);
    expect(h.reads.count).toBeGreaterThan(readsBefore);
    expect(h.receipts).toHaveLength(1);
    const slip = h.receipts[0];
    expect(slip?.rows[0]).toEqual({ labelCode: "delegations.receipt.cid", value: "bafyEXAMPL…k2dq" });
    expect(slip?.rows[1]?.labelCode).toBe("delegations.receipt.time");
    expect(slip?.rows[1]?.value).toMatch(/\d/);
    // The group count and the rail count follow: the node's list still holds the revoked row, the panel counts it gone.
    expect(h.el.querySelector(".dl-h")?.textContent).toContain("0");
    h.setPage({ state: "ready", data: { rows: [row("bafyEXAMPLEcidcidcidk2dq", { status: "revoked" }), row("b")] } });
    await h.refresh();
    expect(h.status()?.count).toBe("1");
  });


  test("NOT_FOUND reads like not-revocable: the grant is gone or ended, the list re-reads, no Try again", async () => {
    for (const code of ["NOT_FOUND", "not-revocable"]) {
      const h = await mountSection({ rows: [row("a")], revoke: async () => ({ ok: false, code }) });
      const box = await openConfirm(h);
      h.setPage({ state: "ready", data: { rows: [row("a", { status: "revoked" })] } });
      const readsBefore = h.reads.count;
      buttonIn(box, "Revoke access")?.click();
      await flush();
      expect(h.reads.count, code).toBeGreaterThan(readsBefore);
      expect(cards(h.el), code).toHaveLength(1);
      expect(h.receipts, code).toHaveLength(0);
      expect(h.el.textContent, code).toContain("had already ended");
      expect(h.el.querySelector(".dl-card .st")?.textContent, code).toBe("Revoked");
      expect(buttonIn(h.el, "Try again")?.hidden, code).toBe(true);
    }
  });

  test("NETWORK_ERROR and ABORTED say it could not be confirmed, re-read the list and offer Try again", async () => {
    for (const code of ["NETWORK_ERROR", "ABORTED"]) {
      const h = await mountSection({ rows: [row("a")], revoke: async () => ({ ok: false, code }) });
      const readsBefore = h.reads.count;
      buttonIn(await openConfirm(h), "Revoke access")?.click();
      await flush();
      const line = h.el.querySelector('[role="alert"]:not([hidden])')?.textContent ?? "";
      expect(line, code).toContain("couldn't confirm whether this worked");
      expect(line, code).not.toContain("Nothing was changed");
      expect(buttonIn(h.el, "Try again")?.hidden, code).toBe(false);
      expect(h.reads.count, code).toBeGreaterThan(readsBefore);
      expect(cards(h.el), code).toHaveLength(1);
    }
  });

  test("the re-read after an unconfirmed failure is shown truthfully: a grant that did end reads as ended, with no Try again", async () => {
    const h = await mountSection({ rows: [row("a")], revoke: async () => ({ ok: false, code: "NETWORK_ERROR" }) });
    const box = await openConfirm(h);
    // The request got through; only the answer was lost.
    h.setPage({ state: "ready", data: { rows: [row("a", { status: "revoked" })] } });
    buttonIn(box, "Revoke access")?.click();
    await flush();
    expect(h.el.querySelector(".dl-card .st")?.textContent).toBe("Revoked");
    expect(h.el.querySelector('[role="alert"]:not([hidden]) p')?.textContent).toBe("This access has ended.");
    expect(buttonIn(h.el, "Try again")?.hidden).toBe(true);
  });

  test("REVOCATION_FAILED and other codes are a plain failure with Try again, which asks again instead of revoking", async () => {
    const h = await mountSection({ rows: [row("a")], revoke: async () => ({ ok: false, code: "REVOCATION_FAILED" }) });
    const readsBefore = h.reads.count;
    buttonIn(await openConfirm(h), "Revoke access")?.click();
    await flush();
    expect(cards(h.el)).toHaveLength(1);
    expect(h.receipts).toHaveLength(0);
    expect(h.el.querySelector('[role="alert"]:not([hidden]) p')?.textContent).toBe("Couldn't revoke this access.");
    expect(h.reads.count).toBeGreaterThan(readsBefore);
    expect(h.revoked).toEqual(["a"]);

    buttonIn(h.el, "Try again")?.click();
    await flush();
    expect(h.el.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(h.revoked).toEqual(["a"]);
    expect(active()?.textContent).toBe("Keep access");
  });

  test("when the grant runs out while the box is open, activating Revoke access moves focus to the heading, not the page", async () => {
    // No re-read happens; the end time passes between the box opening and the click.
    const h = await mountSection({ rows: [row("a", { expiresAt: new Date(Date.now() + 60_000) })] });
    const box = await openConfirm(h);
    const realNow = Date.now;
    Date.now = () => realNow() + 120_000;
    try {
      buttonIn(box, "Revoke access")?.click();
      await flush();
    } finally {
      Date.now = realNow;
    }
    expect(h.revoked).toEqual([]);
    expect(h.el.textContent).toContain("had already ended");
    expect(active()).toBe(h.el.querySelector(".sec-title"));
  });

  test("when a re-read ends the row under an open box, focus moves to the card instead of falling to the page", async () => {
    const h = await mountSection({ rows: [row("a")] });
    await openConfirm(h);
    expect(active()?.textContent).toBe("Keep access");
    h.setPage({ state: "ready", data: { rows: [row("a", { status: "revoked" })] } });
    await h.refresh();
    await flush();
    expect(h.el.querySelector('[role="alertdialog"]')).toBeNull();
    expect(active()).toBe(cards(h.el)[0] ?? null);
  });

  test("a revoke that fails after the panel was closed still raises the neutral failure toast", async () => {
    let fail: (outcome: RevokeOutcome) => void = () => undefined;
    const held = new Promise<RevokeOutcome>((resolve) => {
      fail = resolve;
    });
    const h = await mountSection({ rows: [row("a")], revoke: () => held });
    buttonIn(await openConfirm(h), "Revoke access")?.click();
    await flush();
    h.unmount();
    fail({ ok: false, code: "REVOCATION_FAILED" });
    await flush();
    expect(h.toasts).toEqual(["delegations.err.failed"]);
    expect(h.receipts).toHaveLength(0);
  });

  test("a session that may not revoke gets a neutral line and no Try again", async () => {
    const h = await mountSection({ rows: [row("a")], revoke: async () => ({ ok: false, code: "PERMISSION_DENIED" }) });
    const box = await openConfirm(h);
    buttonIn(box, "Revoke access")?.click();
    await flush();
    expect(h.el.textContent).toContain("This session can't change this access");
    expect(buttonIn(h.el, "Try again")?.hidden).toBe(true);
    expect(cards(h.el)).toHaveLength(1);
  });

  test("a source that throws is unconfirmed, not a removal and not 'nothing changed'", async () => {
    const h = await mountSection({
      rows: [row("a")],
      revoke: async () => {
        throw new Error("boom");
      },
    });
    const readsBefore = h.reads.count;
    buttonIn(await openConfirm(h), "Revoke access")?.click();
    await flush();
    expect(cards(h.el)).toHaveLength(1);
    expect(h.el.textContent).toContain("couldn't confirm whether this worked");
    expect(h.el.textContent).not.toContain("Nothing was changed");
    expect(buttonIn(h.el, "Try again")?.hidden).toBe(false);
    expect(h.reads.count).toBeGreaterThan(readsBefore);
  });

  test("a row revoked elsewhere while the box is open closes the box and says it ended; nothing is called", async () => {
    const h = await mountSection({ rows: [row("a")] });
    await openConfirm(h);
    h.setPage({ state: "ready", data: { rows: [row("a", { status: "revoked" })] } });
    await h.refresh();
    await flush();
    expect(h.el.querySelector('[role="alertdialog"]')).toBeNull();
    expect(h.el.textContent).toContain("had already ended");
    expect(h.revoked).toEqual([]);
  });

  test("an ended row never offers Revoke, so there is nothing to confirm", async () => {
    const h = await mountSection({ rows: [row("a", { status: "expired", expiresAt: minutes(-10) })] });
    expect(buttonIn(h.el, "Revoke")?.hidden).toBe(true);
    expect(h.el.textContent).toContain("Nothing to revoke");
  });

  test("only active rows the user granted offer Revoke: a received grant is read-only, however active", async () => {
    const h = await mountSection({
      rows: [
        row("mine"),
        row("theirs", {
          group: "received",
          direction: "received",
          label: { text: "did:key:z6MkMe…MeMeMe", source: "derived" },
          delegatorDid: "did:key:z6MkGrantorGrantorGrantorGrantor",
          delegateDid: "did:key:z6MkMeMeMeMeMeMeMeMeMeMeMe",
        }),
        // A received direction is enough, whatever group the mapper gave it.
        row("odd", { direction: "received" }),
      ],
    });
    const [mine, theirs, odd] = cards(h.el);
    const revokeOf = (card: HTMLElement | undefined) => card?.querySelector<HTMLButtonElement>('[aria-label^="Revoke access for"]');
    expect(revokeOf(mine)?.hidden).toBe(false);
    expect(revokeOf(theirs)?.hidden).toBe(true);
    expect(revokeOf(odd)?.hidden).toBe(true);
    expect(theirs?.querySelector(".dl-kind")?.textContent).toBe("Shared with you by did:key:z6MkGr…rantor");
    expect(theirs?.querySelector(".st")?.textContent).toBe("Active");
    expect(theirs?.textContent).toContain("Only the one who shared it can end it");

    // Even a programmatic click on the hidden button opens nothing and calls nothing.
    revokeOf(theirs)?.click();
    revokeOf(odd)?.click();
    await flush();
    expect(h.el.querySelector('[role="alertdialog"]')).toBeNull();
    expect(h.revoked).toEqual([]);

    // The details drawer still works for it.
    theirs?.querySelector<HTMLButtonElement>('[aria-label^="See details"]')?.click();
    await flush();
    expect(h.el.querySelector(".drawer")?.textContent).toContain("Granted by");
  });

  test("when the slip is declined a plain toast confirms, unless toasts are off; the receipt is always offered", async () => {
    const declined = await mountSection({ rows: [row("a")], slip: false });
    buttonIn(await openConfirm(declined), "Revoke access")?.click();
    await flush();
    expect(declined.receipts).toHaveLength(1);
    expect(declined.toasts).toEqual(["delegations.receipt.title"]);

    const off = await mountSection({ rows: [row("a")], slip: false, toasts: false });
    buttonIn(await openConfirm(off), "Revoke access")?.click();
    await flush();
    expect(off.receipts).toHaveLength(1);
    expect(off.toasts).toEqual([]);
  });
});

describe("one revoke per CID across close and reopen", () => {
  const revokeButton = (scope: ParentNode, cid: string) => scope.querySelector<HTMLButtonElement>(`[aria-label="Revoke access for Helper ${cid}"]`);
  const busyShown = (scope: ParentNode) => [...scope.querySelectorAll<HTMLElement>('p[role="status"]')].some((p) => !p.hidden && p.textContent === "Revoking…");

  async function confirmRevoke(scope: HTMLElement, cid: string): Promise<void> {
    revokeButton(scope, cid)?.click();
    await flush();
    buttonIn(scope.querySelector<HTMLElement>('[role="alertdialog"]') ?? scope, "Revoke access")?.click();
    await flush();
  }

  /** A source whose revoke of "a" waits for the test; any other CID answers at once. */
  function held() {
    let settle: (outcome: RevokeOutcome) => void = () => undefined;
    const pending = new Promise<RevokeOutcome>((resolve) => {
      settle = resolve;
    });
    return { settle, revoke: (cid: string): Promise<RevokeOutcome> => (cid === "a" ? pending : Promise.resolve({ ok: true, cid })) };
  }

  test("a second mount cannot revoke the CID that is still in flight; the source is called exactly once", async () => {
    const gate = held();
    const h = await mountSection({ rows: [row("a"), row("b")], revoke: gate.revoke });
    await confirmRevoke(h.el, "a");
    expect(h.revoked).toEqual(["a"]);

    // Close the panel and open it again while the node has not answered.
    h.unmount();
    const again = await h.remount();
    expect(busyShown(again)).toBe(true);
    expect(revokeButton(again, "a")?.disabled).toBe(true);
    expect(revokeButton(again, "b")?.disabled).toBe(true);

    // Not just a disabled attribute: forcing the button and the confirm still reaches nothing.
    for (const cid of ["a", "b"]) {
      const button = revokeButton(again, cid);
      if (button === null || button === undefined) throw new Error(`no revoke button for ${cid}`);
      button.disabled = false;
      button.click();
    }
    await flush();
    expect(again.querySelector('[role="alertdialog"]')).toBeNull();
    expect(h.revoked).toEqual(["a"]);

    gate.settle({ ok: true, cid: "a" });
    await flush();
    expect(h.revoked).toEqual(["a"]);
    expect(h.receipts).toHaveLength(1);
  });

  test("once the first request settles the latch clears: another CID can be revoked from the new mount", async () => {
    const gate = held();
    const h = await mountSection({ rows: [row("a"), row("b")], revoke: gate.revoke });
    await confirmRevoke(h.el, "a");
    h.unmount();
    const again = await h.remount();
    h.setPage({ state: "ready", data: { rows: [row("a", { status: "revoked" }), row("b")] } });
    gate.settle({ ok: true, cid: "a" });
    await flush();
    expect(revokeButton(again, "b")?.disabled).toBe(false);
    await confirmRevoke(again, "b");
    expect(h.revoked).toEqual(["a", "b"]);
  });

  test("after a failure the same CID can be tried again from the new mount", async () => {
    const gate = held();
    const h = await mountSection({ rows: [row("a"), row("b")], revoke: gate.revoke });
    await confirmRevoke(h.el, "a");
    h.unmount();
    const again = await h.remount();
    gate.settle({ ok: false, code: "REVOCATION_FAILED" });
    await flush();
    expect(h.toasts).toEqual(["delegations.err.failed"]);
    const button = revokeButton(again, "a");
    expect(button?.disabled).toBe(false);
    expect(busyShown(again)).toBe(false);
    button?.click();
    await flush();
    expect(again.querySelector('[role="alertdialog"]')).not.toBeNull();
  });
});

describe("details", () => {
  test("See details opens a drawer with both identities, the delegation ID, the resources and dates, and Close returns focus", async () => {
    const h = await mountSection({
      rows: [
        row("a", {
          parents: ["bafyParent1", "bafyParent2"],
          resources: [
            { resource: "tinycloud:pkh:eip155:1:0x1234567890abcdef1234567890abcdef12345678:default/kv/notes/", actions: ["tinycloud.kv/get", "weird/thing"] },
          ],
        }),
      ],
    });
    const see = buttonIn(h.el, "See details");
    see?.click();
    await flush();
    const drawer = h.el.querySelector<HTMLElement>(".drawer");
    expect(drawer).not.toBeNull();
    const words = drawer?.textContent ?? "";
    expect(words).toContain("did:key:z6MkOw…rOwner");
    expect(words).toContain("Granted by");
    expect(words).toContain("Granted to");
    expect(words).toContain("2 earlier delegations");
    expect(words).toContain("notes/");
    expect(words).toContain("weird/thing");
    expect(words).toContain("Issued");
    expect(words).toContain("Expires");
    // Full identities are what the copy buttons carry; the page shows the short form.
    expect(words).not.toContain("did:key:z6MkOwnerOwnerOwnerOwnerOwner");
    expect([...(drawer?.querySelectorAll("button") ?? [])].filter((b) => b.getAttribute("aria-label")?.startsWith("Copy")).length).toBe(3);

    buttonIn(drawer as HTMLElement, "Close")?.click();
    await flush();
    expect(h.el.querySelector(".drawer")).toBeNull();
    expect(active()).toBe(see ?? null);
  });

  test("a revoked row's drawer says when, by whom and through what", async () => {
    const h = await mountSection({
      rows: [
        row("a", {
          status: "ancestor_revoked",
          revokedAt: minutes(-30),
          revokedBy: "did:key:z6MkRevokerRevokerRevokerRevoker",
          revokedAncestorCid: "bafyAncestorAncestorAncestor",
        }),
      ],
    });
    buttonIn(h.el, "See details")?.click();
    await flush();
    const words = h.el.querySelector(".drawer")?.textContent ?? "";
    expect(words).toContain("Revoked by");
    expect(words).toContain("Revoked through");
  });
});
