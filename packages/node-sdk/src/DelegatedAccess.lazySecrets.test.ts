import { describe, expect, test } from "bun:test";

import type { TinyCloudSession } from "@tinycloud/sdk-core";
import type { DataVaultService, EncryptionService } from "@tinycloud/sdk-services";
import { DelegatedAccess, type DelegatedEncryptionFactory } from "./DelegatedAccess";
import type { PortableDelegation } from "./delegation";

/**
 * `encryption` and `readSecret` load their services from the lazily imported
 * secret-read module: the getter answers synchronously before anything loads,
 * concurrent first uses build one set of services, and a failed load rejects
 * (and is retried) instead of hanging.
 */
const session = {
  address: "0x1204f2e9f634B5A8c09CA1579d351B99B27faE50",
  chainId: 1,
  sessionKey: "cli",
  spaceId: "space:test",
  delegationCid: "bafyreitest-activation-cid",
  delegationHeader: { Authorization: "ucan:session-bound-header" },
  verificationMethod: "did:key:z6Mkk9-session#z6Mkk9",
  jwk: { kty: "OKP", crv: "Ed25519", x: "test-pub" },
  siwe: "",
  signature: "",
} as TinyCloudSession;

const delegation = {
  cid: "bafyreitest-delegation-cid",
  spaceId: "space:test",
  chainId: 1,
  path: "",
  actions: ["tinycloud.kv/get"],
  expiry: new Date(Date.now() + 24 * 3600 * 1000),
  ownerAddress: "0xAAAaAaaAaaAaaAaAAaAaAaaAaAAaAAaAAaAaaAaa",
  delegateDID: "did:pkh:eip155:1:0xAGENT",
} as unknown as PortableDelegation;

const invoke = (() => {
  throw new Error("invoke should not be called in this test");
}) as never;

function countingFactory() {
  const calls = { encryption: 0, vault: 0, discovered: [] as string[], read: [] as string[] };
  const factory: DelegatedEncryptionFactory = {
    encryption: () => {
      calls.encryption += 1;
      return {
        initialize() {},
        discoverNetwork: async (identifier: string) => {
          calls.discovered.push(identifier);
          return { ok: true, data: { networkId: identifier } };
        },
      } as unknown as EncryptionService;
    },
    vault: () => {
      calls.vault += 1;
      return {
        initialize() {},
        readNetworkEncrypted: async (key: string) => {
          calls.read.push(key);
          return { status: "ok", entry: { value: { value: "plaintext", createdAt: "t", updatedAt: "t" } } };
        },
      } as unknown as DataVaultService;
    },
  };
  return { calls, factory };
}

describe("DelegatedAccess lazy secret services", () => {
  test("the encryption getter answers before the module loads and builds nothing", () => {
    const { calls, factory } = countingFactory();
    const access = new DelegatedAccess(session, delegation, "https://node.test", invoke, undefined, undefined, undefined, factory);
    const encryption = access.encryption;
    expect(typeof encryption.decryptEnvelope).toBe("function");
    expect(access.encryption).toBe(encryption);
    expect(calls.encryption).toBe(0);
  });

  test("concurrent first uses load once and build one encryption and one vault", async () => {
    const { calls, factory } = countingFactory();
    const access = new DelegatedAccess(session, delegation, "https://node.test", invoke, undefined, undefined, undefined, factory);
    const [first, second, discovered] = await Promise.all([
      access.readSecret({ name: "API_KEY" }),
      access.readSecret({ name: "OTHER_KEY" }),
      access.encryption.discoverNetwork("urn:tinycloud:encryption:test"),
    ]);
    expect(first).toEqual({ status: "ok", value: "plaintext" });
    expect(second).toEqual({ status: "ok", value: "plaintext" });
    expect(discovered.ok).toBe(true);
    expect(calls).toMatchObject({ encryption: 1, vault: 1, discovered: ["urn:tinycloud:encryption:test"] });
    expect(calls.read).toHaveLength(2);
  });

  test("a failed first use rejects every waiting call and the next call tries again", async () => {
    const access = new DelegatedAccess(session, delegation, "https://node.test", invoke);
    expect(() => access.encryption).toThrow("This delegated access was created without encryption.");
    const failures = await Promise.allSettled([
      access.readSecret({ name: "API_KEY" }),
      access.readSecret({ name: "API_KEY" }),
    ]);
    for (const failure of failures) {
      expect(failure.status).toBe("rejected");
      expect(String((failure as PromiseRejectedResult).reason)).toContain("created without encryption");
    }
    await expect(access.readSecret({ name: "API_KEY" })).rejects.toThrow("created without encryption");
  });
});
