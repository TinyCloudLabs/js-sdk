import { describe, expect, it } from "bun:test";

import {
  generateTotp,
  parseTotpSeed,
  totpSecondsRemaining,
  type TotpParams,
  type TotpParseFailure,
} from "./totp";

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

// RFC 6238 appendix B: 8 digits, 30 second step, one key per hash.
const SHA1_KEY = ascii("12345678901234567890");
const SHA256_KEY = ascii("12345678901234567890123456789012");
const SHA512_KEY = ascii(
  "1234567890123456789012345678901234567890123456789012345678901234",
);
const VECTORS: Array<[number, string, string, string]> = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

function params(
  secret: Uint8Array,
  algorithm: TotpParams["algorithm"],
): TotpParams {
  return { secret, algorithm, digits: 8, period: 30 };
}

describe("generateTotp (RFC 6238 appendix B)", () => {
  for (const [seconds, sha1, sha256, sha512] of VECTORS) {
    it(`matches the vectors at T=${seconds}`, () => {
      const nowMs = seconds * 1000;
      expect(generateTotp(params(SHA1_KEY, "SHA1"), nowMs)).toBe(sha1);
      expect(generateTotp(params(SHA256_KEY, "SHA256"), nowMs)).toBe(sha256);
      expect(generateTotp(params(SHA512_KEY, "SHA512"), nowMs)).toBe(sha512);
    });
  }

  it("keeps leading zeros and truncates to the requested digit count", () => {
    const six = generateTotp({ ...params(SHA1_KEY, "SHA1"), digits: 6 }, 1111111109 * 1000);
    expect(six).toBe("081804");
  });

  it("holds one code for a whole period and changes at the boundary", () => {
    const p = params(SHA1_KEY, "SHA1");
    expect(generateTotp(p, 30_000)).toBe(generateTotp(p, 59_999));
    expect(generateTotp(p, 59_999)).not.toBe(generateTotp(p, 60_000));
  });
});

describe("totpSecondsRemaining", () => {
  it("counts down within the period and resets at the boundary", () => {
    expect(totpSecondsRemaining(30, 0)).toBe(30);
    expect(totpSecondsRemaining(30, 1_000)).toBe(29);
    expect(totpSecondsRemaining(30, 29_999)).toBe(1);
    expect(totpSecondsRemaining(30, 30_000)).toBe(30);
    expect(totpSecondsRemaining(60, 90_500)).toBe(30);
  });
});

describe("parseTotpSeed", () => {
  const BASE32_KEY = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("parses a bare base32 seed with defaults", () => {
    const parsed = parseTotpSeed(BASE32_KEY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.algorithm).toBe("SHA1");
    expect(parsed.data.digits).toBe(6);
    expect(parsed.data.period).toBe(30);
    expect(Array.from(parsed.data.secret)).toEqual(Array.from(SHA1_KEY));
    expect(parsed.data.issuer).toBeUndefined();
  });

  it("tolerates spaces, dashes, lowercase and padding", () => {
    const parsed = parseTotpSeed("  gezd gnbv-gy3t qojq gezd gnbv gy3t qojq== \n");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Array.from(parsed.data.secret)).toEqual(Array.from(SHA1_KEY));
  });

  it("parses an otpauth URI with every parameter", () => {
    const parsed = parseTotpSeed(
      `otpauth://totp/Example%20Co:alice%40example.com?secret=${BASE32_KEY}&issuer=Example%20Co&algorithm=sha256&digits=8&period=60`,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data).toMatchObject({
      algorithm: "SHA256",
      digits: 8,
      period: 60,
      issuer: "Example Co",
      label: "alice@example.com",
    });
  });

  it("takes the issuer from the label prefix when no issuer parameter is given", () => {
    const parsed = parseTotpSeed(`otpauth://totp/GitHub:bob?secret=${BASE32_KEY}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.issuer).toBe("GitHub");
    expect(parsed.data.label).toBe("bob");
  });

  it("a parsed seed yields the RFC code", () => {
    const parsed = parseTotpSeed(
      `otpauth://totp/t?secret=${BASE32_KEY}&digits=8`,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(generateTotp(parsed.data, 59_000)).toBe("94287082");
  });

  it("rejects bad input with a reason and never echoes the seed", () => {
    const cases: Array<[string, TotpParseFailure]> = [
      ["", "empty"],
      ["   ", "empty"],
      ["not base32 !!!", "invalid_base32"],
      ["123456", "invalid_base32"],
      ["ABCD", "too_short"],
      ["otpauth://hotp/x?secret=" + BASE32_KEY, "not_totp"],
      ["otpauth://totp/x", "missing_secret"],
      [`otpauth://totp/x?secret=${BASE32_KEY}&period=0`, "invalid_period"],
      [`otpauth://totp/x?secret=${BASE32_KEY}&period=abc`, "invalid_period"],
      [`otpauth://totp/x?secret=${BASE32_KEY}&digits=5`, "invalid_digits"],
      [`otpauth://totp/x?secret=${BASE32_KEY}&algorithm=MD5`, "invalid_algorithm"],
    ];
    for (const [input, reason] of cases) {
      const parsed = parseTotpSeed(input);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.reason).toBe(reason);
      expect(parsed.message).not.toContain(BASE32_KEY);
    }
  });
});
