import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomUUID, sign as signEd25519 } from "node:crypto";
import { CredentialError, type IKVService } from "@tinycloud/sdk-core";
import { parseIssuerSet } from "@tinycloud/sdk-core/held-credentials";
import { createEd25519HolderSigner, EmailProofError } from "@tinycloud/node-sdk/credentials";
import { acquireHeldCredential } from "../src/credentials/held-source";
import { storeHeldCredential } from "../src/credentials/held-store";
import { createAccountHolderSigner } from "../src/credentials/account-holder";

const ISSUER_DID = "did:web:issuer.credentials.org";
const KID = `${ISSUER_DID}#controller`;
const PROFILE = "tinycloud.email-held/v1";
const VCT = "opencredentials.email/v1";
const BINDING = "tinycloud.credentials/account-binding/v1";
const DAY = 86_400;
const NOW = new Date("2026-10-20T00:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;
const OWNER_A = "did:pkh:eip155:1:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OWNER_B = "did:pkh:eip155:1:0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DID_KEY = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const EMAIL = "alice@example.com";
const sign = async (bytes: Uint8Array) => bytes;

const issuerKeys = generateKeyPairSync("ed25519");
const issuerPublicKey = (issuerKeys.publicKey.export({ format: "jwk" }) as { x: string }).x;

const POLICY = {
  issuerSet: parseIssuerSet(
    {
      format: "tinycloud.credentials-issuers/v1",
      version: 1,
      issuers: [
        {
          alg: "EdDSA",
          issuerDid: ISSUER_DID,
          kid: KID,
          notAfter: null,
          notBefore: "2025-01-01T00:00:00Z",
          profiles: [PROFILE],
          publicKey: issuerPublicKey,
          retiredAt: null,
          vcts: [VCT],
        },
      ],
    },
    { didMethods: { issuer: ["web"] } },
  ),
  acceptedIssuers: [{ issuerDid: ISSUER_DID }],
  didMethods: { issuer: ["web"] },
};

const enc = (text: string) => Buffer.from(text, "utf8").toString("base64url");

function disclosure(name: string, value: unknown) {
  const text = enc(JSON.stringify([`salt-${name}`, name, value]));
  return { text, digest: createHash("sha256").update(text, "ascii").digest("base64url") };
}

/** Signs a held-shaped SD-JWT for `subject` with the test issuer key. */
function makeSdJwt(subject: string = OWNER_A): string {
  const disclosures = [["email", EMAIL], ["emailDomain", "example.com"]].map(([n, v]) => disclosure(n as string, v));
  const iat = NOW_S - 1000;
  const payload = {
    iss: ISSUER_DID,
    sub: subject,
    iat,
    nbf: iat,
    exp: iat + 365 * DAY,
    jti: `urn:uuid:${randomUUID()}`,
    vct: VCT,
    profile: PROFILE,
    profileVersion: 1,
    holderBinding: { did: subject, signingDomain: BINDING },
    status: { method: "none" },
    _sd_alg: "sha-256",
    _sd: disclosures.map((d) => d.digest),
  };
  const header = { alg: "EdDSA", typ: "vc+sd-jwt", kid: KID };
  const signingInput = `${enc(JSON.stringify(header))}.${enc(JSON.stringify(payload))}`;
  const signature = signEd25519(null, Buffer.from(signingInput, "ascii"), issuerKeys.privateKey);
  return [`${signingInput}.${signature.toString("base64url")}`, ...disclosures.map((d) => d.text)].join("~") + "~";
}

interface FakeKv {
  readonly kv: IKVService;
  readonly data: Map<string, unknown>;
  readonly calls: { batchPut: number; list: number };
}

/** Single-page KV with get, list, batchPut and delete. Records writes and listings. */
function fakeKv(): FakeKv {
  const data = new Map<string, unknown>();
  const calls = { batchPut: 0, list: 0 };
  const kv = {
    async list(opts: { prefix?: string } = {}) {
      calls.list += 1;
      const keys = [...data.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
      return { ok: true, data: { keys, truncated: false, nextCursor: undefined } };
    },
    async get(key: string) {
      if (!data.has(key)) return { ok: false, error: { code: "NOT_FOUND" } };
      return { ok: true, data: { data: data.get(key) } };
    },
    async batchPut(items: Array<{ key: string; value: unknown }>) {
      calls.batchPut += 1;
      for (const item of items) data.set(item.key, item.value);
      return { ok: true };
    },
    async delete(key: string) {
      data.delete(key);
      return { ok: true };
    },
  };
  return { kv: kv as unknown as IKVService, data, calls };
}

/** Typed as fetch without a cast: Bun's fetch type carries `preconnect`. */
function countingFetch(): { fetch: typeof globalThis.fetch; calls: () => number } {
  let count = 0;
  const impl = async () => {
    count += 1;
    throw new Error("network must not be reached");
  };
  return { fetch: Object.assign(impl, { preconnect: () => {} }) as typeof globalThis.fetch, calls: () => count };
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CredentialError || error instanceof EmailProofError) return error.code;
    throw error;
  }
  return "no-throw";
}

const getCode = async () => "000000";

describe("held acquisition refusals happen before network and writes", () => {
  test("a did:key holder is refused ACTIVE_SESSION_REQUIRED with no KV read and no network", async () => {
    const fake = fakeKv();
    const net = countingFetch();
    const holder = createEd25519HolderSigner(DID_KEY, sign);
    const code = await codeOf(() => acquireHeldCredential({ ...POLICY, kv: fake.kv, address: EMAIL, holder, getCode, fetch: net.fetch }));
    expect(code).toBe("ACTIVE_SESSION_REQUIRED");
    expect(fake.calls.list).toBe(0);
    expect(net.calls()).toBe(0);
  });

  test("a session account other than the holder is refused HOLDER_MISMATCH with no network", async () => {
    const fake = fakeKv();
    const net = countingFetch();
    const holder = createAccountHolderSigner(OWNER_A, sign);
    const code = await codeOf(() =>
      acquireHeldCredential({ ...POLICY, kv: fake.kv, address: EMAIL, holder, sessionDid: OWNER_B, getCode, fetch: net.fetch }),
    );
    expect(code).toBe("HOLDER_MISMATCH");
    expect(net.calls()).toBe(0);
  });

  test("a session account that differs only in address case is the same principal, not a mismatch", async () => {
    const fake = fakeKv();
    const net = countingFetch();
    const holder = createAccountHolderSigner(OWNER_A, sign);
    const code = await codeOf(() =>
      acquireHeldCredential({ ...POLICY, kv: fake.kv, address: EMAIL, holder, sessionDid: OWNER_A.toLowerCase(), getCode, fetch: net.fetch, now: () => NOW }),
    );
    expect(code).toBe("PROFILE_UNAVAILABLE");
    expect(net.calls()).toBe(0);
  });

  test("a cache miss for an account goes to the held profile and is refused PROFILE_UNAVAILABLE with no network and no write", async () => {
    const fake = fakeKv();
    const net = countingFetch();
    const holder = createAccountHolderSigner(OWNER_A, sign);
    const code = await codeOf(() =>
      acquireHeldCredential({ ...POLICY, kv: fake.kv, address: EMAIL, holder, getCode, fetch: net.fetch, now: () => NOW }),
    );
    expect(code).toBe("PROFILE_UNAVAILABLE");
    expect(net.calls()).toBe(0);
    expect(fake.calls.batchPut).toBe(0);
  });
});

describe("held reuse is owner-scoped and returns stored verified records without network", () => {
  test("a stored verified credential is returned with its verified expiry and no network", async () => {
    const fake = fakeKv();
    const sdJwt = makeSdJwt(OWNER_A);
    await storeHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, sdJwt, now: NOW, ...POLICY });
    const net = countingFetch();
    const holder = createAccountHolderSigner(OWNER_A, sign);
    const result = await acquireHeldCredential({ ...POLICY, kv: fake.kv, address: EMAIL, holder, getCode, fetch: net.fetch, now: () => NOW });
    expect(result.credential).toBe(sdJwt);
    expect(result.holderDid).toBe(OWNER_A);
    expect(result.expiresAt.getTime()).toBe((NOW_S - 1000 + 365 * DAY) * 1000);
    expect(net.calls()).toBe(0);
  });

  test("the email lookup is case-insensitive", async () => {
    const fake = fakeKv();
    const sdJwt = makeSdJwt(OWNER_A);
    await storeHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, sdJwt, now: NOW, ...POLICY });
    const holder = createAccountHolderSigner(OWNER_A, sign);
    const result = await acquireHeldCredential({ ...POLICY, kv: fake.kv, address: "ALICE@Example.com", holder, getCode, now: () => NOW });
    expect(result.credential).toBe(sdJwt);
  });

  test("another account's stored credential is not returned to a different holder", async () => {
    const fake = fakeKv();
    await storeHeldCredential({ kv: fake.kv, ownerDid: OWNER_A, sdJwt: makeSdJwt(OWNER_A), now: NOW, ...POLICY });
    const net = countingFetch();
    const holder = createAccountHolderSigner(OWNER_B, sign);
    const code = await codeOf(() =>
      acquireHeldCredential({ ...POLICY, kv: fake.kv, address: EMAIL, holder, getCode, fetch: net.fetch, now: () => NOW }),
    );
    expect(code).toBe("PROFILE_UNAVAILABLE");
    expect(net.calls()).toBe(0);
  });
});
