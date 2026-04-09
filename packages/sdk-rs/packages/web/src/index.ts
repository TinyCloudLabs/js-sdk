import init from "../../../web-sdk-wasm/tinycloud_web_sdk_rs.js";
// @ts-ignore
import wasm from "../../../web-sdk-wasm/tinycloud_web_sdk_rs_bg.wasm";

import * as lib from "../../../web-sdk-wasm/tinycloud_web_sdk_rs.js";

export const initialized: Promise<void> = init(wasm()).then(() =>
  lib.initPanicHook()
);

export namespace tcwSession {
  export import TCWSessionManager = lib.TCWSessionManager;
  export import SiweConfig = lib.SiweConfig;
  export import ExtraFields = lib.ExtraFields;
}

export namespace tinycloud {
  export import completeSessionSetup = lib.completeSessionSetup;
  export import generateHostSIWEMessage = lib.generateHostSIWEMessage;
  export import siweToDelegationHeaders = lib.siweToDelegationHeaders;
  export import invoke = lib.invoke;
  export import invokeAny = lib.invokeAny;
  export import makeSpaceId = lib.makeSpaceId;
  export import prepareSession = lib.prepareSession;
  export import Session = lib.Session;
  export import SessionConfig = lib.SessionConfig;
  export import HostConfig = lib.HostConfig;
  export import ensureEip55 = lib.ensureEip55;
  // Delegation creation
  export import createDelegation = lib.createDelegation;
  // Protocol version
  export import protocolVersion = lib.protocolVersion;
  // Vault crypto
  export import vault_encrypt = lib.vault_encrypt;
  export import vault_decrypt = lib.vault_decrypt;
  export import vault_derive_key = lib.vault_derive_key;
  export import vault_x25519_from_seed = lib.vault_x25519_from_seed;
  export import vault_x25519_dh = lib.vault_x25519_dh;
  export import vault_random_bytes = lib.vault_random_bytes;
  export import vault_sha256 = lib.vault_sha256;
}

// Note: CreateDelegationWasmParams and CreateDelegationWasmResult types are available
// from @tinycloud/sdk-core for TypeScript consumers
