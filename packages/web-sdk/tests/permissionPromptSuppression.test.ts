import { describe, expect, test } from "bun:test";

import type { Manifest } from "@tinycloud/sdk-core";

import {
  isPermissionPromptSuppressed,
  suppressPermissionPromptFor30Days,
} from "../src/modules/permissionPromptSuppression";

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.items.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

class ThrowingStorage extends MemoryStorage {
  getItem(_key: string): string | null {
    throw new Error("storage unavailable");
  }

  setItem(_key: string, _value: string): void {
    throw new Error("storage unavailable");
  }
}

const manifest: Manifest = {
  app_id: "com.test.app",
  name: "Test App",
};

describe("permission prompt suppression", () => {
  test("remembers suppression for the same page and app", () => {
    const storage = new MemoryStorage();

    suppressPermissionPromptFor30Days(manifest, {
      storage,
      now: () => 1_000,
      pageScope: "https://example.com/app",
    });

    expect(
      isPermissionPromptSuppressed(manifest, {
        storage,
        now: () => 2_000,
        pageScope: "https://example.com/app",
      }),
    ).toBe(true);
  });

  test("does not carry suppression to a different page", () => {
    const storage = new MemoryStorage();

    suppressPermissionPromptFor30Days(manifest, {
      storage,
      now: () => 1_000,
      pageScope: "https://example.com/app",
    });

    expect(
      isPermissionPromptSuppressed(manifest, {
        storage,
        now: () => 2_000,
        pageScope: "https://example.com/other",
      }),
    ).toBe(false);
  });

  test("expires and removes old suppression records", () => {
    const storage = new MemoryStorage();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

    suppressPermissionPromptFor30Days(manifest, {
      storage,
      now: () => 1_000,
      pageScope: "https://example.com/app",
    });

    expect(
      isPermissionPromptSuppressed(manifest, {
        storage,
        now: () => 1_000 + thirtyDaysMs + 1,
        pageScope: "https://example.com/app",
      }),
    ).toBe(false);
    expect(storage.length).toBe(0);
  });

  test("falls back to showing the prompt when storage is unavailable", () => {
    expect(
      isPermissionPromptSuppressed(manifest, {
        storage: new ThrowingStorage(),
        pageScope: "https://example.com/app",
      }),
    ).toBe(false);
    expect(() =>
      suppressPermissionPromptFor30Days(manifest, {
        storage: new ThrowingStorage(),
        pageScope: "https://example.com/app",
      }),
    ).not.toThrow();
  });
});
