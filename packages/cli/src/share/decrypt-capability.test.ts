import { describe, expect, test } from "bun:test";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { restoredOwnerNode } from "../test-support/restored-owner-node.js";
import { sessionHoldsEncryptionDecrypt } from "./adapters.js";
import type { PermissionEntry } from "@tinycloud/sdk-core";

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

  test("checks exact share keys against signed leaf or share-prefix authority without manifest expansion", async () => {
    const leaf = `${NETWORK_ID}/share/abc123`;
    expect(sessionHoldsEncryptionDecrypt(await nodeWith({ [leaf]: ["tinycloud.encryption/decrypt"] }), leaf)).toBe(true);
    expect(sessionHoldsEncryptionDecrypt(await nodeWith({ [`${NETWORK_ID}/share/`]: ["tinycloud.encryption/decrypt"] }), leaf)).toBe(true);
    for (const [resource, actions] of [
      [NETWORK_ID, ["tinycloud.encryption/decrypt"]],
      [`${NETWORK_ID}/share/sibling`, ["tinycloud.encryption/decrypt"]],
      [`${NETWORK_ID.replace(/:default$/, ":other")}/share/`, ["tinycloud.encryption/decrypt"]],
      [`${NETWORK_ID.replace(ownerDid, "did:pkh:eip155:1:0x1111111111111111111111111111111111111111")}/share/`, ["tinycloud.encryption/decrypt"]],
      [leaf, ["tinycloud.encryption/*"]],
    ] as const) {
      expect(sessionHoldsEncryptionDecrypt(await nodeWith({ [resource]: [...actions] }), leaf)).toBe(false);
    }
    expect(sessionHoldsEncryptionDecrypt(await nodeWith(), leaf)).toBe(false);
  });

  test("does not confuse nested encryption-space authority with a raw key grant", async () => {
    const leaf = `${NETWORK_ID}/share/abc123`;
    const nested = await restoredOwnerNode({
      wasm, signer, sessionKey, sessionDid, spaceId: wasm.makeSpaceId(address, 1, "applications"), host: "https://node.tinycloud.test",
      abilities: { encryption: { [leaf]: ["tinycloud.encryption/decrypt"] } },
    });
    expect(sessionHoldsEncryptionDecrypt(nested, leaf)).toBe(false);
  });

  test("effective runtime decrypt cannot lose caveats, service, or raw-resource scope", () => {
    const leaf = `${NETWORK_ID}/share/abc123`;
    const grant: PermissionEntry = { service: "tinycloud.encryption", space: "encryption", path: `${NETWORK_ID}/share/`, actions: ["tinycloud.encryption/decrypt"] };
    let entries = [grant];
    const authority = {
      getVerifiedSessionCapabilities: () => [],
      getEffectiveRuntimePermissionEntries: () => entries,
    };
    expect(sessionHoldsEncryptionDecrypt(authority, leaf)).toBe(true);
    for (const narrowed of [
      { ...grant, caveats: [{ expires: "soon" }] },
      { ...grant, service: "tinycloud.kv" },
      { ...grant, space: "applications" },
      { ...grant, path: NETWORK_ID },
      { ...grant, actions: ["tinycloud.encryption/network.create"] },
    ]) {
      entries = [narrowed];
      expect(sessionHoldsEncryptionDecrypt(authority, leaf)).toBe(false);
    }
  });
});
