import { describe, expect, test } from "bun:test";

import { afterAuthority, reduceStorage } from "../../src/ui/storage-state";

const ok = (value: unknown) => ({ signedIn: true as const, result: { ok: true as const, value } });
const fail = (code: string) => ({ signedIn: true as const, result: { ok: false as const, code } });

describe("reduceStorage", () => {
  test("signed out hides the section regardless of any read", () => {
    expect(reduceStorage({ signedIn: false })).toEqual({ kind: "signed_out" });
  });

  test("no result yet is loading", () => {
    expect(reduceStorage({ signedIn: true })).toEqual({ kind: "loading" });
  });

  test("known limit shows the space numbers and the derived state", () => {
    const view = reduceStorage(
      ok({ usedBytes: 50, limitBytes: 100, state: "ok", manageUrl: "https://a.example/m" }),
    );
    expect(view).toEqual({ kind: "known", usedBytes: 50, limitBytes: 100, state: "ok" });
  });

  test("account totals take precedence over the space numbers", () => {
    const view = reduceStorage(
      ok({
        usedBytes: 1,
        limitBytes: 10,
        account: { usedBytes: 95, limitBytes: 100 },
        state: "nearly_full",
        manageUrl: "https://a.example/m",
      }),
    );
    expect(view).toEqual({ kind: "known", usedBytes: 95, limitBytes: 100, state: "nearly_full" });
  });

  test("full state is reported as full when a limit is known", () => {
    const view = reduceStorage(ok({ usedBytes: 100, limitBytes: 100, state: "full" }));
    expect(view).toEqual({ kind: "known", usedBytes: 100, limitBytes: 100, state: "full" });
  });

  test("a null limit is unlimited and never full, even if the body says full", () => {
    const view = reduceStorage(ok({ usedBytes: 7, limitBytes: null, state: "full" }));
    expect(view).toEqual({ kind: "unlimited", usedBytes: 7 });
  });

  test("account totals decide unlimited even when the space has a limit", () => {
    const view = reduceStorage(
      ok({ usedBytes: 1, limitBytes: 10, account: { usedBytes: 9, limitBytes: null }, state: "ok" }),
    );
    expect(view).toEqual({ kind: "unlimited", usedBytes: 9 });
  });

  test("permission denial asks for permission rather than showing a number", () => {
    expect(reduceStorage(fail("PERMISSION_DENIED"))).toEqual({ kind: "needs_permission" });
  });

  test("unsupported node or unavailable usage read is unavailable", () => {
    expect(reduceStorage(fail("unsupported"))).toEqual({ kind: "unavailable" });
    expect(reduceStorage(fail("STORAGE_STATUS_UNAVAILABLE"))).toEqual({ kind: "unavailable" });
  });

  test("malformed bodies are unavailable, never a 0 or a full bar", () => {
    const malformed: unknown[] = [
      null,
      "42",
      {},
      { usedBytes: -1, limitBytes: 10, state: "ok" },
      { usedBytes: 1.5, limitBytes: 10, state: "ok" },
      { usedBytes: "3", limitBytes: 10, state: "ok" },
      { usedBytes: 3, limitBytes: -10, state: "ok" },
      { usedBytes: 3, limitBytes: 10 },
      { usedBytes: 3, limitBytes: 10, state: "bogus" },
      { usedBytes: 3, limitBytes: 10, state: "ok", account: { usedBytes: -1, limitBytes: 100 } },
      { usedBytes: 3, limitBytes: 10, state: "ok", account: null },
    ];
    for (const value of malformed) {
      expect(reduceStorage(ok(value))).toEqual({ kind: "unavailable" });
    }
  });

  test("network and auth failures are errors that keep their code", () => {
    expect(reduceStorage(fail("NETWORK_ERROR"))).toEqual({ kind: "error", code: "NETWORK_ERROR" });
    expect(reduceStorage(fail("AUTH_UNAUTHORIZED"))).toEqual({
      kind: "error",
      code: "AUTH_UNAUTHORIZED",
    });
  });

  test("only known and unlimited carry numbers", () => {
    const reads = [
      { signedIn: false as const },
      { signedIn: true as const },
      fail("PERMISSION_DENIED"),
      fail("unsupported"),
      fail("NETWORK_ERROR"),
      ok(null),
    ];
    for (const read of reads) {
      const view = reduceStorage(read);
      expect("usedBytes" in view).toBe(false);
      expect("limitBytes" in view).toBe(false);
    }
  });
});

describe("afterAuthority", () => {
  test("approval refetches", () => {
    expect(afterAuthority({ approved: true })).toEqual({ kind: "loading" });
  });

  test("refusal settles on declined", () => {
    expect(afterAuthority({ approved: false })).toEqual({ kind: "declined" });
  });

  test("an unsupported refusal is unavailable, not a user decline", () => {
    expect(afterAuthority({ approved: false, code: "unsupported" })).toEqual({
      kind: "unavailable",
    });
  });

  test("a failed authority keeps its code so the panel can offer Retry", () => {
    expect(afterAuthority({ approved: false, code: "failed" })).toEqual({
      kind: "error",
      code: "failed",
    });
  });
});
