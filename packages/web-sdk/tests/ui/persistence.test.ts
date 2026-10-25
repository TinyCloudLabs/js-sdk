import { describe, expect, test } from "bun:test";

import {
  FALLBACK_APP_ID,
  HIDE_KEY_PREFIX,
  createButtonHideStore,
  hideStorageKey,
  resolveUiAppId,
} from "../../src/ui/persistence";

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.has(key) ? (this.items.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

const scope = { origin: "https://app.example", appId: "com.example.app" };

describe("hide key", () => {
  test("encodes origin and appId and uses the versioned prefix", () => {
    expect(hideStorageKey({ origin: "https://a.example:8443", appId: "x/y" })).toBe(
      `${HIDE_KEY_PREFIX}https%3A%2F%2Fa.example%3A8443:x%2Fy`,
    );
  });

  test("has no pathname component", () => {
    expect(hideStorageKey(scope)).not.toContain("/path");
  });
});

describe("resolveUiAppId", () => {
  test("configured appId wins over the manifest", () => {
    expect(resolveUiAppId("configured", "manifest")).toBe("configured");
  });

  test("manifest app_id is used when no configured appId", () => {
    expect(resolveUiAppId(undefined, "manifest")).toBe("manifest");
  });

  test("blank values fall through to the origin-wide constant", () => {
    expect(resolveUiAppId("  ", "")).toBe(FALLBACK_APP_ID);
    expect(resolveUiAppId(undefined, undefined)).toBe("_page");
  });
});

describe("createButtonHideStore", () => {
  test("absent key reads as visible", () => {
    const store = createButtonHideStore(() => new MemoryStorage() as unknown as Storage);
    expect(store.read(scope)).toBe(false);
  });

  test("hide survives a new store on the same storage (reload)", () => {
    const storage = new MemoryStorage();
    const first = createButtonHideStore(() => storage as unknown as Storage);
    first.write(scope, true);

    const reloaded = createButtonHideStore(() => storage as unknown as Storage);
    expect(reloaded.read(scope)).toBe(true);
  });

  test("showing again removes the stored flag", () => {
    const storage = new MemoryStorage();
    const store = createButtonHideStore(() => storage as unknown as Storage);
    store.write(scope, true);
    store.write(scope, false);
    expect(storage.items.size).toBe(0);
    expect(store.read(scope)).toBe(false);
  });

  test("scope is per origin and per appId", () => {
    const storage = new MemoryStorage();
    const store = createButtonHideStore(() => storage as unknown as Storage);
    store.write(scope, true);
    expect(store.read({ ...scope, origin: "https://other.example" })).toBe(false);
    expect(store.read({ ...scope, appId: "_page" })).toBe(false);
  });

  test("blocked storage keeps the flag for the page only", () => {
    const store = createButtonHideStore(() => {
      throw new Error("SecurityError");
    });
    store.write(scope, true);
    expect(store.read(scope)).toBe(true);
    store.write(scope, false);
    expect(store.read(scope)).toBe(false);
  });

  test("no storage at all keeps the flag for the page only", () => {
    const store = createButtonHideStore(() => undefined);
    store.write(scope, true);
    expect(store.read(scope)).toBe(true);
  });

  test("a throwing setItem still applies the in-memory flag", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };
    const store = createButtonHideStore(() => storage as unknown as Storage);
    store.write(scope, true);
    expect(store.read(scope)).toBe(true);
  });
});
