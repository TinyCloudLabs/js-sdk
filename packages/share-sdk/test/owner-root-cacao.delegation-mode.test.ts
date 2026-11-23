import { describe, expect, it } from "bun:test";
import { OWNER_DID, cbor, recapResource } from "./support/fake-owner.js";
import { decodeOwnerRootCacao } from "../src/share-root-entry.js";

describe("decodeOwnerRootCacao delegationMode validation (TC-3810)", () => {
  const valid = {
    h: { t: "eip4361" },
    p: {
      domain: "d",
      iss: OWNER_DID,
      aud: "did:key:z",
      version: 1,
      nonce: "n",
      iat: new Date().toISOString(),
      resources: [recapResource({ att: {}, prf: [] })],
    },
    s: { t: "eip191", s: new Uint8Array(65) },
  };
  const rawRecap = (json: string) => `urn:recap:${Buffer.from(json, "utf8").toString("base64url")}`;

  it("accepts absent, terminal, and attenuable delegationMode", () => {
    const absent = decodeOwnerRootCacao(Uint8Array.from(cbor(valid)));
    expect(absent.delegationMode).toBeUndefined();
    expect("delegationMode" in absent).toBe(false);

    for (const mode of ["terminal", "attenuable"] as const) {
      const body = {
        ...valid,
        p: {
          ...valid.p,
          resources: [recapResource({ att: {}, prf: [], "xyz.tinycloud.policy/delegationMode": mode })],
        },
      };
      const decoded = decodeOwnerRootCacao(Uint8Array.from(cbor(body)));
      expect(decoded.delegationMode).toBe(mode);
    }
  });

  it("refuses null, unknown strings, and non-string values for delegationMode", () => {
    for (const bad of [null, "Terminal", "legacy", "", 1, true, [], {}]) {
      const body = {
        ...valid,
        p: {
          ...valid.p,
          resources: [recapResource({ att: {}, prf: [], "xyz.tinycloud.policy/delegationMode": bad })],
        },
      };
      expect(() => decodeOwnerRootCacao(Uint8Array.from(cbor(body)))).toThrow(/delegationMode/);
    }
  });

  it("refuses duplicate and escaped-name duplicate keys and other unknown top-level fields", () => {
    const dupCases = [
      '{"att":{},"prf":[],"xyz.tinycloud.policy/delegationMode":"terminal","xyz.tinycloud.policy/delegationMode":"attenuable"}',
      '{"att":{},"prf":[],"xyz.tinycloud.policy/delegationMode":"attenuable","xyz.tinycloud.policy/delegationMode":"terminal"}',
      '{"att":{},"prf":[],"xyz.tinycloud.policy/delegationMode":"terminal","xyz.tinycloud.policy/delegationMode":"terminal"}',
      '{"att":{},"prf":[],"\\u0078yz.tinycloud.policy/delegationMode":"terminal","xyz.tinycloud.policy/delegationMode":"attenuable"}',
      '{"att":{},"prf":[],"xyz.tinycloud.policy/delegationMode":"terminal","\\u0078yz.tinycloud.policy/delegationMode":"attenuable"}',
      '{"att":{"r":{"a/b":[{}]},"r":{"a/b":[{}]}},"prf":[]}',
    ];
    for (const raw of dupCases) {
      const body = { ...valid, p: { ...valid.p, resources: [rawRecap(raw)] } };
      expect(() => decodeOwnerRootCacao(Uint8Array.from(cbor(body)))).toThrow(/duplicate/i);
    }

    const unknown = { ...valid, p: { ...valid.p, resources: [recapResource({ att: {}, prf: [], extra: true })] } };
    expect(() => decodeOwnerRootCacao(Uint8Array.from(cbor(unknown)))).toThrow("ReCap has an unknown field");
  });
});
