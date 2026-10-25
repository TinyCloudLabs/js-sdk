/**
 * The eager front for the permission and space-creation dialogs (src/notifications/lazy-prompts.ts).
 * The dialog chunk is replaced by a stub module, so these tests cover the seam only: when the chunk loads,
 * what a prompt does while it loads, and that a prompt whose dialog cannot load is declined, never approved.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createLazyPrompts } from "../../src/notifications/lazy-prompts";
import { MODALS_KEY, type LoadedModals } from "../../src/notifications/modals-registry";
import { createPromptScope, dismissPrompts, prompts } from "../../src/ui/parts/prompts";

const registry = globalThis as Record<symbol, unknown>;

const permissionOptions = (onDismiss?: () => void) => ({ appName: "App", additional: [], onDismiss }) as never;
const spaceOptions = (onDismiss?: () => void) => ({ onCreateSpace: async () => undefined, onDismiss }) as never;

let errors: unknown[][];
let restoreConsole: () => void;
let calls: string[];
const fakeModals = (): LoadedModals => ({
  showPermissionRequestModal: (options) => {
    calls.push(`permission:${(options as { appName: string }).appName}`);
    return Promise.resolve({ approved: true });
  },
  showSpaceCreationModal: () => {
    calls.push("space");
    return Promise.resolve({ success: true });
  },
  closeActiveModal: () => {
    calls.push("close");
  },
});

beforeEach(() => {
  delete registry[MODALS_KEY];
  errors = [];
  calls = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
  restoreConsole = () => spy.mockRestore();
});

afterEach(() => {
  restoreConsole();
  delete registry[MODALS_KEY];
});

/** A chunk loader that registers the fake dialogs, like the real chunk does when it runs. */
function loader(): { load: () => Promise<unknown>; loads: () => number } {
  let loads = 0;
  return {
    load: async () => {
      loads += 1;
      registry[MODALS_KEY] = fakeModals();
    },
    loads: () => loads,
  };
}

describe("lazy dialog front", () => {
  test("the first prompt loads the dialog chunk once and shows through it; later prompts need no load", async () => {
    const chunk = loader();
    const front = createLazyPrompts(chunk.load);

    const first = front.showPermissionRequestModal(permissionOptions());
    expect(calls).toEqual([]);
    expect(await first).toEqual({ approved: true });
    expect(calls).toEqual(["permission:App"]);

    // Loaded now: the next prompt is shown in the same tick, with no second load.
    const second = front.showPermissionRequestModal(permissionOptions());
    expect(calls).toEqual(["permission:App", "permission:App"]);
    await second;
    expect(chunk.loads()).toBe(1);
  });

  test("prompts raised while the chunk loads are shown in the order they were raised, from one load", async () => {
    const chunk = loader();
    const front = createLazyPrompts(chunk.load);
    const results = await Promise.all([
      front.showPermissionRequestModal({ appName: "one", additional: [] } as never),
      front.showSpaceCreationModal(spaceOptions()),
      front.showPermissionRequestModal({ appName: "three", additional: [] } as never),
    ]);
    expect(calls).toEqual(["permission:one", "space", "permission:three"]);
    expect(results).toEqual([{ approved: true }, { success: true }, { approved: true }]);
    expect(chunk.loads()).toBe(1);
  });

  test("a permission prompt whose dialog fails to load is declined, calls onDismiss once and logs one console error", async () => {
    const front = createLazyPrompts(() => Promise.reject(new Error("chunk load failed")));
    let dismissed = 0;
    const result = await front.showPermissionRequestModal(permissionOptions(() => (dismissed += 1)));
    expect(result).toEqual({ approved: false });
    expect(dismissed).toBe(1);
    expect(errors).toHaveLength(1);
    expect(String(errors[0]?.[0])).toContain("declined");
  });

  test("a space-creation prompt whose dialog fails to load is dismissed, calls onDismiss once and logs one console error", async () => {
    const front = createLazyPrompts(() => Promise.reject(new Error("chunk load failed")));
    let dismissed = 0;
    const result = await front.showSpaceCreationModal(spaceOptions(() => (dismissed += 1)));
    expect(result).toEqual({ success: false, dismissed: true });
    expect(dismissed).toBe(1);
    expect(errors).toHaveLength(1);
  });

  test("every prompt waiting on a failed load is declined, and the next prompt tries the load again", async () => {
    let attempts = 0;
    const front = createLazyPrompts(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      registry[MODALS_KEY] = fakeModals();
    });
    const both = await Promise.all([
      front.showPermissionRequestModal(permissionOptions()),
      front.showSpaceCreationModal(spaceOptions()),
    ]);
    expect(both).toEqual([{ approved: false }, { success: false, dismissed: true }]);
    expect(errors).toHaveLength(2);
    expect(calls).toEqual([]);

    expect(await front.showPermissionRequestModal(permissionOptions())).toEqual({ approved: true });
    expect(attempts).toBe(2);
  });

  test("a chunk that loads but never registers its dialogs counts as a failed load: declined, not approved", async () => {
    const front = createLazyPrompts(async () => undefined);
    expect(await front.showPermissionRequestModal(permissionOptions())).toEqual({ approved: false });
    expect(errors).toHaveLength(1);
  });

  test("closeActiveModal withdraws a prompt still waiting for its chunk, and the dialog never opens when the chunk arrives", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const front = createLazyPrompts(async () => {
      await gate;
      registry[MODALS_KEY] = fakeModals();
    });
    let dismissed = 0;
    const pending = front.showSpaceCreationModal(spaceOptions(() => (dismissed += 1)));
    front.closeActiveModal();
    expect(await pending).toEqual({ success: false, dismissed: true });
    expect(dismissed).toBe(1);

    release();
    await new Promise((done) => setTimeout(done, 10));
    expect(calls).toEqual([]);
  });

  test("closeActiveModal reaches the loaded dialogs", () => {
    registry[MODALS_KEY] = fakeModals();
    createLazyPrompts(async () => undefined).closeActiveModal();
    expect(calls).toEqual(["close"]);
  });
});

/** A loader that waits for `release()` before the dialogs register, like a chunk still in flight. */
function heldLoader(): { load: () => Promise<unknown>; release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  return {
    load: async () => {
      await gate;
      registry[MODALS_KEY] = fakeModals();
    },
    release,
  };
}

const settle = () => new Promise((done) => setTimeout(done, 10));

describe("a prompt waiting for the dialog chunk and the account", () => {
  test("a reset declines a waiting permission prompt at once; no dialog is shown when the chunk arrives", async () => {
    const chunk = heldLoader();
    const front = createLazyPrompts(chunk.load);
    const scope = createPromptScope(true);
    let dismissed = 0;
    const pending = front.showPermissionRequestModal({ appName: "A", additional: [], onDismiss: () => (dismissed += 1) } as never, scope);

    dismissPrompts(scope);
    // Settled by the reset itself, before the chunk is released.
    expect(await pending).toEqual({ approved: false });
    expect(dismissed).toBe(1);

    chunk.release();
    await settle();
    expect(calls).toEqual([]);
  });

  test("a reset declines a waiting space-creation prompt the same way", async () => {
    const chunk = heldLoader();
    const front = createLazyPrompts(chunk.load);
    const scope = createPromptScope(true);
    let dismissed = 0;
    const pending = front.showSpaceCreationModal(spaceOptions(() => (dismissed += 1)), scope);

    dismissPrompts(scope);
    expect(await pending).toEqual({ success: false, dismissed: true });
    expect(dismissed).toBe(1);

    chunk.release();
    await settle();
    expect(calls).toEqual([]);
  });

  test("an account change resets only that account's prompts: the other client's waiting prompt still shows", async () => {
    const chunk = heldLoader();
    const front = createLazyPrompts(chunk.load);
    const accountA = createPromptScope(true);
    const accountB = createPromptScope(true);
    const first = front.showPermissionRequestModal({ appName: "A", additional: [] } as never, accountA);
    const second = front.showPermissionRequestModal({ appName: "B", additional: [] } as never, accountB);

    dismissPrompts(accountA);
    expect(await first).toEqual({ approved: false });

    chunk.release();
    expect(await second).toEqual({ approved: true });
    // Only account B's request reached a dialog.
    expect(calls).toEqual(["permission:B"]);
  });

  test("the host's teardown declines every waiting prompt, including one raised without a client scope", async () => {
    const chunk = heldLoader();
    const front = createLazyPrompts(chunk.load);
    const stop = prompts.start({} as never, {} as never);
    const scoped = front.showPermissionRequestModal({ appName: "A", additional: [] } as never, createPromptScope(true));
    const unscoped = front.showSpaceCreationModal(spaceOptions());

    stop();
    expect(await scoped).toEqual({ approved: false });
    expect(await unscoped).toEqual({ success: false, dismissed: true });

    chunk.release();
    await settle();
    expect(calls).toEqual([]);
  });

  test("a prompt that was dismissed is gone from the registry: a later reset does not call onDismiss again", async () => {
    const chunk = heldLoader();
    const front = createLazyPrompts(chunk.load);
    const scope = createPromptScope(true);
    let dismissed = 0;
    const pending = front.showPermissionRequestModal({ appName: "A", additional: [], onDismiss: () => (dismissed += 1) } as never, scope);
    chunk.release();
    await pending;
    dismissPrompts(scope);
    expect(dismissed).toBe(0);
  });
});

describe("closeActiveModal only withdraws space-creation prompts that are waiting", () => {
  test("the space-creation timeout does not decline an unrelated permission prompt waiting for the chunk", async () => {
    const chunk = heldLoader();
    const front = createLazyPrompts(chunk.load);
    const permission = front.showPermissionRequestModal({ appName: "keep", additional: [] } as never);
    const space = front.showSpaceCreationModal(spaceOptions());

    front.closeActiveModal();
    expect(await space).toEqual({ success: false, dismissed: true });

    chunk.release();
    expect(await permission).toEqual({ approved: true });
    expect(calls).toEqual(["permission:keep"]);
  });
});
