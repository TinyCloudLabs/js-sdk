import { describe, expect, test } from "bun:test";
import { hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EmailProofError, requestEmailProofCode } from "@tinycloud/node-sdk/credentials";
import { createAccountHolderSigner } from "../src/credentials/account-holder";

// TC-1454 (QA, beta.4): the account signer's refusals of its INPUT carried the generic HOLDER_INVALID text, "Holder must be a did:key Ed25519 identifier.",
// although the holder is a did:pkh and the cause is the bytes it was asked to sign. The code stays HOLDER_INVALID and nothing else changes (0 sign calls);
// only the text says what is true. Refusals that are not about the input (the account did, a bad signature from the wallet) keep the shared text.
const OWNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const ACCOUNT = `did:pkh:eip155:1:${OWNER.address}`;
const DOMAIN = "tinycloud.credentials/account-binding/v1";
const INPUT_TEXT = "The wallet signer signs only the exact account binding for this request.";
const SHARED_TEXT = "Holder must be a did:key Ed25519 identifier.";
const vectors = await Bun.file(new URL("../../node-sdk/src/credentials/fixtures/held-wire-v2.4/vectors.json", import.meta.url)).json();
const FIXED: Record<string, unknown> = vectors.holderProof.fixed.binding;
const FIXED_JCS: string = vectors.holderProof.fixed.canonicalJcs;
const enc = new TextEncoder();
const domainBytes = [...enc.encode(DOMAIN)];

const jcs = (value: unknown): string => {
  const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v);
  return JSON.stringify(sort(value));
};
const framed = (body: string) => enc.encode(`${DOMAIN}\u0000${body}`);

function wallet(shape: (signature: Uint8Array) => Uint8Array = (s) => s) {
  const calls = { count: 0 };
  const sign = async (bytes: Uint8Array): Promise<Uint8Array> => { calls.count += 1; return shape(hexToBytes(await OWNER.signMessage({ message: new TextDecoder().decode(bytes) }))); };
  return { sign, calls };
}
async function refusal(bytes: Uint8Array, shape?: (signature: Uint8Array) => Uint8Array) {
  const { sign, calls } = wallet(shape);
  try { await createAccountHolderSigner(ACCOUNT, sign).sign(bytes); } catch (error) { return { error: error as EmailProofError, signCalls: calls.count }; }
  return { error: undefined, signCalls: calls.count };
}

describe("every refusal of the signer's input says what is true, with the code HOLDER_INVALID and 0 sign calls", () => {
  const cases: [string, Uint8Array][] = [
    ["arbitrary text after the domain", framed("Transfer all funds to 0xdead")],
    ["free text in audience", framed(jcs({ ...FIXED, audience: "Transfer all funds to 0xdead" }))],
    ["a BOM after the NUL", Uint8Array.from([...domainBytes, 0, 0xef, 0xbb, 0xbf, ...enc.encode(FIXED_JCS)])],
    ["no domain prefix at all", enc.encode("hello")],
    ["the domain with a changed byte", Uint8Array.from([...domainBytes.map((b, i) => (i === 3 ? b ^ 1 : b)), 0, ...enc.encode(FIXED_JCS)])],
    ["another byte instead of the NUL", Uint8Array.from([...domainBytes, 0x20, ...enc.encode(FIXED_JCS)])],
    ["invalid UTF-8 in the body", Uint8Array.from([...domainBytes, 0, 0xff, 0xfe])],
    ["a body that is not JSON", framed("not json")],
    ["a body that is not the exact JCS (whitespace)", framed(JSON.stringify(FIXED, null, 1))],
    ["a JSON array", framed("[]")],
    ["a missing field", framed(jcs(Object.fromEntries(Object.entries(FIXED).filter(([k]) => k !== "jti"))))],
    ["a numeric requestId", framed(jcs({ ...FIXED, requestId: 7 }))],
    ["a binding for another account", framed(jcs({ ...FIXED, holderDid: "did:pkh:eip155:1:0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }))],
    ["another pinned field (issuer)", framed(jcs({ ...FIXED, issuer: "did:web:evil.example" }))],
    ["a per-request field with the wrong format (requestId)", framed(jcs({ ...FIXED, requestId: "short" }))],
  ];
  for (const [name, bytes] of cases) {
    test(name, async () => {
      const { error, signCalls } = await refusal(bytes);
      expect([name, error?.code, error?.message, signCalls]).toEqual([name, "HOLDER_INVALID", INPUT_TEXT, 0]);
    });
  }
  test("control: the fixed binding is signed", async () => {
    const { error, signCalls } = await refusal(framed(FIXED_JCS));
    expect([error, signCalls]).toEqual([undefined, 1]);
  });
});

describe("refusals that are not about the input keep the shared text", () => {
  test("a did that is not a mainnet did:pkh cannot make a signer", () => {
    for (const did of ["did:pkh:eip155:5:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "did:key:z6MkehRgf7yJbgaGfYsdoAsKdBPE3dj2CYhowQdcjqSJgvVd"]) {
      try { createAccountHolderSigner(did, async () => new Uint8Array(65)); throw new Error("no refusal"); } catch (error) {
        expect([(error as EmailProofError).code, (error as EmailProofError).message]).toEqual(["HOLDER_INVALID", SHARED_TEXT]);
      }
    }
  });

  test("a wallet that returns a malformed signature, or one by another account, after a valid binding: HOLDER_INVALID with the shared text, one sign call", async () => {
    for (const shape of [(s: Uint8Array) => s.slice(0, 64), (s: Uint8Array) => { const out = new Uint8Array(s); out[64] = 5; return out; }]) {
      const { error, signCalls } = await refusal(framed(FIXED_JCS), shape);
      expect([error?.code, error?.message, signCalls]).toEqual(["HOLDER_INVALID", SHARED_TEXT, 1]);
    }
    const other = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const signer = createAccountHolderSigner(ACCOUNT, async (bytes) => hexToBytes(await other.signMessage({ message: new TextDecoder().decode(bytes) })));
    await expect(signer.sign(framed(FIXED_JCS))).rejects.toMatchObject({ code: "HOLDER_INVALID", message: SHARED_TEXT });
  });

  test("the shared HOLDER_INVALID text is unchanged where a real did:key holder is refused (the ticket flow, node-sdk)", async () => {
    let fetched = 0;
    const fetchFn = Object.assign(async () => { fetched += 1; return new Response("{}"); }, { preconnect: () => {} }) as typeof globalThis.fetch;
    const holder = { did: "did:key:not-an-ed25519-key", alg: "EdDSA" as const, kid: "did:key:not-an-ed25519-key#x", sign: async (b: Uint8Array) => b };
    const error = await requestEmailProofCode({ address: "reader@example.com", holder, fetch: fetchFn }).catch((e: unknown) => e as EmailProofError);
    expect([(error as EmailProofError).code, (error as EmailProofError).message, fetched]).toEqual(["HOLDER_INVALID", SHARED_TEXT, 0]);
  });
});
