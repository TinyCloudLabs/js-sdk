import { expect, test } from "bun:test";
import {
  readRegistryPublishDismissed,
  writeRegistryPublishDismissed,
  dismissedStorageKey,
  type DismissedFlagStorage,
} from "./registry-publish-dismissed";

function makeMemoryStorage(initial: Record<string, string> = {}): { store: DismissedFlagStorage; raw: Map<string, string> } {
  const raw = new Map<string, string>(Object.entries(initial));
  const store: DismissedFlagStorage = {
    getItem(key) { return raw.has(key) ? raw.get(key)! : null; },
    setItem(key, value) { raw.set(key, value); },
    removeItem(key) { raw.delete(key); },
  };
  return { store, raw };
}

const SUBJECT_A = "did:pkh:eip155:1:0xAaAaaaAAaaAAaaaAAaaAAaaAAAaaAAaaAAaaAA00";
const SUBJECT_B = "did:pkh:eip155:1:0xBbBBBbbbbBbBBbBbbBBbBBbBBBBbBBBBbbbbbbB1";

test("key format is lowercased per owner (Bobbie 14:20:15Z: account B never inherits A's 'Not now')", () => {
  const keyA = dismissedStorageKey(SUBJECT_A);
  const keyB = dismissedStorageKey(SUBJECT_B);
  expect(keyA).toBe(`tcw.tc3547.dismissed.${SUBJECT_A.toLowerCase()}`);
  expect(keyB).toBe(`tcw.tc3547.dismissed.${SUBJECT_B.toLowerCase()}`);
  expect(keyA).not.toBe(keyB);
  // Case-variant copy of the same owner collapses to the same key.
  expect(dismissedStorageKey(SUBJECT_A.toUpperCase())).toBe(keyA);
});

test("fresh storage reports not dismissed; write+read round-trips true", () => {
  const { store } = makeMemoryStorage();
  expect(readRegistryPublishDismissed(SUBJECT_A, store)).toBe(false);
  writeRegistryPublishDismissed(SUBJECT_A, store);
  expect(readRegistryPublishDismissed(SUBJECT_A, store)).toBe(true);
});

test("account isolation (Bobbie): A's flag does not suppress B", () => {
  const { store, raw } = makeMemoryStorage();
  writeRegistryPublishDismissed(SUBJECT_A, store);
  expect(readRegistryPublishDismissed(SUBJECT_A, store)).toBe(true);
  expect(readRegistryPublishDismissed(SUBJECT_B, store)).toBe(false);
  // We wrote exactly one key, under A's owner, and nothing else in the store.
  expect(raw.size).toBe(1);
  expect(Array.from(raw.keys())).toEqual([dismissedStorageKey(SUBJECT_A)]);
});

test("the write touches only its own key (Bobbie: clearing nothing else)", () => {
  const unrelated = { "tinychat.session": "something", "other.flag": "value" };
  const { store, raw } = makeMemoryStorage(unrelated);
  writeRegistryPublishDismissed(SUBJECT_A, store);
  expect(raw.get("tinychat.session")).toBe("something");
  expect(raw.get("other.flag")).toBe("value");
  expect(raw.get(dismissedStorageKey(SUBJECT_A))).toBeDefined();
  expect(raw.size).toBe(3);
});

test("fail-open on missing storage: no globalThis.localStorage → not dismissed, no throw", () => {
  expect(readRegistryPublishDismissed(SUBJECT_A, undefined)).toBe(false);
  writeRegistryPublishDismissed(SUBJECT_A, undefined); // must not throw
});

test("fail-open on read errors: storage.getItem throws → not dismissed (Bobbie: ask on read errors)", () => {
  const broken: DismissedFlagStorage = {
    getItem() { throw new Error("SecurityError: cross-origin"); },
    setItem() {},
  };
  expect(readRegistryPublishDismissed(SUBJECT_A, broken)).toBe(false);
});

test("fail-open on unparseable values (Bobbie: ask on unparseable values)", () => {
  const { store } = makeMemoryStorage({ [dismissedStorageKey(SUBJECT_A)]: "not-json" });
  expect(readRegistryPublishDismissed(SUBJECT_A, store)).toBe(false);
});

test("fail-open on wrongly-shaped value: valid JSON but no `dismissed:true`", () => {
  const { store } = makeMemoryStorage({ [dismissedStorageKey(SUBJECT_A)]: JSON.stringify({ at: "2026-11-21T00:00:00Z" }) });
  expect(readRegistryPublishDismissed(SUBJECT_A, store)).toBe(false);
});

test("fail-silent on write errors: setItem throws (quota/SecurityError) → no throw escapes", () => {
  const broken: DismissedFlagStorage = {
    getItem() { return null; },
    setItem() { throw new Error("QuotaExceededError"); },
  };
  writeRegistryPublishDismissed(SUBJECT_A, broken); // must not throw
  // A follow-up read on broken storage still returns not-dismissed, so the host prompts again next time.
  expect(readRegistryPublishDismissed(SUBJECT_A, broken)).toBe(false);
});
