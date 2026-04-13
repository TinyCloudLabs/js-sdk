import { afterEach, expect, test } from "bun:test";
import {
  type IWasmBindings,
  type ISessionManager,
  type ISigner,
} from "@tinycloud/sdk-core";
import { NodeUserAuthorization } from "./NodeUserAuthorization";
import { MemorySessionStorage } from "../storage/MemorySessionStorage";

function createSessionManager(): ISessionManager {
  const keys = new Map<string, string>();

  const ensureKey = (id: string): string => {
    if (!keys.has(id)) {
      keys.set(id, JSON.stringify({ kty: "OKP", kid: id }));
    }
    return id;
  };

  return {
    createSessionKey(id: string): string {
      return ensureKey(id);
    },
    renameSessionKeyId(oldId: string, newId: string): void {
      const value = keys.get(oldId);
      if (value) {
        keys.delete(oldId);
        keys.set(newId, value.replace(`"kid":"${oldId}"`, `"kid":"${newId}"`));
      } else {
        ensureKey(newId);
      }
    },
    getDID(keyId: string): string {
      return `did:key:${keyId}`;
    },
    jwk(keyId: string): string | undefined {
      const existing = keys.get(keyId);
      if (existing) {
        return existing;
      }
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
        siwe: [
          `Nonce: ${String(params.nonce ?? "")}`,
          `Issued At: ${String(params.issuedAt)}`,
          `Expiration Time: ${String(params.expirationTime)}`,
        ].join("\n"),
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
      `${prefix}:${chainId}:${address}`,
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

function createSigner(calls: string[]): ISigner {
  return {
    getAddress: async () => "0x1234567890abcdef1234567890abcdef12345678",
    getChainId: async () => 1,
    signMessage: async (message: string) => {
      calls.push(message);
      return "0xsigned";
    },
  };
}

afterEach(() => {
  // Restore the native fetch if a test replaced it.
  if ((globalThis as any).__originalFetch) {
    globalThis.fetch = (globalThis as any).__originalFetch;
    delete (globalThis as any).__originalFetch;
  }
});

test("NodeUserAuthorization.signIn keeps constructor siweConfig.nonce when no per-call nonce is provided", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const signedMessages: string[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as any).__originalFetch = originalFetch;
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/info")) {
      return new Response(
        JSON.stringify({ protocol: 1, version: "1.0.0", features: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return new Response(JSON.stringify({ activated: ["space"], skipped: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const auth = new NodeUserAuthorization({
    signer: createSigner(signedMessages),
    wasmBindings: createWasmBindings(captured),
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
    siweConfig: { nonce: "constructor-nonce" },
  });

  await auth.signIn();

  expect(captured[0]?.nonce).toBe("constructor-nonce");
  expect(signedMessages[0]).toContain("Nonce: constructor-nonce");
});

test("NodeUserAuthorization.signIn lets a per-call nonce override siweConfig.nonce", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const signedMessages: string[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as any).__originalFetch = originalFetch;
  globalThis.fetch = async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith("/info")) {
      return new Response(
        JSON.stringify({ protocol: 1, version: "1.0.0", features: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return new Response(JSON.stringify({ activated: ["space"], skipped: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const auth = new NodeUserAuthorization({
    signer: createSigner(signedMessages),
    wasmBindings: createWasmBindings(captured),
    signStrategy: { type: "auto-sign" },
    domain: "example.com",
    tinycloudHosts: ["https://tinycloud.test"],
    sessionStorage: new MemorySessionStorage(),
    siweConfig: { nonce: "constructor-nonce" },
  });

  await auth.signIn({ nonce: "call-nonce" });

  expect(captured[0]?.nonce).toBe("call-nonce");
  expect(captured[0]?.nonce).not.toBe("constructor-nonce");
  expect(signedMessages[0]).toContain("Nonce: call-nonce");
});
