import { describe, expect, test } from "bun:test";
import { SiweMessage } from "siwe";
import { hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decodeOwnerRootCacao } from "@tinycloud/share-sdk/share-root";
import { encodeDagCbor, parseSignedSiweCacao } from "./cacao";
import { DELEGATION_MODE_KEY, assertNoDuplicateJsonKeys, extractSiweDelegationMode } from "./terminal";
import { encodeBase64Url } from "../credentials/digest";

const SIGNER = privateKeyToAccount("0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d4b2c197a7e5e7b7");
const RESOURCE = `tinycloud:pkh:eip155:1:${SIGNER.address}:default/kv/test/`;
const BASE_ATT = `{"${RESOURCE}":{"tinycloud.kv/get":[{}]}}`;
const STATEMENT = `I further authorize the stated URI to perform the following actions on my behalf: (1) 'tinycloud.kv': 'get' for '${RESOURCE}'.`;

async function buildSignedCacao(rawRecapJson: string) {
  const recapUri = `urn:recap:${encodeBase64Url(new TextEncoder().encode(rawRecapJson))}`;
  const fields = {
    domain: "app.example",
    address: SIGNER.address,
    statement: STATEMENT,
    uri: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    version: "1",
    chainId: 1,
    nonce: "parity001",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expirationTime: "2026-02-01T00:00:00.000Z",
    resources: [recapUri],
  };
  const siwe = new SiweMessage(fields).prepareMessage();
  const signature = await SIGNER.signMessage({ message: siwe });
  const cacaoBytes = encodeDagCbor({
    h: { t: "eip4361" },
    p: {
      domain: fields.domain,
      iss: `did:pkh:eip155:1:${fields.address}`,
      aud: fields.uri,
      version: 1,
      nonce: fields.nonce,
      iat: fields.issuedAt,
      exp: fields.expirationTime,
      statement: fields.statement,
      resources: fields.resources,
    },
    s: { t: "eip191", s: hexToBytes(signature) },
  });
  return { siwe, cacaoBytes, authorization: encodeBase64Url(cacaoBytes) };
}

describe("ReCap parser parity: sdk-core vs share-sdk (TC-3810)", () => {
  const sharedVectors: Array<{ label: string; json: string; expected: "terminal" | "attenuable" | undefined | "reject" }> = [
    { label: "absent", json: `{"att":${BASE_ATT},"prf":[]}`, expected: undefined },
    { label: "terminal", json: `{"att":${BASE_ATT},"prf":[],"${DELEGATION_MODE_KEY}":"terminal"}`, expected: "terminal" },
    { label: "attenuable", json: `{"att":${BASE_ATT},"prf":[],"${DELEGATION_MODE_KEY}":"attenuable"}`, expected: "attenuable" },
    { label: "null mode", json: `{"att":${BASE_ATT},"prf":[],"${DELEGATION_MODE_KEY}":null}`, expected: "reject" },
    { label: "unknown string mode", json: `{"att":${BASE_ATT},"prf":[],"${DELEGATION_MODE_KEY}":"other"}`, expected: "reject" },
    { label: "uppercase mode", json: `{"att":${BASE_ATT},"prf":[],"${DELEGATION_MODE_KEY}":"Terminal"}`, expected: "reject" },
    { label: "empty string mode", json: `{"att":${BASE_ATT},"prf":[],"${DELEGATION_MODE_KEY}":""}`, expected: "reject" },
    { label: "number mode", json: `{"att":${BASE_ATT},"prf":[],"${DELEGATION_MODE_KEY}":1}`, expected: "reject" },
    { label: "boolean mode", json: `{"att":${BASE_ATT},"prf":[],"${DELEGATION_MODE_KEY}":true}`, expected: "reject" },
    { label: "array mode", json: `{"att":${BASE_ATT},"prf":[],"${DELEGATION_MODE_KEY}":[]}`, expected: "reject" },
    { label: "object mode", json: `{"att":${BASE_ATT},"prf":[],"${DELEGATION_MODE_KEY}":{}}`, expected: "reject" },
    { label: "unknown top-level key", json: `{"att":${BASE_ATT},"prf":[],"extra":1}`, expected: "reject" },
    {
      label: "duplicate key terminal then attenuable",
      json: `{"att":${BASE_ATT},"prf":[],"${DELEGATION_MODE_KEY}":"terminal","${DELEGATION_MODE_KEY}":"attenuable"}`,
      expected: "reject",
    },
    {
      label: "duplicate key attenuable then terminal",
      json: `{"att":${BASE_ATT},"prf":[],"${DELEGATION_MODE_KEY}":"attenuable","${DELEGATION_MODE_KEY}":"terminal"}`,
      expected: "reject",
    },
    {
      label: "duplicate key identical",
      json: `{"att":${BASE_ATT},"prf":[],"${DELEGATION_MODE_KEY}":"terminal","${DELEGATION_MODE_KEY}":"terminal"}`,
      expected: "reject",
    },
    {
      label: "escaped-name duplicate key (escaped second)",
      json: `{"att":${BASE_ATT},"prf":[],"${DELEGATION_MODE_KEY}":"terminal","\\u0078yz.tinycloud.policy/delegationMode":"attenuable"}`,
      expected: "reject",
    },
    {
      label: "escaped-name duplicate key (escaped first)",
      json: `{"att":${BASE_ATT},"prf":[],"\\u0078yz.tinycloud.policy/delegationMode":"terminal","${DELEGATION_MODE_KEY}":"attenuable"}`,
      expected: "reject",
    },
    {
      label: "nested duplicate key in att",
      json: `{"att":{"${RESOURCE}":{"tinycloud.kv/get":[{}],"tinycloud.kv/get":[{}]}},"prf":[]}`,
      expected: "reject",
    },
  ];

  for (const vector of sharedVectors) {
    test(`parity [${vector.label}]`, async () => {
      const { siwe, cacaoBytes, authorization } = await buildSignedCacao(vector.json);

      if (vector.expected === "reject") {
        await expect(parseSignedSiweCacao(authorization)).rejects.toThrow();
        expect(() => extractSiweDelegationMode(siwe)).toThrow();
        expect(() => decodeOwnerRootCacao(cacaoBytes)).toThrow();
        if (vector.label.includes("duplicate")) {
          expect(() => assertNoDuplicateJsonKeys(vector.json)).toThrow(/duplicate/i);
        }
      } else {
        expect(() => assertNoDuplicateJsonKeys(vector.json)).not.toThrow();
        const fromSdkCoreCacao = await parseSignedSiweCacao(authorization);
        const fromSdkCoreSiwe = extractSiweDelegationMode(siwe);
        const fromShareSdk = decodeOwnerRootCacao(cacaoBytes);
        expect(fromSdkCoreCacao.delegationMode).toBe(vector.expected);
        expect(fromSdkCoreSiwe).toBe(vector.expected);
        expect(fromShareSdk.delegationMode).toBe(vector.expected);
      }
    });
  }
});
