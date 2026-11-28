import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  APP_SEAL_RECORD_KEY_MAX,
  applicationsSpaceId,
  assertSealAad,
  openSealedPlaintext,
  parseRecordKey,
  sealHeader,
  sealPlaintext,
} from "./app-seal.js";

const OWNER = "did:pkh:eip155:1:0xFCAd0B19bB29D4674531d6f115237E16AfCE377c";
const OTHER_OWNER = "did:pkh:eip155:1:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const aadOf = (header: string) => Buffer.from(header, "utf8").toString("base64");

describe("record key", () => {
  test("is taken whole, up to the limit", () => {
    expect(parseRecordKey("person/ada")).toBe("person/ada");
    expect(parseRecordKey("k".repeat(APP_SEAL_RECORD_KEY_MAX))).toHaveLength(APP_SEAL_RECORD_KEY_MAX);
  });

  test("an empty, missing or too long key is refused", () => {
    for (const bad of [undefined, "", "k".repeat(APP_SEAL_RECORD_KEY_MAX + 1)]) {
      expect(() => parseRecordKey(bad)).toThrow(expect.objectContaining({ code: "INVALID_RECORD_KEY" }));
    }
  });
});

describe("seal context", () => {
  test("binds owner, applications space and the full record key, in that order", () => {
    expect(applicationsSpaceId(OWNER)).toBe(`tinycloud:pkh:eip155:1:0xFCAd0B19bB29D4674531d6f115237E16AfCE377c:applications`);
    expect(JSON.parse(sealHeader(OWNER, "person/ada"))).toEqual([
      "tinycloud.app.seal/v1", OWNER, applicationsSpaceId(OWNER), "person/ada",
    ]);
  });

  test("a non-pkh owner has no applications space", () => {
    expect(() => applicationsSpaceId("did:key:z6Mkabc")).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
  });

  test("the outer context must equal the expected header exactly", () => {
    const header = sealHeader(OWNER, "person/ada");
    expect(() => assertSealAad(aadOf(header), header)).not.toThrow();
    for (const bad of [
      undefined,
      "",
      aadOf(sealHeader(OWNER, "person/bob")),
      aadOf(sealHeader(OTHER_OWNER, "person/ada")),
      aadOf(header).replace(/=+$/, ""),
      Buffer.from(header, "utf8").toString("base64url") + "x",
    ]) {
      expect(() => assertSealAad(bad, header)).toThrow(expect.objectContaining({ code: "CONTEXT_MISMATCH" }));
    }
  });

  test("a sealed value round-trips as compact JSON behind its header", () => {
    const header = sealHeader(OWNER, "person/ada");
    const plaintext = sealPlaintext(header, ' { "name" : "Ada",\n "n": [1, 2] } ');
    expect(new TextDecoder().decode(plaintext)).toBe(`${header}\n{"name":"Ada","n":[1,2]}`);
    expect(openSealedPlaintext(plaintext, header)).toBe('{"name":"Ada","n":[1,2]}');
  });

  test("input that is not one JSON value cannot be sealed", () => {
    const header = sealHeader(OWNER, "person/ada");
    expect(() => sealPlaintext(header, "not json")).toThrow();
    expect(() => sealPlaintext(header, "")).toThrow();
  });

  test("a payload sealed for another record, owner or without a value is refused", () => {
    const header = sealHeader(OWNER, "person/ada");
    const forOtherRecord = sealPlaintext(sealHeader(OWNER, "person/bob"), '{"a":1}');
    const forOtherOwner = sealPlaintext(sealHeader(OTHER_OWNER, "person/ada"), '{"a":1}');
    const headerOnly = new TextEncoder().encode(`${header}\n`);
    const notJson = new TextEncoder().encode(`${header}\nnot json`);
    const noSeparator = new TextEncoder().encode(`${header}{"a":1}`);
    for (const bad of [forOtherRecord, forOtherOwner, headerOnly, notJson, noSeparator]) {
      expect(() => openSealedPlaintext(bad, header)).toThrow(expect.objectContaining({ code: "CONTEXT_MISMATCH" }));
    }
  });
});
