import { describe, expect, test } from "bun:test";
import { decodeTcr1, encodeTcr1, listPathCovered, localList, utf8Compare } from "./listLocal";

const allKeys = ["notes", "notes/a", "notes/b", "notes-x"];
const meta = { asOf: new Date(1_000_000).toISOString(), coverage: "complete" as const, authority: "valid" as const, syncedThroughEpoch: 0 };
const handle = { async list({ prefix, after, limit }: { prefix: string; after?: string; limit?: number }) { const keys = allKeys.filter((key) => key.startsWith(prefix) && (after === undefined || utf8Compare(key, after) > 0)).sort(utf8Compare); return { keys: limit === undefined ? keys : keys.slice(0, limit), meta }; } };

describe("local list parity", () => {
  test("prefix coverage respects complete path segments", () => {
    expect(listPathCovered(["notes"], "notes")).toBe("notes");
    expect(listPathCovered(["notes"], "notes/a")).toBe("notes");
    expect(listPathCovered(["notes"], "notes-x")).toBeUndefined();
    expect(listPathCovered(["notes/"], "notes")).toBeUndefined();
  });

  test("exact key and children advance strictly through tcr1 pages", async () => {
    const validateMeta = (value: typeof meta) => { if (value.coverage !== "complete" || value.authority !== "valid") throw new Error("ineligible local read"); };
    const first = await localList(handle, "space", "notes", 1, undefined, validateMeta);
    expect(first.keys).toEqual(["notes"]);
    expect(first.truncated).toBe(true);
    expect(decodeTcr1(first.nextCursor!)).toEqual({ v: 1, space: "space", path: "notes", last: "notes" });
    const second = await localList(handle, "space", "notes", 1, first.nextCursor, validateMeta);
    expect(second.keys).toEqual(["notes/a"]);
    const third = await localList(handle, "space", "notes", 1, second.nextCursor, validateMeta);
    expect(third.keys).toEqual(["notes/b"]);
    expect(third.truncated).toBe(false);
    expect(third.nextCursor).toBeUndefined();
  });

  test("validates metadata from the exact-key probe and the children lookup", async () => {
    let reads = 0;
    const changing = {
      async list({ prefix }: { prefix: string }) {
        reads++;
        return {
          keys: prefix === "notes" ? [] : ["notes/a"],
          meta: reads === 1 ? meta : { ...meta, coverage: "bootstrapping" as const },
        };
      },
    };
    const validateMeta = (value: typeof meta) => {
      if (value.coverage !== "complete" || value.authority !== "valid") throw Object.assign(new Error("ineligible local read"), { code: "COVERAGE_INCOMPLETE" });
    };
    await expect(localList(changing, "space", "notes", undefined, undefined, validateMeta)).rejects.toMatchObject({ code: "COVERAGE_INCOMPLETE" });
    expect(reads).toBe(2);

    reads = 0;
    const invalidProbe = {
      async list() {
        reads++;
        return { keys: ["notes"], meta: { ...meta, coverage: "empty" as const } };
      },
    };
    await expect(localList(invalidProbe, "space", "notes", undefined, undefined, validateMeta)).rejects.toMatchObject({ code: "COVERAGE_INCOMPLETE" });
    expect(reads).toBe(1);
  });

  test("cursor encoding round-trips Unicode and UTF-8 ordering is bytewise", () => {
    const cursor = encodeTcr1("space-東京", "notes", "notes/😀");
    expect(decodeTcr1(cursor)).toEqual({ v: 1, space: "space-東京", path: "notes", last: "notes/😀" });
    expect(utf8Compare("notes/é", "notes/😀")).toBeLessThan(0);
  });
});
