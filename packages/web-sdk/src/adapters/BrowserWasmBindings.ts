import { IWasmBindings, ISessionManager } from "@tinycloud/sdk-core";
import { tinycloud, tcwSession, initialized } from "@tinycloud/web-sdk-wasm";
import { invoke, invokeAny, prepareSession, completeSessionSetup } from "../modules/Storage/tinycloud/module";

let wasmReady = false;

export class BrowserWasmBindings implements IWasmBindings {
  async ensureInitialized(): Promise<void> {
    if (!wasmReady) {
      await initialized;
      // Set global.tinycloudModule so module.ts helpers (invoke, prepareSession, etc.) work
      (globalThis as any).tinycloudModule = tinycloud;
      wasmReady = true;
    }
  }

  get invoke() { return invoke; }
  get invokeAny() { return invokeAny; }
  get prepareSession() { return prepareSession; }
  get completeSessionSetup() { return completeSessionSetup; }

  ensureEip55(address: string): string { return tinycloud.ensureEip55(address); }
  makeSpaceId(address: string, chainId: number, prefix: string): string {
    return tinycloud.makeSpaceId(address, chainId, prefix);
  }
  createDelegation(
    session: any, delegateDID: string, spaceId: string,
    path: string, actions: string[], expirationSecs: number, notBeforeSecs?: number
  ) { return tinycloud.createDelegation(session, delegateDID, spaceId, path, actions, expirationSecs, notBeforeSecs); }
  generateHostSIWEMessage(params: any): string { return tinycloud.generateHostSIWEMessage(params); }
  siweToDelegationHeaders(params: any) { return tinycloud.siweToDelegationHeaders(params); }
  protocolVersion(): number { return tinycloud.protocolVersion(); }

  // Vault crypto
  vault_encrypt(key: Uint8Array, plaintext: Uint8Array) { return tinycloud.vault_encrypt(key, plaintext); }
  vault_decrypt(key: Uint8Array, blob: Uint8Array) { return tinycloud.vault_decrypt(key, blob); }
  vault_derive_key(salt: Uint8Array, signature: Uint8Array, info: Uint8Array) { return tinycloud.vault_derive_key(salt, signature, info); }
  vault_x25519_from_seed(seed: Uint8Array) { return tinycloud.vault_x25519_from_seed(seed); }
  vault_x25519_dh(privateKey: Uint8Array, publicKey: Uint8Array) { return tinycloud.vault_x25519_dh(privateKey, publicKey); }
  vault_random_bytes(length: number) { return tinycloud.vault_random_bytes(length); }
  vault_sha256(data: Uint8Array) { return tinycloud.vault_sha256(data); }

  createSessionManager(): ISessionManager {
    return new BrowserSessionManager();
  }
}

class BrowserSessionManager implements ISessionManager {
  private inner = new tcwSession.TCWSessionManager();

  createSessionKey(id: string): string { return this.inner.createSessionKey(id); }
  renameSessionKeyId(oldId: string, newId: string): void { this.inner.renameSessionKeyId(oldId, newId); }
  getDID(keyId: string): string { return this.inner.getDID(keyId); }
  jwk(keyId: string): string | undefined { return this.inner.jwk(keyId); }
}
