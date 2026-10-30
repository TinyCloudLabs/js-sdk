import { expect, test } from "bun:test";
import { hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { acquireEmailProof, createEd25519HolderSigner, EmailProofError, type EmailProofProfileId } from "@tinycloud/node-sdk/credentials";
import { createAccountHolderSigner } from "../src/credentials/account-holder";

// Public local-development keys (Hardhat accounts #0 and #1). They are not secrets.
const OWNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const OTHER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ACCOUNT = `did:pkh:eip155:1:${OWNER.address}`;
const DOMAIN = "tinycloud.credentials/account-binding/v1";
const DID_KEY = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const ADDRESS = "alice@example.com";
const sign = async (bytes: Uint8Array) => bytes;

/** Types a fetch implementation as `typeof globalThis.fetch` without a cast: Bun's fetch type includes `preconnect`. */
function asFetch(impl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof globalThis.fetch {
  return Object.assign(impl, { preconnect: () => {} }) as typeof globalThis.fetch;
}

/** Runs `run` and returns the EmailProofError code, the raw error, or "no-throw". */
async function refusedCode(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error instanceof EmailProofError ? error.code : error;
  }
  return "no-throw";
}

function codeOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error instanceof EmailProofError ? error.code : error;
  }
  return "no-throw";
}

/** The wallet's personal_sign over the exact bytes: the one place the EIP-191 prefix is applied in these tests. */
async function personalSign(account: typeof OWNER, bytes: Uint8Array): Promise<Uint8Array> {
  return hexToBytes(await account.signMessage({ message: new TextDecoder().decode(bytes) }));
}

/** A wallet adapter that counts calls and can reshape the signature it returns. */
function wallet(account: typeof OWNER, shape: (signature: Uint8Array) => Uint8Array = (s) => s) {
  const calls = { count: 0 };
  const walletSign = async (bytes: Uint8Array): Promise<Uint8Array> => {
    calls.count += 1;
    return shape(await personalSign(account, bytes));
  };
  return { sign: walletSign, calls };
}

/** Account-binding bytes: the domain, one zero byte, then a non-empty body. */
/** A valid account binding for ACCOUNT: `holderProof.fixed.canonicalJcs` of the TC-2254 contract vectors (938 bytes, JCS). */
const BINDING_BODY = "{\"audience\":\"tinycloud://credentials\",\"challengeNonce\":\"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\",\"completionContext\":\"sdk-acquisition\",\"completionOrigin\":\"https://localhost\",\"credentialLifetimeSeconds\":31536000,\"descriptorDigest\":\"dc3_DuvzipXwYkTfjKqTaK1c3VS0YSPnaBsYSQriC0w\",\"expiresAt\":\"2026-08-03T01:10:00Z\",\"holderDid\":\"did:pkh:eip155:1:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266\",\"issuedAt\":\"2026-08-03T01:00:00Z\",\"issuer\":\"did:web:issuer.credentials.org\",\"issuerKid\":\"did:web:issuer.credentials.org#controller\",\"jti\":\"urn:uuid:5f1c9a2e-7b3d-4e8a-9c61-2d4b8e7f0a13\",\"normalizedClaimsDigest\":\"kyc5jDA7koLzgm-dOmWhfGPXIOTOBmUdrSs-36KJJpc\",\"openerOrigin\":\"https://localhost\",\"profile\":\"tinycloud.email-held/v1\",\"profileVersion\":1,\"protocol\":\"tinycloud.credentials/acquisition/v1\",\"requestId\":\"RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR\",\"requirementDigest\":\"Q_dnVOBsX_7fRjuzLPtCmDe_SKPiXW0Sxv0zSPb_Jd4\",\"type\":\"tinycloud.credentials/account-binding/v1\"}";
function bindingBytes(body: string = BINDING_BODY): Uint8Array {
  return new TextEncoder().encode(`${DOMAIN}\u0000${body}`);
}

function withV(signature: Uint8Array, v: number): Uint8Array {
  const out = new Uint8Array(signature);
  out[64] = v;
  return out;
}

test("account signer is EIP191 with the EIP-55 did and the blockchainAccountId kid", () => {
  const signer = createAccountHolderSigner(ACCOUNT.toLowerCase(), sign);
  expect(signer.alg).toBe("EIP191");
  expect(signer.did).toBe(ACCOUNT);
  expect(signer.kid).toBe(`${ACCOUNT}#blockchainAccountId`);
});

test("signer accepts domain-prefixed bytes, calls the wallet once with the exact bytes, and returns its signature", async () => {
  const { sign: walletSign, calls } = wallet(OWNER);
  const signer = createAccountHolderSigner(ACCOUNT, walletSign);
  const signature = await signer.sign(bindingBytes());
  expect(signature.length).toBe(65);
  expect(calls.count).toBe(1);
  expect(signature).toEqual(await personalSign(OWNER, bindingBytes()));
});

test("signer hands the wallet the very bytes it was given and returns the wallet's own signature object", async () => {
  const message = bindingBytes();
  const signature = await personalSign(OWNER, message);
  const seen: Uint8Array[] = [];
  const signer = createAccountHolderSigner(ACCOUNT, async (bytes) => {
    seen.push(bytes);
    return signature;
  });
  expect(await signer.sign(message)).toBe(signature);
  expect(seen[0]).toBe(message);
});

test("the wallet receives UTF8(domain), one 0x00 byte, then the JCS binding, byte for byte", async () => {
  const jcs = BINDING_BODY;
  const expected = new Uint8Array([...new TextEncoder().encode(DOMAIN), 0x00, ...new TextEncoder().encode(jcs)]);
  const seen: Uint8Array[] = [];
  const signer = createAccountHolderSigner(ACCOUNT, async (bytes) => {
    seen.push(bytes);
    return personalSign(OWNER, bytes);
  });
  await signer.sign(new TextEncoder().encode(`${DOMAIN}\u0000${jcs}`));
  expect(seen[0]).toEqual(expected);
  expect(seen[0]?.[DOMAIN.length]).toBe(0);
});

test("signer refuses every input outside the account-binding domain before the wallet is called", async () => {
  const cases: Record<string, Uint8Array> = {
    "no prefix": new TextEncoder().encode(`{"did":"${ACCOUNT}"}`),
    "wrong prefix": new TextEncoder().encode(`tinycloud.credentials/account-binding/v2\u0000{}`),
    "prefix without separator": new TextEncoder().encode(`${DOMAIN}{"did":"x"}`),
    "empty input": new Uint8Array(0),
    "prefix-only input": new TextEncoder().encode(`${DOMAIN}\u0000`),
  };
  const results: Record<string, unknown> = {};
  for (const [name, bytes] of Object.entries(cases)) {
    const { sign: walletSign, calls } = wallet(OWNER);
    const signer = createAccountHolderSigner(ACCOUNT, walletSign);
    results[name] = [await refusedCode(() => signer.sign(bytes)), calls.count];
  }
  expect(results).toEqual({
    "no prefix": ["HOLDER_INVALID", 0],
    "wrong prefix": ["HOLDER_INVALID", 0],
    "prefix without separator": ["HOLDER_INVALID", 0],
    "empty input": ["HOLDER_INVALID", 0],
    "prefix-only input": ["HOLDER_INVALID", 0],
  });
});

test("signer refuses domain-prefixed bytes whose message is not valid UTF-8, before the wallet is called", async () => {
  const bytes = new Uint8Array([...new TextEncoder().encode(`${DOMAIN}\u0000`), 0xff, 0xfe]);
  const { sign: walletSign, calls } = wallet(OWNER);
  const signer = createAccountHolderSigner(ACCOUNT, walletSign);
  expect([await refusedCode(() => signer.sign(bytes)), calls.count]).toEqual(["HOLDER_INVALID", 0]);
});

test("account signer propagates a wallet rejection", async () => {
  const signer = createAccountHolderSigner(ACCOUNT, async () => {
    throw new Error("wallet rejected");
  });
  await expect(signer.sign(bindingBytes())).rejects.toThrow("wallet rejected");
});

test("account signer refuses anything that is not a did:pkh:eip155 account", () => {
  for (const did of [DID_KEY, "did:pkh:solana:1:abc", "not-a-did"]) {
    expect(codeOf(() => createAccountHolderSigner(did, sign))).toBe("HOLDER_INVALID");
  }
});

test("signer refuses a signature from another key", async () => {
  const signer = createAccountHolderSigner(ACCOUNT, wallet(OTHER).sign);
  expect(await refusedCode(() => signer.sign(bindingBytes()))).toBe("HOLDER_INVALID");
});

test("signer refuses a signature over different bytes", async () => {
  const signer = createAccountHolderSigner(ACCOUNT, async (given) =>
    hexToBytes(await OWNER.signMessage({ message: `${new TextDecoder().decode(given)} substituted` })),
  );
  expect(await refusedCode(() => signer.sign(bindingBytes()))).toBe("HOLDER_INVALID");
});

test("signer refuses 64-byte and 66-byte signatures", async () => {
  const short = createAccountHolderSigner(ACCOUNT, wallet(OWNER, (s) => s.slice(0, 64)).sign);
  const long = createAccountHolderSigner(ACCOUNT, wallet(OWNER, (s) => new Uint8Array([...s, 0])).sign);
  expect({
    short: await refusedCode(() => short.sign(bindingBytes())),
    long: await refusedCode(() => long.sign(bindingBytes())),
  }).toEqual({ short: "HOLDER_INVALID", long: "HOLDER_INVALID" });
});

test("signer accepts v 27 or 28 for the signing key and refuses v 0/1 or a flipped v", async () => {
  const canonical = await personalSign(OWNER, bindingBytes());
  const v = canonical[64] ?? 0;
  const flipped = withV(canonical, v === 27 ? 28 : 27);
  const low = withV(canonical, v - 27);
  const outcome = async (signature: Uint8Array) =>
    refusedCode(() => createAccountHolderSigner(ACCOUNT, async () => signature).sign(bindingBytes()));
  expect({
    canonical: await outcome(canonical),
    v0: await outcome(withV(canonical, 0)),
    v1: await outcome(withV(canonical, 1)),
    flipped: await outcome(flipped),
    low: await outcome(low),
  }).toEqual({ canonical: "no-throw", v0: "HOLDER_INVALID", v1: "HOLDER_INVALID", flipped: "HOLDER_INVALID", low: "HOLDER_INVALID" });
});

test("signer refuses malformed signature bytes (all zero, all 0xff)", async () => {
  const zeros = createAccountHolderSigner(ACCOUNT, async () => new Uint8Array(65));
  const ones = createAccountHolderSigner(ACCOUNT, async () => new Uint8Array(65).fill(0xff));
  expect({
    zeros: await refusedCode(() => zeros.sign(bindingBytes())),
    ones: await refusedCode(() => ones.sign(bindingBytes())),
  }).toEqual({ zeros: "HOLDER_INVALID", ones: "HOLDER_INVALID" });
});

test("signer verifies recovery against a lowercase account did", async () => {
  const signer = createAccountHolderSigner(ACCOUNT.toLowerCase(), wallet(OWNER).sign);
  expect((await signer.sign(bindingBytes())).length).toBe(65);
});

test("signer refuses every owner that is not an Ethereum mainnet account", () => {
  const dids: Record<string, string> = {
    "chain 137": `did:pkh:eip155:137:${OWNER.address}`,
    "chain 0": `did:pkh:eip155:0:${OWNER.address}`,
    "chain 5": `did:pkh:eip155:5:${OWNER.address}`,
    "non-numeric chain": `did:pkh:eip155:one:${OWNER.address}`,
    "did:key": DID_KEY,
    "solana account": "did:pkh:solana:1:abc",
    "not a did": "not-a-did",
  };
  const results: Record<string, unknown> = {};
  for (const [name, did] of Object.entries(dids)) {
    results[name] = codeOf(() => createAccountHolderSigner(did, sign));
  }
  expect(results).toEqual({
    "chain 137": "HOLDER_INVALID",
    "chain 0": "HOLDER_INVALID",
    "chain 5": "HOLDER_INVALID",
    "non-numeric chain": "HOLDER_INVALID",
    "did:key": "HOLDER_INVALID",
    "solana account": "HOLDER_INVALID",
    "not a did": "HOLDER_INVALID",
  });
});

test("email-proof refuses an account holder under the v1 profile before any network call", async () => {
  let calls = 0;
  const fetch = asFetch(async () => {
    calls += 1;
    throw new Error("network must not be reached");
  });
  const holder = createAccountHolderSigner(ACCOUNT, sign);
  const failure = await acquireEmailProof({ address: ADDRESS, holder, fetch }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(EmailProofError);
  expect((failure as EmailProofError).code).toBe("HOLDER_INVALID");
  expect(calls).toBe(0);
});

test("held profile refuses with PROFILE_UNAVAILABLE before any network call, for either holder", async () => {
  let calls = 0;
  const fetch = asFetch(async () => {
    calls += 1;
    throw new Error("network must not be reached");
  });
  const profile: EmailProofProfileId = "tinycloud.email-held/v1";
  const accountHolder = createAccountHolderSigner(ACCOUNT, sign);
  const edHolder = createEd25519HolderSigner(DID_KEY, sign);
  for (const holder of [accountHolder, edHolder]) {
    const failure = await acquireEmailProof({ address: ADDRESS, holder, profile, fetch }).catch((error: unknown) => error);
    expect((failure as EmailProofError).code).toBe("PROFILE_UNAVAILABLE");
  }
  expect(calls).toBe(0);
});

test("a did:key holder that claims EIP191 is refused before any network call", async () => {
  let calls = 0;
  const fetch = asFetch(async () => {
    calls += 1;
    throw new Error("network must not be reached");
  });
  const holder = { did: DID_KEY, alg: "EIP191" as const, kid: `${DID_KEY}#${DID_KEY.slice("did:key:".length)}`, sign };
  const failure = await acquireEmailProof({ address: ADDRESS, holder, fetch }).catch((error: unknown) => error);
  expect((failure as EmailProofError).code).toBe("HOLDER_INVALID");
  expect(calls).toBe(0);
});
