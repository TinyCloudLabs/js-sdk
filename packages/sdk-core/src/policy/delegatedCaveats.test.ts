/**
 * Delegated SQL caveat grammar vectors (TC-1839). Ids mirror the node's
 * vector list: V = valid, R = refused, S = per-hop subset attenuation.
 * Beyond the list: ASCII-only folding, the 128-byte name cap, and the
 * Unicode edges of the control / whitespace rules.
 */

import { describe, expect, it } from "bun:test";

import { SqlCaveatError, foldSqlName, sqlCaveatContains } from "./delegatedCaveats";
import { normalizePolicyCapability, policyCapabilityContains } from "./capability";
import { parseSqlCaveatList, sqlCaveatListsEquivalent } from "./sqlCaveatList";
import { sqlCaveatListNeedsDelegatedFeature } from "./delegatedCaveats";
import { isCapabilitySubset } from "../capabilities";
import { ManifestValidationError, validateManifest } from "../manifest";

const names = (count: number): string[] => Array.from({ length: count }, (_, index) => `t${index}`);

const profile = {
  mode: "constrained-statements",
  readOnly: true,
  statements: [{ name: "get", sql: "SELECT 1", fixedParams: [] }],
};

function refusalOf(list: unknown): SqlCaveatError {
  try {
    parseSqlCaveatList(list);
  } catch (error) {
    if (error instanceof SqlCaveatError) return error;
    throw error;
  }
  throw new Error("expected the list to be refused");
}

const VALID: ReadonlyArray<readonly [string, unknown, "unrestricted" | "profile" | "delegated"]> = [
  ["V1 [] is unrestricted", [], "unrestricted"],
  ["V2 [{}] is unrestricted", [{}], "unrestricted"],
  ["V3 tables", [{ tables: ["Notes"] }], "delegated"],
  ["V4 columns", [{ columns: ["body", "id"] }], "delegated"],
  ["V5 readOnly", [{ readOnly: true }], "delegated"],
  ["V6 all three keys", [{ tables: ["Notes", "t2"], columns: ["body"], readOnly: true }], "delegated"],
  ["V7 explicit readOnly false", [{ readOnly: false }], "delegated"],
  ["V8 empty tables list allows nothing but is valid", [{ tables: [] }], "delegated"],
  ["V8 empty columns list is valid", [{ columns: [] }], "delegated"],
  ["V9 upper-case table name", [{ tables: ["NOTES"] }], "delegated"],
  ["V10 constrained-statements profile (mode form)", [profile], "profile"],
  ["V11 exactly 256 table names", [{ tables: names(256) }], "delegated"],
  ["V11 exactly 256 column names", [{ columns: names(256) }], "delegated"],
  ["V12 two empty entries are unrestricted", [{}, {}], "unrestricted"],
];

const REFUSED: ReadonlyArray<readonly [string, unknown]> = [
  ["R1 unknown key", [{ tabels: ["a"] }]],
  ["R1 unknown key beside a valid one", [{ tables: ["a"], extra: 1 }]],
  ["R2 tables not an array", [{ tables: "a" }]],
  ["R2 columns a string", [{ columns: "a" }]],
  ["R2 readOnly a string", [{ readOnly: "true" }]],
  ["R2 readOnly a number", [{ readOnly: 1 }]],
  ["R2 readOnly null", [{ readOnly: null }]],
  ["R2 number element", [{ tables: [1] }]],
  ["R2 null element", [{ tables: [null] }]],
  ["R2 nested array element", [{ columns: [["a"]] }]],
  ["R3 empty-string table", [{ tables: [""] }]],
  ["R3 empty-string column", [{ columns: [""] }]],
  ["R4 257 tables", [{ tables: names(257) }]],
  ["R4 257 columns", [{ columns: names(257) }]],
  ["R5 dotted table", [{ tables: ["Notes.body"] }]],
  ["R5 dotted column", [{ columns: ["Notes.body"] }]],
  ["R6 two non-empty entries", [{ tables: ["a"] }, { tables: ["b"] }]],
  ["R6 non-empty then empty", [{ tables: ["a"] }, {}]],
  ["R6 empty then non-empty", [{}, { readOnly: true }]],
  ["R7 mode beside tables", [{ mode: "constrained-statements", tables: ["a"], readOnly: true, statements: profile.statements }]],
  ["R7 mode beside columns", [{ mode: "constrained-statements", columns: ["a"], readOnly: true, statements: profile.statements }]],
  ["R8 number entry", [1]],
  ["R8 string entry", ["x"]],
  ["R8 null entry", [null]],
  ["R8 array entry", [[]]],
  ["R10 leading space", [{ tables: [" a"] }]],
  ["R10 trailing space", [{ columns: ["a "] }]],
  ["R10 NUL", [{ columns: ["a\u0000b"] }]],
  ["R10 newline inside", [{ tables: ["a\nb"] }]],
  ["R10 trailing tab", [{ tables: ["a\t"] }]],
  ["V10 nested constrained-statements form is not accepted by the SDK", [{ "constrained-statements": profile }]],
  ["profile plus a delegated entry", [profile, { tables: ["a"] }]],
  ["profile plus an empty entry", [profile, {}]],
  ["profile that is not a valid profile", [{ mode: "constrained-statements" }]],
  ["profile whose readOnly is not true", [{ ...profile, readOnly: false }]],
  ["not a list", { tables: ["a"] }],
];

describe("TC-1839 delegated SQL caveat grammar", () => {
  for (const [id, list, kind] of VALID) {
    it(`${id}`, () => {
      expect(parseSqlCaveatList(list).kind).toBe(kind);
    });
  }

  for (const [id, list] of REFUSED) {
    it(`${id} is refused`, () => {
      expect(refusalOf(list)).toBeInstanceOf(SqlCaveatError);
    });
  }

  it("V9 NOTES and Notes are the same table once folded", () => {
    expect(sqlCaveatListsEquivalent([{ tables: ["NOTES"] }], [{ tables: ["Notes"] }])).toBe(true);
    expect(sqlCaveatListsEquivalent([{ tables: ["NOTES"] }], [{ tables: ["Other"] }])).toBe(false);
  });

  it("V7 readOnly false equals absent", () => {
    expect(sqlCaveatListsEquivalent([{ readOnly: false }], [])).toBe(true);
    expect(sqlCaveatListsEquivalent([{ readOnly: true }], [{ readOnly: false }])).toBe(false);
  });

  it("parsed names are kept as written, never folded", () => {
    const parsed = parseSqlCaveatList([{ tables: ["NoTes"] }]);
    expect(parsed.kind === "delegated" ? parsed.caveat.tables : undefined).toEqual(["NoTes"]);
  });

  it("refusal messages are index-based and never echo a name", () => {
    const secret = "secret_table_name";
    for (const list of [
      [{ tables: [`${secret}.x`] }],
      [{ tables: [` ${secret}`] }],
      [{ tables: [secret], extra: true }],
      [{ tables: [secret] }, { tables: [secret] }],
      [{ mode: "constrained-statements", tables: [secret] }],
      [{ columns: [secret.repeat(20)] }],
    ]) {
      const error = refusalOf(list);
      expect(error.message).not.toContain(secret);
    }
    expect(refusalOf([{}, { tables: ["a."] }]).index).toBe(1);
  });

  describe("name rules", () => {
    it("only ASCII letters fold: the Kelvin sign stays distinct from k", () => {
      expect(foldSqlName("NOTES_K")).toBe("notes_k");
      expect(foldSqlName("\u212Ax")).toBe("\u212Ax");
      expect("\u212Ax".toLowerCase()).toBe("kx");
      expect(
        sqlCaveatListsEquivalent([{ tables: ["\u212Ax"] }], [{ tables: ["kx"] }]),
      ).toBe(false);
      expect(
        sqlCaveatContains(
          parseSqlCaveatList([{ tables: ["kx"] }]),
          parseSqlCaveatList([{ tables: ["\u212Ax"] }]),
        ),
      ).toBe(false);
    });

    it("the 128-byte cap counts UTF-8 bytes, not code units", () => {
      expect(parseSqlCaveatList([{ tables: ["a".repeat(128)] }]).kind).toBe("delegated");
      expect(refusalOf([{ tables: ["a".repeat(129)] }]).reason).toContain("too long");
      // U+00E9 is 2 bytes: 64 of them are exactly 128 bytes, 65 are 130.
      expect(parseSqlCaveatList([{ tables: ["\u00E9".repeat(64)] }]).kind).toBe("delegated");
      expect(refusalOf([{ tables: ["\u00E9".repeat(65)] }]).reason).toContain("too long");
      // U+20AC is 3 bytes: 42 are 126 bytes, 43 are 129 bytes.
      expect(parseSqlCaveatList([{ tables: ["\u20AC".repeat(42)] }]).kind).toBe("delegated");
      expect(refusalOf([{ tables: ["\u20AC".repeat(43)] }]).reason).toContain("too long");
      // An astral character is 4 bytes and two code units: 32 are 128 bytes.
      expect(parseSqlCaveatList([{ tables: ["\u{1F600}".repeat(32)] }]).kind).toBe("delegated");
      expect(refusalOf([{ tables: ["\u{1F600}".repeat(33)] }]).reason).toContain("too long");
    });

    it("U+FEFF is not whitespace to the node, so it is accepted at the edge", () => {
      expect(parseSqlCaveatList([{ tables: ["\uFEFFa"] }]).kind).toBe("delegated");
      expect(parseSqlCaveatList([{ tables: ["a\uFEFF"] }]).kind).toBe("delegated");
    });

    it("U+0085 is both a control character and whitespace", () => {
      expect(refusalOf([{ tables: ["a\u0085"] }]).reason).toContain("control");
      expect(refusalOf([{ tables: ["a\u0085b"] }]).reason).toContain("control");
    });

    it("Unicode White_Space at an edge is refused, inside is accepted", () => {
      for (const space of ["\u00A0", "\u2003", "\u3000", "\u2028"]) {
        expect(refusalOf([{ tables: [`${space}a`] }]).reason).toContain("whitespace");
        expect(refusalOf([{ tables: [`a${space}`] }]).reason).toContain("whitespace");
        expect(parseSqlCaveatList([{ tables: [`a${space}b`] }]).kind).toBe("delegated");
      }
    });

    it("an inner space is a legal name character", () => {
      expect(parseSqlCaveatList([{ tables: ["my table"] }]).kind).toBe("delegated");
    });
  });
});

describe("TC-1839 per-hop containment", () => {
  const hop = (parent: unknown, child: unknown): boolean =>
    sqlCaveatContains(parseSqlCaveatList(parent), parseSqlCaveatList(child));

  const HOPS: ReadonlyArray<readonly [string, unknown, unknown, boolean]> = [
    ["S1 child tables are a subset", [{ tables: ["Notes", "t2"] }], [{ tables: ["Notes"] }], true],
    ["S2 child adds a table", [{ tables: ["Notes"] }], [{ tables: ["Notes", "plain"] }], false],
    ["S3 parent has no tables", [{ readOnly: true }], [{ readOnly: true, tables: ["Notes"] }], true],
    ["S3 parent has no restriction at all", [], [{ tables: ["Notes"] }], true],
    ["S4 readOnly dropped (false)", [{ readOnly: true }], [{ readOnly: false }], false],
    ["S4 readOnly dropped (absent)", [{ readOnly: true }], [{ tables: ["a"] }], false],
    ["S4 readOnly turned on", [{ readOnly: false }], [{ readOnly: true }], true],
    ["S4 readOnly turned on under absent", [{ tables: ["a"] }], [{ tables: ["a"], readOnly: true }], true],
    ["S5 child adds a column", [{ columns: ["id"] }], [{ columns: ["id", "body"] }], false],
    ["S5 child keeps the column", [{ columns: ["id"] }], [{ columns: ["id"] }], true],
    ["S6 fold both sides, parent lower", [{ tables: ["notes"] }], [{ tables: ["NOTES"] }], true],
    ["S6 fold both sides, parent upper", [{ tables: ["NOTES"] }], [{ tables: ["notes"] }], true],
    ["S7 both absent", [{ readOnly: true }], [{ readOnly: true }], true],
    ["S7 both lists empty", [], [], true],
    ["S7 parent restricted, child absent on that axis", [{ tables: ["a"] }], [], false],
    ["S7 parent columns restricted, child has none", [{ columns: ["a"] }], [{ tables: ["a"] }], false],
    ["S8 child kept only readOnly", [{ tables: ["a"] }], [{ readOnly: true }], false],
    ["S8 parent empty tables, child absent", [{ tables: [] }], [{ readOnly: true }], false],
    ["S8 parent empty tables, child empty tables", [{ tables: [] }], [{ tables: [] }], true],
    ["S8 parent empty tables, child names one", [{ tables: [] }], [{ tables: ["a"] }], false],
    ["S9 owner-issued root grant is unconstrained", [], [{ tables: ["a"], columns: ["b"], readOnly: true }], true],
    ["S9 owner-issued root grant, explicit empty entry", [{}], [{ readOnly: false }], true],
    ["profile parent contains nothing here", [profile], [], false],
    ["profile child needs an unrestricted parent", [{ tables: ["a"] }], [profile], false],
    ["profile child under an unrestricted parent", [], [profile], true],
  ];

  for (const [id, parent, child, expected] of HOPS) {
    it(`${id}: ${expected ? "ok" : "refused"}`, () => {
      expect(hop(parent, child)).toBe(expected);
    });
  }
});

describe("TC-1839 manifest validation", () => {
  const manifestWith = (service: string, caveats: unknown) => ({
    app_id: "com.example.app",
    name: "Example",
    permissions: [{ service, path: "data.sqlite", actions: ["read"], caveats }],
  });

  it("accepts a delegated SQL caveat", () => {
    expect(() => validateManifest(manifestWith("tinycloud.sql", [{ tables: ["Notes"], readOnly: true }]))).not.toThrow();
  });

  it("accepts the profile form and empty lists", () => {
    expect(() => validateManifest(manifestWith("tinycloud.sql", [profile]))).not.toThrow();
    expect(() => validateManifest(manifestWith("tinycloud.sql", []))).not.toThrow();
    expect(() => validateManifest(manifestWith("tinycloud.sql", [{}]))).not.toThrow();
  });

  it("fails a bad SQL caveat at manifest validation without echoing a name", () => {
    expect(() => validateManifest(manifestWith("tinycloud.sql", [{ tables: ["a"] }, { tables: ["b"] }])))
      .toThrow(ManifestValidationError);
    let refusal: unknown;
    try {
      validateManifest(manifestWith("tinycloud.sql", [{ tables: ["secret.x"] }]));
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ManifestValidationError);
    expect((refusal as Error).message).not.toContain("secret");
  });

  it("R9 refuses any non-empty DuckDB caveat, delegated form or profile", () => {
    expect(() => validateManifest(manifestWith("tinycloud.duckdb", [{ tables: ["a"] }]))).toThrow(ManifestValidationError);
    expect(() => validateManifest(manifestWith("tinycloud.duckdb", [profile]))).toThrow(ManifestValidationError);
    expect(() => validateManifest(manifestWith("tinycloud.duckdb", [{}, { readOnly: true }]))).toThrow(ManifestValidationError);
  });

  it("R9 refuses a DuckDB list of two or more entries, even empty ones", () => {
    for (const list of [[{}, {}], [{}, {}, {}]]) {
      expect(() => validateManifest(manifestWith("tinycloud.duckdb", list))).toThrow(ManifestValidationError);
    }
  });

  it("R9 leaves empty DuckDB caveats alone", () => {
    expect(() => validateManifest(manifestWith("tinycloud.duckdb", []))).not.toThrow();
    expect(() => validateManifest(manifestWith("tinycloud.duckdb", [{}]))).not.toThrow();
  });

  it("does not look at other services' caveats", () => {
    expect(() => validateManifest(manifestWith("tinycloud.kv", [{ kind: "prefix", value: "a" }]))).not.toThrow();
  });
});

describe("TC-1839 coverage and policy capability", () => {
  const sqlEntry = (caveats?: Record<string, unknown>[]) => ({
    service: "tinycloud.sql",
    space: "applications",
    path: "data.sqlite",
    actions: ["tinycloud.sql/read"],
    ...(caveats === undefined ? {} : { caveats }),
  });

  it("a granted delegated caveat covers the same caveat spelled with other letter case", () => {
    expect(isCapabilitySubset([sqlEntry([{ tables: ["NOTES"] }])], [sqlEntry([{ tables: ["Notes"] }])]).subset).toBe(true);
  });

  it("a granted delegated caveat never covers an uncaveated or different request", () => {
    const granted = [sqlEntry([{ tables: ["Notes"] }])];
    expect(isCapabilitySubset([sqlEntry()], granted).subset).toBe(false);
    expect(isCapabilitySubset([sqlEntry([{ tables: ["Other"] }])], granted).subset).toBe(false);
    expect(isCapabilitySubset([sqlEntry([{ tables: ["Notes", "Other"] }])], granted).subset).toBe(false);
  });

  it("an uncaveated grant does not cover a delegated-caveat request", () => {
    expect(isCapabilitySubset([sqlEntry([{ tables: ["Notes"] }])], [sqlEntry()]).subset).toBe(false);
  });

  const policyCapability = (caveats: Record<string, unknown>) => ({
    service: "tinycloud.sql",
    space: "applications",
    path: "data.sqlite",
    actions: ["tinycloud.sql/read"],
    caveats,
  });

  it("the policy capability accepts one delegated entry and refuses a mix with a profile", () => {
    expect(() => normalizePolicyCapability(policyCapability({ tables: ["Notes"], readOnly: true }))).not.toThrow();
    expect(() => normalizePolicyCapability(policyCapability({ tables: ["Notes"], mode: "constrained-statements" })))
      .toThrow();
    expect(() => normalizePolicyCapability(policyCapability({ tables: ["a.b"] }))).toThrow();
    expect(() => normalizePolicyCapability(policyCapability({}))).toThrow();
  });

  it("policy containment compares delegated entries by folded subset", () => {
    const authority = policyCapability({ tables: ["Notes", "t2"] });
    expect(policyCapabilityContains(authority, policyCapability({ tables: ["NOTES"] }))).toBe(true);
    expect(policyCapabilityContains(authority, policyCapability({ tables: ["notes", "other"] }))).toBe(false);
    const { caveats: _omitted, ...uncaveated } = authority;
    expect(policyCapabilityContains(authority, uncaveated)).toBe(false);
  });
});

describe("TC-1839 empty lists and the feature gate", () => {
  const sqlEntry = (caveats?: Record<string, unknown>[]) => ({
    service: "tinycloud.sql",
    space: "applications",
    path: "data.sqlite",
    actions: ["tinycloud.sql/read"],
    ...(caveats === undefined ? {} : { caveats }),
  });

  it("V12 [{},{}] covers and is covered by an uncaveated or [{}] SQL entry", () => {
    for (const other of [undefined, [], [{}]] as const) {
      expect(isCapabilitySubset([sqlEntry([{}, {}])], [sqlEntry(other as Record<string, unknown>[] | undefined)]).subset).toBe(true);
      expect(isCapabilitySubset([sqlEntry(other as Record<string, unknown>[] | undefined)], [sqlEntry([{}, {}])]).subset).toBe(true);
    }
  });

  it("[{},{}] stays distinct from [] for other services (byte-for-byte as before)", () => {
    const kv = (caveats?: Record<string, unknown>[]) => ({
      service: "tinycloud.kv",
      space: "applications",
      path: "a/",
      actions: ["tinycloud.kv/get"],
      ...(caveats === undefined ? {} : { caveats }),
    });
    expect(isCapabilitySubset([kv([{}, {}])], [kv()]).subset).toBe(false);
  });

  const NEEDS: ReadonlyArray<readonly [string, unknown, boolean]> = [
    ["undefined", undefined, false],
    ["[]", [], false],
    ["[{}]", [{}], false],
    ["[{},{}] is refused by a node without the feature", [{}, {}], true],
    ["[{},{},{}]", [{}, {}, {}], true],
    ["delegated entry", [{ tables: ["a"] }], true],
    ["readOnly false only", [{ readOnly: false }], true],
    ["an invalid delegated attempt still needs the feature", [{ tabels: ["a"] }], true],
    ["profile", [profile], false],
    ["nested profile spelling is not a delegated entry", [{ "constrained-statements": profile }], false],
  ];

  for (const [id, list, expected] of NEEDS) {
    it(`sqlCaveatListNeedsDelegatedFeature(${id}) is ${expected}`, () => {
      expect(sqlCaveatListNeedsDelegatedFeature(list)).toBe(expected);
    });
  }
});

describe("TC-1839 well-formed names and fail-closed gate input", () => {
  it("refuses a name with a lone surrogate, in either position", () => {
    for (const name of ["a\uD800", "\uD800", "\uDC00a", "a\uDC00b", "\uD800\uD800\uDC00"]) {
      expect(() => parseSqlCaveatList([{ tables: [name] }])).toThrow(SqlCaveatError);
      expect(() => parseSqlCaveatList([{ columns: [name] }])).toThrow(SqlCaveatError);
    }
  });

  it("accepts a well-formed surrogate pair, counted as 4 bytes", () => {
    expect(parseSqlCaveatList([{ tables: ["\u{10000}"] }]).kind).toBe("delegated");
    expect(parseSqlCaveatList([{ tables: ["a\u{1F600}b"] }]).kind).toBe("delegated");
  });

  it("a lone surrogate is not echoed in the refusal", () => {
    expect(refusalOf([{ tables: ["secret\uD800"] }]).message).not.toContain("secret");
  });

  class Entry {}
  const NON_PLAIN: ReadonlyArray<readonly [string, unknown]> = [
    ["a Map", new Map([["tables", ["a"]]])],
    ["an empty Map", new Map()],
    ["a class instance", new Entry()],
    ["null", null],
    ["an array", []],
    ["a string", "tables"],
    ["a number", 1],
  ];

  for (const [label, entry] of NON_PLAIN) {
    it(`sqlCaveatListNeedsDelegatedFeature fails closed on ${label} entry`, () => {
      expect(sqlCaveatListNeedsDelegatedFeature([entry])).toBe(true);
      expect(sqlCaveatListNeedsDelegatedFeature([{ readOnly: true }, entry])).toBe(true);
    });
  }

  it("plain objects with a null prototype are still plain", () => {
    expect(sqlCaveatListNeedsDelegatedFeature([Object.create(null)])).toBe(false);
    expect(sqlCaveatListNeedsDelegatedFeature([Object.assign(Object.create(null), { tables: ["a"] })])).toBe(true);
  });
});
