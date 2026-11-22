import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { verify, type Collateral } from "@phala/dcap-qvl";
import {
  PUBLISHED_TRUST,
  TeeVerifyRefused,
  jwkThumbprint,
  openkeyIdentity,
  verifyAttestation,
  type RefusalCode,
  type Trust,
  type VerifyOptions,
} from "../src/index.js";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const json = <T>(name: string): T => JSON.parse(readFileSync(fixture(name), "utf8")) as T;

// tinycloud-node 1.26.19 on dstack-dev-0.5.15, recorded 2026-11-22T13:13:10Z (fixtures/README.md).
const response = json<Record<string, string>>("node-dev-os-attestation.json");
const collateral = json<Collateral>("node-dev-os-collateral.json");
const NONCE = "ad9077d2ad7b1ee0df0cf481f13ecffa";
const DID = "did:key:z6MkjHi79SMX4doJyo2w7jDTM6Fa7iX6EVZWXNbJ6RzBm3Wi";
// Phala's `phala` KMS root key (ca_pubkey of kc_aOwADKBd per `phala api /kms`, 2026-11-22), P-256 SPKI.
const KMS_ID =
  "3059301306072a8648ce3d020106082a8648ce3d03010703420004e8e325a477b0bf22800dc927a46c68638938d283fe73d1f9028eeac7028193f3470122193875f598b7addc503e534712ab437b4120776bbac32ddf8897f844ee";
const AT = new Date("2026-11-22T13:16:00Z");

/** Test-only lists that accept the recorded dev CVM, to exercise every check past the OS one. */
const DEV_AS_PRODUCTION: Trust = {
  osImages: [
    {
      name: "dstack-dev-0.5.15 (test only)",
      osImageHash: "432b8a1e82ec8a90b3d30bb201e5d20a8bc5c05b69f1d8ba13687232dda5aebd",
      mrtd: "20038376b145055508e1a8538a864857e8180f989ea8aac4954d432c494872aa48e6946b381fe6bb28d8b9e703ed65d3",
      rtmr0: "027b610ab0555482f8a3868524093bdf3cdbe2539f81dfeeb886864654cb2fe3422f7fc36d4bab6fa46683aad11d1ba7",
      rtmr1: "786417fa26b5d90d1289025506055e511ff09fd608f4727bb3cf159279a52af23117b6248024d0b186aceabebf6f86ec",
      rtmr2: "ab05769ea761be4c000e003eab0fa47ef1cbc174ba501364e5145f1d09f8db3b6764e2387b375bc6d5af4a17aa30f913",
    },
  ],
  refusedOsImages: [],
  releases: PUBLISHED_TRUST.releases,
};

const options = (overrides: Partial<VerifyOptions> = {}): VerifyOptions => ({
  service: "tinycloud-node",
  nonce: NONCE,
  identity: DID,
  now: AT,
  collateral,
  ...overrides,
});

async function refusal(input: unknown, opts: VerifyOptions): Promise<{ code: RefusalCode; message: string }> {
  try {
    await verifyAttestation(input, opts);
  } catch (error) {
    if (error instanceof TeeVerifyRefused) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("verified, expected a refusal");
}

describe("recorded node quote", () => {
  test("the dev-OS node is refused against the published lists", async () => {
    expect(await refusal(response, options())).toEqual({
      code: "os",
      message: "OS image dstack-dev-0.5.15 (432b8a1e…) is not a production image: dev image: the host can log in to it",
    });
  });

  test("an OS image absent from the published list is refused even when not named as dev", async () => {
    const trust = { ...PUBLISHED_TRUST, refusedOsImages: [] };
    expect((await refusal(response, options({ trust }))).code).toBe("os");
  });

  test("with its image trusted, the quote verifies and reports the measured identity", async () => {
    expect(await verifyAttestation(response, options({ trust: DEV_AS_PRODUCTION }))).toEqual({
      service: "tinycloud-node",
      version: "1.26.19",
      osImage: { name: "dstack-dev-0.5.15 (test only)", hash: "432b8a1e82ec8a90b3d30bb201e5d20a8bc5c05b69f1d8ba13687232dda5aebd" },
      appId: "350d124c81d53a57e8899e9f85a904918e663b61",
      composeHash: "1dc2fe4a207c340c9cfb312ffa7af0725774d23671e5b553c3b4398f63e5ad68",
      keyProvider: { name: "kms", id: KMS_ID },
      identity: DID,
      tcbStatus: "UpToDate",
    });
  });

  test("an unknown compose hash is refused", async () => {
    const trust = { ...DEV_AS_PRODUCTION, releases: [] };
    expect(await refusal(response, options({ trust }))).toEqual({
      code: "release",
      message: "compose hash 1dc2fe4a… of app 350d124c81d53a57e8899e9f85a904918e663b61 is not a released tinycloud-node version",
    });
  });

  test("a release pinned for another app ID is refused", async () => {
    const trust = { ...DEV_AS_PRODUCTION, releases: [{ ...DEV_AS_PRODUCTION.releases[0]!, appId: "0".repeat(39) + "1" }] };
    expect((await refusal(response, options({ trust }))).code).toBe("release");
  });

  test("keys from a KMS other than the release's are refused", async () => {
    // The release pins another root key: as if the host had booted the CVM against its own KMS.
    const pinned = `${KMS_ID.slice(0, -4)}0000`;
    const trust = { ...DEV_AS_PRODUCTION, releases: [{ ...DEV_AS_PRODUCTION.releases[0]!, keyProviderId: pinned }] };
    const refused = await refusal(response, options({ trust }));
    expect(refused.code).toBe("kms");
    expect(refused.message).toStartWith(`keys came from key provider {"name":"kms","id":"${KMS_ID.slice(0, 40)}`);
    expect(refused.message).toEndWith(`not 1.26.19's kms ${pinned.slice(0, 8)}…`);
  });

  test("an event log that claims another KMS does not replay to RTMR3", async () => {
    const events = JSON.parse(response.event_log!) as { event: string; event_payload: string }[];
    const rogue = JSON.stringify({ name: "kms", id: `${KMS_ID.slice(0, -4)}0000` });
    for (const e of events) if (e.event === "key-provider") e.event_payload = Buffer.from(rogue).toString("hex");
    expect(await refusal({ ...response, event_log: JSON.stringify(events) }, options({ trust: DEV_AS_PRODUCTION }))).toEqual({
      code: "event-log",
      message: "event log does not replay to the quote's RTMR3",
    });
  });

  test("an event name with ':' and a non-string digest are refused", async () => {
    const events = JSON.parse(response.event_log!) as { event: string; digest: unknown }[];
    const colon = events.map((e) => (e.event === "storage-fs" ? { ...e, event: "storage:fs" } : e));
    expect((await refusal({ ...response, event_log: JSON.stringify(colon) }, options({ trust: DEV_AS_PRODUCTION }))).message).toMatch(/has a ':' in its name/);
    const numeric = events.map((e) => (e.event === "storage-fs" ? { ...e, digest: 1 } : e));
    expect((await refusal({ ...response, event_log: JSON.stringify(numeric) }, options({ trust: DEV_AS_PRODUCTION }))).message).toMatch(/has no digest/);
  });

  test("OS measurements that differ from the pinned ones are refused", async () => {
    const trust = { ...DEV_AS_PRODUCTION, osImages: [{ ...DEV_AS_PRODUCTION.osImages[0]!, rtmr0: "11".repeat(48) }] };
    expect((await refusal(response, options({ trust }))).code).toBe("os");
  });

  test("another nonce or another signer does not match the binding", async () => {
    expect((await refusal(response, options({ nonce: "ffffffffffffffffffffffffffffffff" }))).code).toBe("binding");
    expect((await refusal(response, options({ identity: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" }))).code).toBe("binding");
  });

  test("a response whose binding names a different signer than enforcer_did is refused", async () => {
    expect((await refusal({ ...response, enforcer_did: "did:key:other" }, options())).code).toBe("identity");
  });

  test("a changed quote byte fails Intel's signature", async () => {
    const quote = response.quote!;
    const flipped = quote.slice(0, 400) + (quote[400] === "0" ? "1" : "0") + quote.slice(401);
    expect((await refusal({ ...response, quote: flipped }, options({ trust: DEV_AS_PRODUCTION }))).code).toBe("quote");
  });

  test("collateral past its validity is refused", async () => {
    expect((await refusal(response, options({ now: new Date("2030-01-01T00:00:00Z") }))).code).toBe("quote");
  });

  test("an event log that claims another compose hash does not replay to RTMR3", async () => {
    const events = JSON.parse(response.event_log!) as { event: string; event_payload: string }[];
    for (const e of events) if (e.event === "compose-hash") e.event_payload = "00".repeat(32);
    const tampered = { ...response, event_log: JSON.stringify(events), compose_hash: "00".repeat(32) };
    expect(await refusal(tampered, options({ trust: DEV_AS_PRODUCTION }))).toEqual({
      code: "event-log",
      message: "event log does not replay to the quote's RTMR3",
    });
  });

  test("a compose_hash field that differs from the measured one is refused", async () => {
    expect((await refusal({ ...response, compose_hash: "00".repeat(32) }, options({ trust: DEV_AS_PRODUCTION }))).code).toBe("response");
  });

  test("a non-TEE answer and a short nonce are refused before any quote check", async () => {
    expect((await refusal({ mode: "classic", message: "not in a TEE" }, options())).code).toBe("mode");
    expect((await refusal(response, options({ nonce: "abc" }))).code).toBe("nonce");
  });

  test("a node quote does not pass as OpenKey's, even naming the same signer", async () => {
    expect((await refusal({ ...response, identity: DID }, options({ service: "openkey" }))).code).toBe("binding");
  });
});

describe("OpenKey identity", () => {
  const okp = { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo", kid: "a", alg: "EdDSA", use: "sig" };
  const ec = { kty: "EC", crv: "P-256", x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0", kid: "b" };
  // RFC 7638 §3.1 example key.
  const rsa = {
    kty: "RSA",
    n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
    e: "AQAB",
    alg: "RS256",
    kid: "2011-04-29",
  };

  test("thumbprints match RFC 7638 and jose's calculateJwkThumbprint", () => {
    expect(jwkThumbprint(rsa)).toBe("NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs");
    expect(jwkThumbprint(okp)).toBe("kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
    expect(jwkThumbprint(ec)).toBe("oKIywvGUpTVTyxMQ3bwIIeQUudfr_CkLMjCE19ECD-U");
  });

  test("identity is the issuer and its keys' thumbprints, deduplicated and sorted", () => {
    expect(openkeyIdentity("https://api.openkey.so/api/auth", { keys: [rsa, okp, ec, { ...okp, kid: "c" }] })).toBe(
      "https://api.openkey.so/api/auth#NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs,kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k,oKIywvGUpTVTyxMQ3bwIIeQUudfr_CkLMjCE19ECD-U",
    );
    expect(() => openkeyIdentity("https://api.openkey.so/api/auth", { keys: [] })).toThrow(TeeVerifyRefused);
  });
});

// Public Intel-rooted sample from Phala-Network/dcap-qvl v0.7.0 (fixtures/README.md).
test("the pinned DCAP library verifies the upstream sample and rejects a changed byte and expired collateral", () => {
  const quote = readFileSync(fixture("upstream/tdx_quote"));
  const upstream = json<Collateral>("upstream/tdx_quote_collateral.json");
  const at = 1752552000;
  expect(verify(quote, upstream, at).status).toBe("UpToDate");
  const changed = Buffer.from(quote);
  changed[200] = changed[200]! ^ 1;
  expect(() => verify(changed, upstream, at)).toThrow();
  expect(() => verify(quote, upstream, 2000000000)).toThrow();
});
