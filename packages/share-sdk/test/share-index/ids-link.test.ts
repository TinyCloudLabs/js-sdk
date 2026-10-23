import { describe, expect, test } from "bun:test";
import { agentIdFromDid, classifyRecordKey, isShareId, rejectedKeyEntry } from "../../src/share-index/ids.js";
import { validateShareLink } from "../../src/share-index/link.js";
import { displayName } from "../../src/share-index/schema.js";

const A = "AbCdEfGhIjKlMnOpQrStUv";

describe("isShareId and agent ids (§1)", () => {
  test("share ids: 1-512 base64url characters, never a reserved first segment", () => {
    expect(isShareId("abc_DEF-123")).toBe(true);
    expect(isShareId("x".repeat(512))).toBe(true);
    for (const value of ["", "x".repeat(513), "_index", "agents", "a/b", "a.b", "a%2F", "../x", " a"]) expect(isShareId(value)).toBe(false);
  });

  test("agent ids are 22 base64url characters derived from the bare DID", () => {
    const id = agentIdFromDid("did:key:z6MkExample");
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(agentIdFromDid("did:key:z6MkExample")).toBe(id);
    expect(agentIdFromDid("did:key:z6MkOther")).not.toBe(id);
    expect(() => agentIdFromDid("did:key:z6MkExample#z6MkExample")).toThrow();
  });
});

describe("key classifier (§1, test 5 keys)", () => {
  test("index documents, web records and agent records", () => {
    expect(classifyRecordKey("_index/main")).toEqual({ kind: "index", name: "main" });
    expect(classifyRecordKey("_index/archive-2026")).toEqual({ kind: "index", name: "archive-2026" });
    expect(classifyRecordKey("share1")).toEqual({ kind: "web", shareId: "share1" });
    expect(classifyRecordKey(`agents/${A}/s1`)).toEqual({ kind: "agent", agentId: A, shareId: "s1" });
  });

  test("unsafe shapes are rejected first, and counted against the agent whose prefix holds them", () => {
    for (const suffix of ["..%2F..%2F_index/main", "/vault/x", "./x", "../x", "a\\b", "x//y", "deep/x", "_index"]) {
      expect(classifyRecordKey(`agents/${A}/${suffix}`)).toEqual({ kind: "rejected", agentId: A, suffix });
    }
    expect(classifyRecordKey(`agents/${A}/${"z".repeat(100)}%`)).toEqual({ kind: "rejected", agentId: A, suffix: `${"z".repeat(100)}%` });
  });

  test("rejected-key entries are short hashes, never the agent-chosen text", () => {
    const entry = rejectedKeyEntry("\u202Eevil-name-from-an-agent");
    expect(entry).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(rejectedKeyEntry("\u202Eevil-name-from-an-agent")).toBe(entry);
    expect(rejectedKeyEntry("other")).not.toBe(entry);
  });

  test("other odd keys are skipped without being attributed to anyone", () => {
    for (const key of ["/share1", "share%2F1", "_index/other", "_index/main/x", "agents/a10/s5", "agents/", "agents", "_index", "a//b", "x/y"]) {
      expect(classifyRecordKey(key)).toEqual({ kind: "rejected" });
    }
  });
});

describe("link validator (§5 check 6)", () => {
  const origins = ["https://share.test"];
  const SHARE_ID = "lqdw5iopqq2tkkvjj6gbbi5vbv";
  const SHORT = `https://share.test/s/${SHARE_ID}#v=4&k=${"A".repeat(43)}&c=bafkreiewixmt5nwgi3ych6durcsheaql3ybswbplpjmpbdhfkvdkidzt5u`;
  const FULL = `https://share.test/s/full#v=4&k=${"A".repeat(43)}&r=eyJhIjoxfQ`;
  test("accepts the share link shapes on a configured origin", () => {
    expect(validateShareLink("https://share.test/viewer#tc1=opaque", origins)).toEqual({ ok: true, shape: "native" });
    expect(validateShareLink(SHORT, origins)).toEqual({ ok: true, shape: "link" });
    expect(validateShareLink(FULL, origins)).toEqual({ ok: true, shape: "link" });
    expect(validateShareLink(`https://share.test/s/bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku#k=${"A".repeat(43)}`, origins)).toEqual({ ok: true, shape: "envelope" });
  });

  test("refuses other origins, schemes, query strings, userinfo and other shapes", () => {
    for (const link of [
      "https://evil.test/viewer#tc1=opaque", "http://share.test/viewer#tc1=opaque", "javascript:alert(1)", "https://share.test/viewer?x=1#tc1=a",
      "https://u:p@share.test/viewer#tc1=a", "https://share.test/viewer#tc1=a&x=b", "https://share.test/other#tc1=a", "https://share.test/s/inline#v=2&p=YWJj",
      `${SHORT}`.replace("#v=4", "#v=3"), SHORT.replace("/s/", "/c/"), SHORT.replace("&c=", "&x="), `${SHORT}&y=1`, SHORT.replace(SHARE_ID, SHARE_ID.slice(1)), `${FULL}=`,
      "https://share.test/s/notacid#k=abc", "https://share.test/viewer#tc1=a\n", 42,
    ]) expect(validateShareLink(link, origins).ok).toBe(false);
  });

  test("refuses fragment version 1 on every link path, as it refuses versions 2 and 3", () => {
    for (const link of [
      "https://share.test/s/inline#v=1&p=a",
      SHORT.replace("#v=4", "#v=1"),
      FULL.replace("#v=4", "#v=1"),
      SHORT.replace("#v=4", "#v=2"),
      FULL.replace("#v=4", "#v=3"),
    ]) expect(validateShareLink(link, origins).ok).toBe(false);
    expect(validateShareLink(SHORT, origins).ok).toBe(true);
    expect(validateShareLink(FULL, origins).ok).toBe(true);
  });
});

describe("display names (§2)", () => {
  test("strip bidi and control characters and cap at 120 code points", () => {
    expect(displayName("in\u202Egnp.exe\u0007", "x")).toBe("ingnp.exe");
    expect([...displayName("é".repeat(200), "x")].length).toBe(120);
    expect(displayName("\u200F", "fallback")).toBe("fallback");
  });
});
