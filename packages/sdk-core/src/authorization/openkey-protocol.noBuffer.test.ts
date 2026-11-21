import { afterEach, describe, expect, it } from "bun:test";
import { extractRecapAttenuations } from "./openkey-protocol";

// A browser bundle without Node's Buffer (TC-3639).
const nodeBuffer = globalThis.Buffer;

function recapSiwe(payload: unknown): string {
  const json = JSON.stringify(payload);
  const encoded = nodeBuffer.from(json, "utf8").toString("base64url");
  return [
    "example.com wants you to sign in with your Ethereum account:",
    "0x1111111111111111111111111111111111111111",
    "",
    "Resources:",
    `- urn:recap:${encoded}`,
  ].join("\n");
}

function withoutBuffer<T>(run: () => T): T {
  Object.defineProperty(globalThis, "Buffer", { value: undefined, configurable: true, writable: true });
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, "Buffer", { value: nodeBuffer, configurable: true, writable: true });
  }
}

afterEach(() => {
  Object.defineProperty(globalThis, "Buffer", { value: nodeBuffer, configurable: true, writable: true });
});

describe("extractRecapAttenuations without Node's Buffer (TC-3639)", () => {
  it("decodes a recap, including non-ASCII resource names", () => {
    const att = { "tinycloud:space/kv/données-é-日本": { "tinycloud.kv/get": [{}] } };
    const siwe = recapSiwe({ att });
    const caps = withoutBuffer(() => {
      expect(typeof globalThis.Buffer).toBe("undefined");
      return extractRecapAttenuations(siwe);
    });
    expect(caps).toEqual(att);
  });

  it("still refuses a payload that is not valid JSON", () => {
    const siwe = recapSiwe({ att: {} }).replace(/urn:recap:\S+/, "urn:recap:aGVsbG8");
    expect(() => withoutBuffer(() => extractRecapAttenuations(siwe))).toThrow(/not valid JSON/);
  });

  it("refuses a payload that is not decodable base64 instead of ignoring it", () => {
    // Length 5 is never valid base64: Node's Buffer would silently drop the tail, atob refuses it.
    const siwe = recapSiwe({ att: {} }).replace(/urn:recap:\S+/, "urn:recap:abcde");
    expect(() => withoutBuffer(() => extractRecapAttenuations(siwe))).toThrow(/Failed to decode urn:recap: payload/);
  });
});
