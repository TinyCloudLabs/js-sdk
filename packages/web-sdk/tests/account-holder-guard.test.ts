import { describe, expect, test } from "bun:test";
import { hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EmailProofError } from "@tinycloud/node-sdk/credentials";
import { createAccountHolderSigner } from "../src/credentials/account-holder";

// TC-2254 S16: the exported account signer refuses everything that is not one exact account binding.
// Every refusal is HOLDER_INVALID with ZERO wallet calls. Public local-development keys (Hardhat #0, #1).
const OWNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const OTHER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ACCOUNT = `did:pkh:eip155:1:${OWNER.address}`;
const DOMAIN = "tinycloud.credentials/account-binding/v1";
const TICKET_DOMAIN = "tinycloud.credentials/holder-binding/v1";

const vectors = await Bun.file(new URL("../../node-sdk/src/credentials/fixtures/held-wire-v2.4/vectors.json", import.meta.url)).json();
/** `holderProof.fixed`: the live-shaped 20-field account binding of the contract, its JCS and the recorded signature. */
const FIXED: Record<string, unknown> = vectors.holderProof.fixed.binding;
const FIXED_JCS: string = vectors.holderProof.fixed.canonicalJcs;

const jcs = (value: unknown): string => {
  const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v);
  return JSON.stringify(sort(value));
};
const bytesOf = (body: string | Uint8Array): Uint8Array => {
  const text = new TextEncoder();
  return body instanceof Uint8Array
    ? Uint8Array.from([...text.encode(DOMAIN), 0, ...body])
    : text.encode(`${DOMAIN}\u0000${body}`);
};
const withField = (patch: Record<string, unknown>) => ({ ...FIXED, ...patch });
const without = (key: string) => Object.fromEntries(Object.entries(FIXED).filter(([k]) => k !== key));

/** A wallet that counts calls. The signer under test must refuse before it is ever called. */
function wallet() {
  const calls = { count: 0 };
  const sign = async (bytes: Uint8Array): Promise<Uint8Array> => {
    calls.count += 1;
    return hexToBytes(await OWNER.signMessage({ message: new TextDecoder().decode(bytes) }));
  };
  return { sign, calls };
}

async function refusal(body: string | Uint8Array): Promise<{ code: unknown; walletCalls: number }> {
  const { sign, calls } = wallet();
  const signer = createAccountHolderSigner(ACCOUNT, sign);
  try {
    await signer.sign(bytesOf(body));
  } catch (error) {
    return { code: error instanceof EmailProofError ? error.code : error, walletCalls: calls.count };
  }
  return { code: "no-throw", walletCalls: calls.count };
}

async function expectRefused(body: string | Uint8Array): Promise<void> {
  expect(await refusal(body)).toEqual({ code: "HOLDER_INVALID", walletCalls: 0 });
}

describe("S16 account signer guard", () => {
  test("control: the contract's fixed binding is signed, once, byte for byte, and equals the recorded signature", async () => {
    const { sign, calls } = wallet();
    const signature = await createAccountHolderSigner(ACCOUNT, sign).sign(bytesOf(FIXED_JCS));
    expect(calls.count).toBe(1);
    expect(`0x${Buffer.from(signature).toString("hex")}`).toBe(vectors.holderProof.fixed.signature);
  });

  test("control: a lowercase holderDid in the binding is the same principal and is signed", async () => {
    const body = jcs(withField({ holderDid: ACCOUNT.toLowerCase() }));
    const { sign, calls } = wallet();
    await createAccountHolderSigner(ACCOUNT, sign).sign(bytesOf(body));
    expect(calls.count).toBe(1);
  });

  test("arbitrary text after the domain prefix is refused", async () => {
    await expectRefused("transfer all of it to mallory");
    await expectRefused(`{"did":"${ACCOUNT}"}`);
  });

  test("a binding for another holder is refused", async () => {
    await expectRefused(jcs(withField({ holderDid: `did:pkh:eip155:1:${OTHER.address}` })));
  });

  test("a ticket-typed body (type = holder-binding/v1) is refused", async () => {
    await expectRefused(jcs(withField({ type: TICKET_DOMAIN })));
  });

  test("a body that is not the exact JCS bytes is refused: pretty-printed, unsorted, duplicate key, escaped", async () => {
    await expectRefused(JSON.stringify(FIXED, null, 2));
    await expectRefused(JSON.stringify(Object.fromEntries(Object.entries(FIXED).reverse())));
    await expectRefused(`${FIXED_JCS.slice(0, -1)},"profileVersion":1}`);
    await expectRefused(FIXED_JCS.replace("tinycloud://credentials", "tinycloud:\\/\\/credentials"));
    await expectRefused(`${FIXED_JCS} `);
  });

  test("another issuer, another issuer kid, another lifetime, another profileVersion, another protocol are refused", async () => {
    await expectRefused(jcs(withField({ issuer: "did:web:evil.example" })));
    await expectRefused(jcs(withField({ issuerKid: "did:web:issuer.credentials.org#other" })));
    await expectRefused(jcs(withField({ credentialLifetimeSeconds: 31536001 })));
    await expectRefused(jcs(withField({ credentialLifetimeSeconds: "31536000" })));
    await expectRefused(jcs(withField({ profileVersion: 2 })));
    await expectRefused(jcs(withField({ protocol: "tinycloud.credentials/acquisition/v2" })));
  });

  test("a jti that is not a lowercase v4 urn:uuid is refused", async () => {
    for (const jti of ["not-a-uuid", "urn:uuid:5F1C9A2E-7B3D-4E8A-9C61-2D4B8E7F0A13", "urn:uuid:5f1c9a2e-7b3d-1e8a-9c61-2d4b8e7f0a13", "urn:uuid:5f1c9a2e-7b3d-4e8a-7c61-2d4b8e7f0a13", "5f1c9a2e-7b3d-4e8a-9c61-2d4b8e7f0a13", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]) {
      await expectRefused(jcs(withField({ jti })));
    }
  });

  test("an extra field, a missing field and the 19-field org-membership shape are refused", async () => {
    await expectRefused(jcs(withField({ extra: "x" })));
    await expectRefused(jcs(without("normalizedClaimsDigest")));
    await expectRefused(jcs(without("credentialLifetimeSeconds")));
  });

  test("a non-UTF-8 body and non-JSON bodies are refused (together, so the test is RED against the prefix-only signer)", async () => {
    const bad = Uint8Array.from([0xff, 0xfe, 0xfd]);
    await expectRefused(bad);
    await expectRefused("{not json");
    await expectRefused("[1,2]");
    await expectRefused("null");
    await expectRefused('"a string"');
    await expectRefused("42");
  });

  test("every other holder-supplied field of the live shape is still checked for type, not trusted: a numeric requestId is refused", async () => {
    await expectRefused(jcs(withField({ requestId: 7 })));
    await expectRefused(jcs(withField({ holderDid: 7 })));
    await expectRefused(jcs(withField({ holderDid: `did:pkh:eip155:137:${OWNER.address}` })));
  });
});

describe("S16 byte-level hardening: framing, strict UTF-8, one copy of the input", () => {
  const enc = new TextEncoder();
  const domainBytes = enc.encode(DOMAIN);
  const jcsBytes = enc.encode(FIXED_JCS);
  const join = (...parts: number[][]): Uint8Array => Uint8Array.from(parts.flat());
  const raw = async (bytes: Uint8Array) => {
    const { sign, calls } = wallet();
    try { await createAccountHolderSigner(ACCOUNT, sign).sign(bytes); } catch (error) { return { code: error instanceof EmailProofError ? error.code : error, walletCalls: calls.count }; }
    return { code: "no-throw", walletCalls: calls.count };
  };

  test("the separator must be exactly one NUL: another byte, or none, is refused", async () => {
    expect(await raw(join([...domainBytes], [0x20], [...jcsBytes]))).toEqual({ code: "HOLDER_INVALID", walletCalls: 0 });
    expect(await raw(join([...domainBytes], [...jcsBytes]))).toEqual({ code: "HOLDER_INVALID", walletCalls: 0 });
    expect(await raw(join([...domainBytes], [0, 0], [...jcsBytes]))).toEqual({ code: "HOLDER_INVALID", walletCalls: 0 });
  });

  test("every byte of the domain is checked: a one-byte change anywhere in it is refused", async () => {
    for (const index of [0, 1, domainBytes.length >> 1, domainBytes.length - 1]) {
      const changed = [...domainBytes];
      changed[index] = changed[index]! ^ 0x01;
      expect([index, await raw(join(changed, [0], [...jcsBytes]))]).toEqual([index, { code: "HOLDER_INVALID", walletCalls: 0 }]);
    }
  });

  test("invalid UTF-8 inside a string value is refused, not replaced: the wallet would sign different bytes than the binding", async () => {
    const at = FIXED_JCS.indexOf("sdk-acquisition");
    const body = [...jcsBytes];
    body[enc.encode(FIXED_JCS.slice(0, at)).length + 3] = 0xff;
    expect(new TextDecoder().decode(Uint8Array.from(body))).toContain("\ufffd");
    expect(await raw(join([...domainBytes], [0], body))).toEqual({ code: "HOLDER_INVALID", walletCalls: 0 });
  });

  test("a BOM after the NUL is refused (the decoder must not strip it): the wallet would otherwise sign bytes that differ from the binding", async () => {
    expect(await raw(join([...domainBytes], [0], [0xef, 0xbb, 0xbf], [...jcsBytes]))).toEqual({ code: "HOLDER_INVALID", walletCalls: 0 });
  });

  test("a hostile Uint8Array whose subarray shows a valid binding while its bytes are other text is refused, and the wallet is not called", async () => {
    class Hostile extends Uint8Array {
      override subarray(begin?: number, end?: number): Uint8Array { return new Uint8Array(jcsBytes).subarray(0, end === undefined ? undefined : end - (begin ?? 0)); }
    }
    const evil = new Hostile([...domainBytes, 0, ...enc.encode("transfer all funds to mallory")]);
    expect(await raw(evil)).toEqual({ code: "HOLDER_INVALID", walletCalls: 0 });
  });

  test("the wallet gets a private copy: a caller that mutates its buffer after the call cannot change what is signed", async () => {
    const original = join([...domainBytes], [0], [...jcsBytes]);
    const bytes = Uint8Array.from(original);
    let seenByWallet: number[] = [];
    const sign = async (b: Uint8Array): Promise<Uint8Array> => {
      await Promise.resolve();
      seenByWallet = [...b];
      return hexToBytes(await OWNER.signMessage({ message: { raw: Uint8Array.from(seenByWallet) } }));
    };
    const pending = createAccountHolderSigner(ACCOUNT, sign).sign(bytes);
    bytes.fill(0);
    await pending;
    expect(seenByWallet).toEqual([...original]);
  });
});
