import { expect, test } from "bun:test";
import { acquireEmailProof, createEd25519HolderSigner, EmailProofError, type EmailProofProfileId } from "@tinycloud/node-sdk/credentials";
import { accountBindingSigningBytes, createAccountHolderSigner } from "../src/credentials/account-holder";

const ACCOUNT = "did:pkh:eip155:1:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const DOMAIN = "tinycloud.credentials/account-binding/v1";
const DID_KEY = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const ADDRESS = "alice@example.com";
const sign = async (bytes: Uint8Array) => bytes;

/** Types a fetch implementation as `typeof globalThis.fetch` without a cast: Bun's fetch type includes `preconnect`. */
function asFetch(impl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof globalThis.fetch {
  return Object.assign(impl, { preconnect: () => {} }) as typeof globalThis.fetch;
}

function codeOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error instanceof EmailProofError ? error.code : error;
  }
  return "no-throw";
}

test("binding bytes are domain, one zero byte, then the JCS form of the binding", () => {
  const bytes = accountBindingSigningBytes({ signingDomain: DOMAIN, did: ACCOUNT });
  const text = new TextDecoder().decode(bytes);
  const separator = text.indexOf("\u0000");
  expect(text.slice(0, separator)).toBe(DOMAIN);
  expect(bytes[separator]).toBe(0);
  expect(text.slice(separator + 1)).toBe(`{"did":"${ACCOUNT}","signingDomain":"${DOMAIN}"}`);
});

test("account signer is EIP191 with the EIP-55 did and the blockchainAccountId kid", () => {
  const signer = createAccountHolderSigner(ACCOUNT.toLowerCase(), sign);
  expect(signer.alg).toBe("EIP191");
  expect(signer.did).toBe(ACCOUNT);
  expect(signer.kid).toBe(`${ACCOUNT}#blockchainAccountId`);
});

test("account signer passes bytes through and returns the wallet's result without wrapping", async () => {
  const signature = new Uint8Array(65).fill(7);
  const seen: Uint8Array[] = [];
  const signer = createAccountHolderSigner(ACCOUNT, async (bytes) => {
    seen.push(bytes);
    return signature;
  });
  const message = new Uint8Array([1, 2, 3]);
  expect(await signer.sign(message)).toBe(signature);
  expect(seen[0]).toBe(message);
});

test("account signer propagates a wallet rejection", async () => {
  const signer = createAccountHolderSigner(ACCOUNT, async () => {
    throw new Error("wallet rejected");
  });
  await expect(signer.sign(new Uint8Array([1]))).rejects.toThrow("wallet rejected");
});

test("account signer refuses anything that is not a did:pkh:eip155 account", () => {
  for (const did of [DID_KEY, "did:pkh:solana:1:abc", "not-a-did"]) {
    expect(codeOf(() => createAccountHolderSigner(did, sign))).toBe("HOLDER_INVALID");
  }
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
