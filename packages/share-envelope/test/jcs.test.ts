import { describe, expect, it } from "vitest";

import { canonicalize } from "../src/jcs.js";

describe("RFC 8785 canonicalization", () => {
  it("is deterministic regardless of property insertion order", () => {
    const a = { b: 2, a: 1, nested: { z: [1, 2], y: "s" } };
    const b = { nested: { y: "s", z: [1, 2] }, a: 1, b: 2 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"a":1,"b":2,"nested":{"y":"s","z":[1,2]}}');
  });

  it("matches RFC 8785 §3.2.3 key ordering (UTF-16 code units)", () => {
    // From the RFC's ordering example: "" < digits < uppercase < lowercase.
    const value = { a: 0, "1": 0, A: 0, "": 0 };
    expect(canonicalize(value)).toBe('{"":0,"1":0,"A":0,"a":0}');
  });

  it("serializes numbers per ECMAScript Number::toString (RFC 8785 §3.2.2.3)", () => {
    expect(canonicalize({ n: 1e21 })).toBe('{"n":1e+21}');
    expect(canonicalize({ n: 0.000001 })).toBe('{"n":0.000001}');
    expect(canonicalize({ n: 10 })).toBe('{"n":10}');
    expect(canonicalize({ n: -0 })).toBe('{"n":0}');
  });

  it("escapes strings per JSON/JCS rules", () => {
    expect(canonicalize("a\nb\u0000")).toBe('"a\\nb\\u0000"');
  });

  it("matches RFC 8785 number vectors at the exponent boundaries", () => {
    // Positional/exponential switchover: 10^21 flips to exponent notation.
    expect(canonicalize(1e20)).toBe("100000000000000000000");
    expect(canonicalize(1e21)).toBe("1e+21");
    // Small-magnitude switchover: 10^-6 positional, 10^-7 exponential.
    expect(canonicalize(0.000001)).toBe("0.000001");
    expect(canonicalize(1e-7)).toBe("1e-7");
    // Negative zero serializes as "0" (RFC 8785 appendix).
    expect(canonicalize(-0)).toBe("0");
  });

  it("uses shortest round-trip serialization for doubles (RFC 8785 appendix)", () => {
    expect(canonicalize(333333333.33333329)).toBe("333333333.3333333");
    expect(canonicalize(9.999999999999997e22)).toBe("9.999999999999997e+22");
    expect(canonicalize(0.1)).toBe("0.1");
    expect(canonicalize(1.5e-11)).toBe("1.5e-11");
  });

  it("escapes control characters per RFC 8785 §3.2.2.2 (short escapes + lowercase u-escapes)", () => {
    // Named short escapes for the popular controls…
    expect(canonicalize("\b\t\n\f\r\"\\")).toBe('"\\b\\t\\n\\f\\r\\"\\\\"');
    // …lowercase \u00xx for the rest of C0…
    expect(canonicalize("\u0000\u001f")).toBe('"\\u0000\\u001f"');
    // …and NO escaping of DEL or non-ASCII: they pass through literally.
    expect(canonicalize("ö€")).toBe('"ö€"');
  });

  it("orders non-BMP keys by UTF-16 code units (RFC 8785 §3.2.3 example)", () => {
    // The RFC's own ordering example: keys sort by UTF-16 code units, so the
    // surrogate-pair emoji (first unit 0xD83D) sorts BEFORE דּ (0xFB33) even
    // though its code point (U+1F600) is higher — the RFC's headline case.
    const value = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "דּ": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    };
    expect(canonicalize(value)).toBe(
      '{"\\r":"Carriage Return",' +
        '"1":"One",' +
        '"":"Control",' +
        '"ö":"Latin Small Letter O With Diaeresis",' +
        '"€":"Euro Sign",' +
        '"😀":"Emoji: Grinning Face",' +
        '"דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it("rejects unpaired UTF-16 surrogates (RFC 8785 §3.2.2.2)", () => {
    expect(() => canonicalize("\ud800")).toThrow(TypeError); // lone high
    expect(() => canonicalize("\udfff")).toThrow(TypeError); // lone low
    expect(() => canonicalize("a\ud800b")).toThrow(TypeError); // high not followed by low
    expect(() => canonicalize("\ude00\ud83d")).toThrow(TypeError); // reversed pair
    expect(() => canonicalize({ "\ud800": 1 })).toThrow(TypeError); // in a key
    expect(() => canonicalize({ k: ["a\udbff"] })).toThrow(TypeError); // nested, high at end
    // Well-formed pairs are fine.
    expect(canonicalize("😀")).toBe('"😀"');
  });

  it("drops undefined properties and keeps null", () => {
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("rejects values JSON cannot represent", () => {
    expect(() => canonicalize({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalize({ n: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => canonicalize({ f: () => 1 })).toThrow(TypeError);
    expect(() => canonicalize(10n as unknown)).toThrow(TypeError);
    expect(() => canonicalize(new Date() as unknown)).toThrow(TypeError);
  });
});
