import { describe, expect, test } from "bun:test";
import { hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EmailProofError } from "@tinycloud/node-sdk/credentials";
import { createAccountHolderSigner } from "../src/credentials/account-holder";

// TC-2254 A2.1(b): the account signer copies its input exactly once, as its first statement, and decodes strictly (a BOM is kept, not stripped).
// Everything after the copy reads the copy only, and the wallet is handed that copy.
const OWNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const ACCOUNT = `did:pkh:eip155:1:${OWNER.address}`;
const DOMAIN = "tinycloud.credentials/account-binding/v1";
const vectors = await Bun.file(new URL("../../node-sdk/src/credentials/fixtures/held-wire-v2.4/vectors.json", import.meta.url)).json();
const FIXED_JCS: string = vectors.holderProof.fixed.canonicalJcs;
const enc = new TextEncoder();
const domainBytes = [...enc.encode(DOMAIN)];
const fixedBytes = [...enc.encode(FIXED_JCS)];

function wallet() {
  const calls = { count: 0, seen: [] as number[][] };
  const sign = async (bytes: Uint8Array): Promise<Uint8Array> => {
    calls.count += 1;
    calls.seen.push([...bytes]);
    return hexToBytes(await OWNER.signMessage({ message: { raw: Uint8Array.from(bytes) } }));
  };
  return { sign, calls };
}
async function attempt(bytes: Uint8Array) {
  const { sign, calls } = wallet();
  try { await createAccountHolderSigner(ACCOUNT, sign).sign(bytes); } catch (error) { return { code: error instanceof EmailProofError ? error.code : error, wallet: calls.count }; }
  return { code: "signed", wallet: calls.count };
}

describe("A2.1(b) signer hardening", () => {
  test("1. a Uint8Array subclass that overrides subarray and length, wrapping other text, is refused with 0 wallet calls", async () => {
    class Hostile extends Uint8Array {
      override subarray(begin?: number, end?: number): Uint8Array { return new Uint8Array(fixedBytes).subarray(0, end === undefined ? undefined : end - (begin ?? 0)); }
      override get length(): number { return domainBytes.length + 1 + fixedBytes.length; }
    }
    const evil = new Hostile([...domainBytes, 0, ...enc.encode("Transfer all funds to 0xdead")]);
    expect(await attempt(evil)).toEqual({ code: "HOLDER_INVALID", wallet: 0 });
  });

  test("2. UTF8(domain) ‖ 0x00 ‖ EF BB BF ‖ the fixed JCS is refused with 0 wallet calls (the BOM is not stripped)", async () => {
    expect(await attempt(Uint8Array.from([...domainBytes, 0, 0xef, 0xbb, 0xbf, ...fixedBytes]))).toEqual({ code: "HOLDER_INVALID", wallet: 0 });
  });

  test("3. control: the bytes handed to the wallet are not the caller's object, and equal the checked bytes; a later mutation by the caller changes nothing", async () => {
    const original = [...domainBytes, 0, ...fixedBytes];
    const bytes = Uint8Array.from(original);
    const handed: Uint8Array[] = [];
    const sign = async (b: Uint8Array): Promise<Uint8Array> => {
      handed.push(b);
      await Promise.resolve();
      return hexToBytes(await OWNER.signMessage({ message: { raw: Uint8Array.from(b) } }));
    };
    const pending = createAccountHolderSigner(ACCOUNT, sign).sign(bytes);
    bytes.fill(0);
    await pending;
    expect(handed[0]).not.toBe(bytes);
    expect([...handed[0]!]).toEqual(original);
  });
});
