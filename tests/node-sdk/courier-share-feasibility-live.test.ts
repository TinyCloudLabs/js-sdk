/**
 * TC-2234 feasibility gate, option (a), NODE SIDE ONLY. A session-only `did:key`
 * (a SIWE/CACAO session whose session key is a Courier-shaped agent key, signed
 * locally by a synthetic owner wallet with raw `key.create` + `decrypt` abilities
 * injected on `<network>/share/`) creates the `share/<shareId>` named key and
 * registers the path-bound, digested Policy/v3 policy on a real local Node.
 *
 * This proves the Node accepts that delegated did:key with that HYPOTHETICAL
 * grant. It does NOT prove that the current OpenKey `/delegate` route can issue
 * `key.create` on `share/` to a Courier key (the TC-2234 source notes say it
 * refuses it); that needs a separate Sam card and Naomi security review.
 *
 *   TC_TEST_SERVER=http://127.0.0.1:<port> bun test courier-share-feasibility-live.test.ts
 *
 * Node: built from a head containing #481 and final #485, started with
 * `TINYCLOUD_ENCRYPTION_NETWORK__NAMED_KEYS_V1=true` plus a deletion ledger.
 * Synthetic identities only; no key material is logged.
 */
import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha256";
import { NodeWasmBindings, PrivateKeySigner, TinyCloudNode, type TinyCloudNodeConfig } from "@tinycloud/node-sdk";
import { activateSessionWithHost } from "@tinycloud/sdk-core";
import { base64Decode, hexEncode } from "@tinycloud/sdk-services";
import { canonicalize } from "@tinycloud/share-envelope";
import { prepareAddressedShare, publishAddressedShare } from "@tinycloud/share-sdk";
import { Wallet } from "ethers";
import { AGENT_GRANT } from "../../packages/courier/src/keys";
import { assertAgentGrant, siweTimes } from "../../packages/courier/src/authority";
import { checkServerHealth, SERVER_URL } from "./setup";

setDefaultTimeout(60_000);

const KEY_CREATE = "tinycloud.encryption/key.create";
const DECRYPT = "tinycloud.encryption/decrypt";
const DAY = 86_400_000;
const wasm = new NodeWasmBindings();
const wallet = new PrivateKeySigner(Wallet.createRandom().privateKey.slice(2));

const nodeConfig = (extra: Partial<TinyCloudNodeConfig> = {}) => new TinyCloudNode({
  host: SERVER_URL, autoBootstrapAccount: false, tinycloudFallbackHosts: [SERVER_URL], autoDiscoverLocalNode: false,
  enablePublicSpace: false, includeAccountRegistryPermissions: false, domain: "courier.test", signer: wallet, ...extra,
});

let ownerNode: TinyCloudNode;
let nodeDid: string;
let defaultNetwork: string;

interface CourierSession { node: TinyCloudNode; spaceId: string; did: string; siwe: string; }

/** Mint a Courier-shaped grant to a fresh agent key and restore it as a session-only node. */
async function courierSession(extra: Record<string, string[]>): Promise<CourierSession> {
  const manager = wasm.createSessionManager();
  const keyId = manager.createSessionKey("courier");
  const jwk = JSON.parse(manager.jwk(keyId)!) as Record<string, unknown>;
  const agentDid = manager.getDID(keyId);
  const address = await wallet.getAddress();
  const chainId = 1;
  const spaceId = wasm.makeSpaceId(address, chainId, "agents");
  const abilities: Record<string, Record<string, string[]>> = {};
  for (const permission of AGENT_GRANT) {
    const service = permission.service.replace(/^tinycloud\./, "");
    (abilities[service] ??= {})[permission.path] = permission.actions;
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * DAY);
  const prepared = wasm.prepareSession({
    abilities, ...(Object.keys(extra).length > 0 ? { rawAbilities: extra } : {}),
    address, chainId, domain: "courier.fake-openkey", issuedAt: now.toISOString(), expirationTime: expiresAt.toISOString(), spaceId, jwk,
  });
  const signature = await wallet.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const activated = await activateSessionWithHost(SERVER_URL, session.delegationHeader);
  if (!activated.success) throw new Error(`delegation activation failed: ${activated.error}`);
  const node = new TinyCloudNode({
    host: SERVER_URL, tinycloudFallbackHosts: [SERVER_URL], autoDiscoverLocalNode: false,
    enablePublicSpace: false, autoBootstrapAccount: false, includeAccountRegistryPermissions: false,
  });
  await node.restoreSession({
    delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, spaceId, jwk, verificationMethod: agentDid,
    address, chainId, siwe: prepared.siwe, signature, expiresAt: expiresAt.toISOString(), tinycloudHosts: [SERVER_URL],
  });
  expect(node.isSessionOnly).toBe(true);
  expect(node.credentialHolderDid).toBe(agentDid.split("#", 1)[0]);
  return { node, spaceId, did: node.credentialHolderDid, siwe: prepared.siwe };
}

const errorText = (error: unknown) => String(error instanceof Error ? error.message : JSON.stringify(error)).slice(0, 240);
const newShareId = () => crypto.randomUUID().replaceAll("-", "");

beforeAll(async () => {
  await checkServerHealth();
  nodeDid = (await (await fetch(`${SERVER_URL}/info`)).json() as { nodeId: string }).nodeId;
  // Fixture only: the owner needs network.create once to host the default encryption network.
  const ownerNetwork = `urn:tinycloud:encryption:did:pkh:eip155:1:${await wallet.getAddress()}:default`;
  ownerNode = nodeConfig({
    autoCreateSpace: true,
    manifest: { app_id: "xyz.tinycloud.courier", name: "Courier disposable owner", space: "agents", prefix: "xyz.tinycloud.courier", defaults: false, includePublicSpace: false, expiry: "2h",
      permissions: [
        { service: "tinycloud.kv", path: "/", actions: ["get", "put", "list", "del", "metadata"] },
        { service: "tinycloud.encryption", path: ownerNetwork, actions: ["network.create"], skipPrefix: true },
      ] },
  });
  await ownerNode.signIn();
  defaultNetwork = ownerNode.getDefaultEncryptionNetworkId();
  await ownerNode.ensureEncryptionNetwork("default");
}, 120_000);

describe("delegated Courier did:key as Share policy owner", () => {
  test("RED baseline: the current AGENT_GRANT has no key.create, so the share key cannot be created", async () => {
    const legacy = await courierSession({});
    const attempt = await legacy.node.keys.createKey(`share/${newShareId()}`).then(() => "created", errorText);
    console.log("[feasibility] baseline createKey:", attempt);
    expect(attempt).not.toBe("created");
  });

  test("an install made before this change (exact AGENT_GRANT, no encryption entries) still restores and still works", async () => {
    const legacy = await courierSession({});
    const ownerDid = `did:pkh:eip155:1:${await wallet.getAddress()}`;
    expect(() => assertAgentGrant(legacy.node.getVerifiedSessionCapabilities(), siweTimes(legacy.siwe), Date.now(), ownerDid)).not.toThrow();
    expect(() => assertAgentGrant(legacy.node.getVerifiedSessionCapabilities(), siweTimes(legacy.siwe))).not.toThrow();
    const path = `xyz.tinycloud.courier/to/legacy/threads/${newShareId()}/msg/m.json`;
    expect((await legacy.node.kv.put(path, new TextEncoder().encode("{}"))).ok).toBe(true);
    expect((await legacy.node.kv.get(path)).ok).toBe(true);
    // Outside its grant it still has nothing.
    expect((await legacy.node.kv.put("xyz.tinycloud.courier/me/approvals/x.json", new TextEncoder().encode("{}"))).ok).toBe(false);
  });

  test("the real restored authority of an exact invitation-key grant passes the additive Courier check only for its owner", async () => {
    const courier = await courierSession({ [`${defaultNetwork}/share/${newShareId()}`]: [KEY_CREATE, DECRYPT] });
    const ownerDid = `did:pkh:eip155:1:${await wallet.getAddress()}`;
    const capabilities = courier.node.getVerifiedSessionCapabilities();
    expect(() => assertAgentGrant(capabilities, siweTimes(courier.siwe), Date.now(), ownerDid)).not.toThrow();
    expect(() => assertAgentGrant(capabilities, siweTimes(courier.siwe), Date.now(), "did:pkh:eip155:1:0x1111111111111111111111111111111111111111")).toThrow();
    expect(() => assertAgentGrant(capabilities, siweTimes(courier.siwe))).toThrow();
  });

  test("delegated Courier key creates share/<id> and registers the path-bound digested policy", async () => {
    const courier = await courierSession({ [`${defaultNetwork}/share/`]: [KEY_CREATE, DECRYPT] });
    // The delegated principal is neither the owner wallet nor its session.
    expect(courier.did).not.toBe(ownerNode.credentialHolderDid);
    expect(courier.node.credentialHolderDid.startsWith("did:key:")).toBe(true);

    const shareId = newShareId();
    const created = await courier.node.keys.createKey(`share/${shareId}`).then((descriptor) => ({ ok: true as const, state: descriptor.state }), (e) => ({ ok: false as const, error: errorText(e) }));
    console.log("[feasibility] delegated createKey:", JSON.stringify(created));
    expect(created).toMatchObject({ ok: true, state: "active" });

    const result = await publish(courier, { shareId, bound: true });
    console.log("[feasibility] delegated registerPolicy:", JSON.stringify({ registered: result.registered !== undefined, error: result.error }));
    expect(result.registered).toBeDefined();
  });

  test("key.create + decrypt on one exact share key does not reach a sibling key", async () => {
    const shareId = newShareId();
    const courier = await courierSession({ [`${defaultNetwork}/share/${shareId}`]: [KEY_CREATE, DECRYPT] });
    const own = await courier.node.keys.createKey(`share/${shareId}`).then((descriptor) => descriptor.state, errorText);
    const sibling = await courier.node.keys.createKey(`share/${newShareId()}`).then(() => "created", errorText);
    console.log("[feasibility] exact grant:", JSON.stringify({ own, sibling }));
    expect(own).toBe("active");
    expect(sibling).not.toBe("created");
  });

  test("without decrypt on share/ the delegated key cannot own the policy", async () => {
    const courier = await courierSession({ [`${defaultNetwork}/share/`]: [KEY_CREATE] });
    const shareId = newShareId();
    await courier.node.keys.createKey(`share/${shareId}`);
    const result = await publish(courier, { shareId, bound: true });
    console.log("[feasibility] no-decrypt registerPolicy:", JSON.stringify({ registered: result.registered !== undefined, error: result.error }));
    expect(result.registered).toBeUndefined();
  });

  test("an unbound content source (no key path, no digest) is refused even with bare-network decrypt", async () => {
    const courier = await courierSession({ [`${defaultNetwork}/share/`]: [KEY_CREATE, DECRYPT], [defaultNetwork]: [DECRYPT] });
    const shareId = newShareId();
    await courier.node.keys.createKey(`share/${shareId}`);
    const result = await publish(courier, { shareId, bound: false });
    console.log("[feasibility] unbound registerPolicy:", JSON.stringify({ registered: result.registered !== undefined, error: result.error }));
    expect(result.registered).toBeUndefined();
  });
});

/** Encrypt one object to the owner's default network, store it, and register its policy as the delegated key. */
async function publish(courier: CourierSession, options: { shareId: string; bound: boolean }) {
  const { shareId, bound } = options;
  const keyPath = `share/${shareId}`;
  const plaintext = new TextEncoder().encode(JSON.stringify({ hello: "courier" }));
  const encrypted = await courier.node.encryption.encryptToNetwork(defaultNetwork, plaintext, { ...(bound ? { keyPath } : {}), metadata: { contentType: "application/json" } });
  if (!encrypted.ok) throw new Error("encrypt failed");
  const storedBytes = new TextEncoder().encode(canonicalize(encrypted.data as unknown as Record<string, unknown>));
  const resourcePath = `xyz.tinycloud.courier/to/invitee/threads/${shareId}/msg/m1.json`;
  const put = await courier.node.kv.put(resourcePath, storedBytes, { contentType: "application/vnd.tinycloud.encrypted-envelope+json" });
  expect(put.ok).toBe(true);

  // Path-bound sources register the digest of the RAW wrapped-key bytes (final #485).
  const rawDigest = hexEncode(sha256(base64Decode(encrypted.data.encryptedSymmetricKey)));
  const policyActions = ["tinycloud.kv/get", "tinycloud.kv/metadata"] as ("tinycloud.kv/get" | "tinycloud.kv/metadata")[];
  const prepared = prepareAddressedShare({ target: { kind: "email", address: "courier-qa@example.com" }, actions: ["read"], policyActions, filename: "m1.json" });
  let registered: string | undefined;
  let error: string | undefined;
  try {
    await publishAddressedShare({
      shareId, shareOrigin: "https://share.test", nodeOrigin: SERVER_URL, nodeAudience: nodeDid, enforcerDid: nodeDid, spaceId: courier.spaceId,
      target: prepared.target, resource: { kind: "exact", path: resourcePath }, actions: ["read"], policyActions,
      contentSource: {
        shareId, kvResource: `${courier.spaceId}/kv/${resourcePath}`, selector: "exact", encryptionNetwork: encrypted.data.networkId,
        ...(bound ? { encryptionKeyPath: keyPath } : {}),
        encryptedSymmetricKeyDigestHex: bound ? rawDigest : encrypted.data.encryptedSymmetricKeyHash,
        keyVersion: encrypted.data.keyVersion, mode: "immutable", initialCiphertextDigestHex: hexEncode(sha256(storedBytes)),
      },
      ...(prepared.credentialRequirement === undefined ? {} : { credentialRequirement: prepared.credentialRequirement }),
      filename: "m1.json", mediaType: "application/json", byteLength: plaintext.byteLength, expiresAt: new Date(Date.now() + 5 * DAY),
      authority: {
        ownerDid: courier.node.credentialHolderDid,
        createOwnerRoot: (request) => courier.node.createUnifiedOwnerRoot(request),
        sign: (bytes) => courier.node.signSessionBytes(bytes),
        registerPolicy: async (request) => { const receipt = await courier.node.registerPolicy(request); registered = receipt.policyCid; return receipt; },
      },
    });
  } catch (caught) {
    // A local Node is http and the v3 envelope requires an https node origin; that check runs after registration.
    error = errorText(caught);
  }
  return { registered, error };
}
