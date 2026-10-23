import { describe, expect, test } from "bun:test";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { restoredOwnerNode } from "../test-support/restored-owner-node.js";
import { sessionHoldsEncryptionDecrypt } from "./adapters.js";

// Real restored sessions, not a mocked hasRuntimePermissions: the check must agree with how the SDK
// represents raw encryption authority in a signed recap.
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const wasm = new NodeWasmBindings();
const address = await signer.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const spaceId = wasm.makeSpaceId(address, 1, "default");
const manager = wasm.createSessionManager();
const sessionKey = JSON.parse(manager.jwk("default")!);
const sessionDid = manager.getDID("default");
const NETWORK_ID = `urn:tinycloud:encryption:${ownerDid}:default`;
const sharesKv = { kv: { "shares/": ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/metadata"] } };

const nodeWith = (rawAbilities?: Record<string, string[]>) =>
  restoredOwnerNode({ wasm, signer, sessionKey, sessionDid, spaceId, host: "https://node.tinycloud.test", abilities: sharesKv, ...(rawAbilities === undefined ? {} : { rawAbilities }) });

describe("sessionHoldsEncryptionDecrypt (real restored session)", () => {
  test("is true for a session whose recap signs decrypt on the owner's encryption network", async () => {
    const node = await nodeWith({ [NETWORK_ID]: ["tinycloud.encryption/decrypt"] });
    expect(sessionHoldsEncryptionDecrypt(node, NETWORK_ID)).toBe(true);
  });

  test("is false for the same recap without decrypt, and for decrypt on another network", async () => {
    expect(sessionHoldsEncryptionDecrypt(await nodeWith(), NETWORK_ID)).toBe(false);
    const other = `urn:tinycloud:encryption:${ownerDid}:other`;
    expect(sessionHoldsEncryptionDecrypt(await nodeWith({ [other]: ["tinycloud.encryption/decrypt"] }), NETWORK_ID)).toBe(false);
  });
});
