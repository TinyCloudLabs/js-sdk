import { describe, expect, test } from "bun:test";
import { assertRequestWindow, DEFAULT_REQUEST_WINDOW_MS, parseRequestExpires } from "./request-expires.js";

const OWNER = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";
const unpinned = { pinnedOwner: undefined };
const pinned = { pinnedOwner: OWNER };
const code = (run: () => unknown): unknown => {
  try { run(); } catch (error) { return (error as { code?: string }).code; }
  return undefined;
};

describe("the link's default window", () => {
  test("is one hour, the link service's own default", () => {
    expect(DEFAULT_REQUEST_WINDOW_MS).toBe(3_600_000);
  });
});

describe("--request-expires without a pinned owner", () => {
  test("accepts up to and including one hour", () => {
    expect(parseRequestExpires("2m", unpinned)).toBe(120_000);
    expect(parseRequestExpires("30m", unpinned)).toBe(1_800_000);
    expect(parseRequestExpires("60m", unpinned)).toBe(3_600_000);
    expect(parseRequestExpires("1h", unpinned)).toBe(3_600_000);
    expect(parseRequestExpires("3600s", unpinned)).toBe(3_600_000);
  });

  test("refuses anything longer than one hour, and says to pin the owner", () => {
    for (const value of ["61m", "3601s", "2h", "12h"]) {
      expect(code(() => parseRequestExpires(value, unpinned))).toBe("REQUEST_EXPIRES_NEEDS_OWNER");
    }
    expect(() => parseRequestExpires("2h", unpinned)).toThrow("--owner");
  });
});

describe("--request-expires with a pinned owner", () => {
  test("accepts a window over one hour up to and including twelve hours", () => {
    expect(parseRequestExpires("90m", pinned)).toBe(5_400_000);
    expect(parseRequestExpires("4h", pinned)).toBe(14_400_000);
    expect(parseRequestExpires("12h", pinned)).toBe(43_200_000);
    expect(parseRequestExpires("720m", pinned)).toBe(43_200_000);
  });

  test("refuses anything over twelve hours, even though the link service would allow 24", () => {
    for (const value of ["721m", "43201s", "13h", "24h", "1d", "2d"]) {
      expect(code(() => parseRequestExpires(value, pinned))).toBe("REQUEST_EXPIRES_TOO_LONG");
    }
  });
});

describe("the limit is the same with or without a pin once it is over twelve hours", () => {
  test("an over-long window with no pin is refused as too long, not as needing a pin", () => {
    expect(code(() => parseRequestExpires("13h", unpinned))).toBe("REQUEST_EXPIRES_TOO_LONG");
  });
});

describe("malformed windows", () => {
  test("are refused as a usage error", () => {
    for (const value of ["", "1", "h", "1.5h", "-1h", "1 h", "1H", "1w", "PT1H", "2026-12-01T00:00:00Z", "0m", "119s", "1m"]) {
      expect(code(() => parseRequestExpires(value, pinned))).toBe("INVALID_REQUEST_EXPIRES");
    }
  });

  test("a value too large to count exactly is refused", () => {
    expect(code(() => parseRequestExpires("99999999999999999999h", pinned))).toBe("INVALID_REQUEST_EXPIRES");
  });
});

describe("logins that do not use the approval link", () => {
  test("refuse the option, naming the login, before the window is looked at", () => {
    expect(code(() => parseRequestExpires("30m", { pinnedOwner: undefined, unusedBy: "`--paste`" }))).toBe("INVALID_ARGUMENT");
    expect(() => parseRequestExpires("not-a-window", { pinnedOwner: undefined, unusedBy: "`--device`" })).toThrow("`--device`");
  });
});

describe("assertRequestWindow, where the link is created", () => {
  test("repeats the limits for any caller", () => {
    expect(code(() => assertRequestWindow(3_600_001, undefined))).toBe("REQUEST_EXPIRES_NEEDS_OWNER");
    expect(code(() => assertRequestWindow(43_200_001, OWNER))).toBe("REQUEST_EXPIRES_TOO_LONG");
    expect(code(() => assertRequestWindow(43_200_001, undefined))).toBe("REQUEST_EXPIRES_TOO_LONG");
    expect(code(() => assertRequestWindow(3_600_000, undefined))).toBeUndefined();
    expect(code(() => assertRequestWindow(43_200_000, OWNER))).toBeUndefined();
  });
});
