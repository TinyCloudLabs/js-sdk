import { expect, test } from "bun:test";
import {
  BOOTSTRAP_SESSION_REQUESTS,
  bootstrapSpaceId,
  type IWasmBindings,
  type ISessionManager,
  type ISigner,
} from "@tinycloud/sdk-core";
import { NodeUserAuthorization } from "./NodeUserAuthorization";
import { MemorySessionStorage } from "../storage/MemorySessionStorage";

// TC-957: the default bootstrap session request is "widened" with the
// account-registry permissions (space: account). Each permission must be
// signed onto its own space; flattening them under the step's space produced
// `…:default/sql/account`, which the node rightly refuses as a proof for
// `…:account/sql/account`.

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const CHAIN_ID = 1;

function createSessionManager(): ISessionManager {
  const keys = new Map<string, string>();
  const ensureKey = (id: string): string => {
    if (!keys.has(id)) keys.set(id, JSON.stringify({ kty: "OKP", kid: id }));
    return id;
  };
  return {
    createSessionKey: (id: string) => ensureKey(id),
    replaceSessionKey: (jwk: object, keyId: string) => {
      keys.set(keyId, JSON.stringify(jwk));
      return keyId;
    },
    renameSessionKeyId: (_oldId: string, newId: string) => {
      ensureKey(newId);
    },
    getDID: (keyId: string) => `did:key:${keyId}`,
    jwk: (keyId: string) => {
      ensureKey(keyId);
      return keys.get(keyId);
    },
  };
}

function createWasmBindings(captured: Array<Record<string, unknown>>): IWasmBindings {
  const sessionManager = createSessionManager();
  return {
    invoke: async () => undefined,
    prepareSession: (params: Record<string, unknown>) => {
      captured.push(params);
      return {
        siwe: `Issued At: ${String(params.issuedAt)}\nExpiration Time: ${String(params.expirationTime)}`,
        jwk: params.jwk,
        spaceId: params.spaceId,
        verificationMethod: "did:key:verification",
      };
    },
    completeSessionSetup: () => ({
      delegationHeader: { Authorization: "Bearer session" },
      delegationCid: "bafy-session",
    }),
    ensureEip55: (address: string) => address,
    makeSpaceId: (address: string, chainId: number, prefix: string) =>
      `tinycloud:pkh:eip155:${chainId}:${address}:${prefix}`,
    createDelegation: async () => {
      throw new Error("not used");
    },
    generateHostSIWEMessage: () => "",
    siweToDelegationHeaders: () => ({ Authorization: "Bearer host" }),
    protocolVersion: () => 1,
    vault_encrypt: () => new Uint8Array(),
    vault_decrypt: () => new Uint8Array(),
    vault_derive_key: () => new Uint8Array(),
    vault_x25519_from_seed: () => ({ publicKey: new Uint8Array(), privateKey: new Uint8Array() }),
    vault_x25519_dh: () => new Uint8Array(),
    vault_random_bytes: () => new Uint8Array(),
    vault_sha256: () => new Uint8Array(),
    createSessionManager: () => sessionManager,
  };
}

function createSigner(): ISigner {
  return {
    getAddress: async () => ADDRESS,
    getChainId: async () => CHAIN_ID,
    signMessage: async () => "0xsigned",
  };
}

async function prepareBootstrapSession(
  space: "default" | "account",
): Promise<Record<string, unknown>> {
  const captured: Array<Record<string, unknown>> = [];
  const auth = new NodeUserAuthorization({
    signer: createSigner(),
    wasmBindings: createWasmBindings(captured),
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
  });
  // createBootstrapSession needs the signed-in identity; set it the way
  // signIn() does without touching the network.
  Reflect.set(auth, "_address", ADDRESS);
  Reflect.set(auth, "_chainId", CHAIN_ID);
  await auth.createBootstrapSession({
    spaceId: bootstrapSpaceId(ADDRESS, CHAIN_ID, space),
    capabilityRequest: BOOTSTRAP_SESSION_REQUESTS[space],
  });
  expect(captured).toHaveLength(1);
  return captured[0]!;
}

test("the widened default bootstrap session signs account permissions onto the account space (TC-957)", async () => {
  const params = await prepareBootstrapSession("default");
  const defaultSpaceId = bootstrapSpaceId(ADDRESS, CHAIN_ID, "default");
  const accountSpaceId = bootstrapSpaceId(ADDRESS, CHAIN_ID, "account");
  const abilities = params.abilities as Record<string, Record<string, string[]>>;
  const spaceAbilities = params.spaceAbilities as
    | Record<string, Record<string, Record<string, string[]>>>
    | undefined;

  // The step's own (default) space never carries the account-index database
  // or the account-registry KV prefixes.
  expect(abilities.sql?.account).toBeUndefined();
  expect(abilities.kv?.["spaces/"]).toBeUndefined();
  expect(abilities.kv?.["applications/"]).toBeUndefined();
  expect(spaceAbilities?.[defaultSpaceId]?.sql?.account).toBeUndefined();

  // The account-space entries are signed onto the account space.
  expect(spaceAbilities?.[accountSpaceId]?.sql?.account).toEqual(
    expect.arrayContaining(["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"]),
  );
  expect(spaceAbilities?.[accountSpaceId]?.kv?.["spaces/"]).toEqual(
    expect.arrayContaining(["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/list"]),
  );
  expect(spaceAbilities?.[accountSpaceId]?.kv?.["system/bootstrap/complete"]).toEqual(
    expect.arrayContaining(["tinycloud.kv/get", "tinycloud.kv/put"]),
  );
  // The default-space entries stay on the default space.
  expect(abilities.kv?.[""]).toEqual(expect.arrayContaining(["tinycloud.kv/get", "tinycloud.kv/put"]));
  expect(abilities.sql?.[""]).toEqual(expect.arrayContaining(["tinycloud.sql/read", "tinycloud.sql/write"]));
});

test("a single-space bootstrap session request is unchanged (account space)", async () => {
  const params = await prepareBootstrapSession("account");
  const accountSpaceId = bootstrapSpaceId(ADDRESS, CHAIN_ID, "account");
  const abilities = params.abilities as Record<string, Record<string, string[]>>;
  expect(abilities.sql?.account).toEqual(
    expect.arrayContaining(["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"]),
  );
  const spaceAbilities = params.spaceAbilities as
    | Record<string, Record<string, Record<string, string[]>>>
    | undefined;
  if (spaceAbilities !== undefined) {
    expect(Object.keys(spaceAbilities)).toEqual([accountSpaceId]);
  }
});
