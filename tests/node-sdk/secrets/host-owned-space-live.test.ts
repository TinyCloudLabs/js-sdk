import { beforeAll, describe, expect, test } from "bun:test";
import { Wallet } from "ethers";
import { TinyCloudNode, type Manifest } from "@tinycloud/node-sdk";
import { checkServerHealth, SERVER_URL } from "../setup";

/**
 * Live regression for the manifest-recap owned-space hosting gap.
 *
 * A full-authority sign-in auto-hosts the owner's `secrets` owned space, but a
 * session created WITH a manifest / capabilityRequest does not (the node only
 * auto-hosts when both are undefined). Such an owner therefore holds valid
 * `tinycloud.kv/*` capabilities for the `secrets` space yet its first scoped
 * `secrets.put(...)` fails with `404 Space not found` until the space is
 * explicitly hosted.
 *
 * This test uses a BRAND-NEW random-key owner with a manifest-recap-limited
 * session, calls the new public `ensureOwnedSpaceHosted('secrets')`, and proves
 * the subsequent scoped put succeeds. It also documents that the host call is
 * server-idempotent (safe to call twice).
 */
describe("manifest-recap owner secrets-space hosting (live)", () => {
  // Fresh owner per run so the secrets space starts unhosted on the node.
  const ownerKey = Wallet.createRandom().privateKey.slice(2);
  const ownerAddress = new Wallet(ownerKey).address;
  const ownerDid = `did:pkh:eip155:1:${ownerAddress}`;
  // Secrets are encrypted to the owner's default encryption network, so the
  // manifest must also grant it (mirrors git-haiku's owner recap). signIn's
  // ensureRequestedEncryptionNetworks() then auto-creates it.
  const defaultNetworkId = `urn:tinycloud:encryption:${ownerDid}:default`;
  const SCOPE = "githaiku";
  const SECRET_NAME = "GITHUB_TOKEN";
  const SECRET_VALUE = `ghp_live_${Date.now()}`;

  // Manifest-recap (NOT full authority): defaults:false, only the scoped
  // GITHUB_TOKEN secret plus the owner's default encryption network are
  // granted. This is the shape git-haiku's owner flow uses, and it is exactly
  // the path that skips the sign-in auto-host of the `secrets` space.
  const manifest: Manifest = {
    manifest_version: 1,
    app_id: "dev.tinycloud.githaiku-host-test",
    name: "Git Haiku Owned-Space Host Test",
    defaults: false,
    permissions: [
      {
        service: "tinycloud.encryption",
        path: defaultNetworkId,
        actions: ["network.create", "decrypt"],
      },
    ],
    secrets: {
      [SECRET_NAME]: {
        scope: SCOPE,
        actions: ["get", "put", "del", "list"],
      },
    },
  };

  let owner: TinyCloudNode;

  beforeAll(async () => {
    await checkServerHealth();
    owner = new TinyCloudNode({
      privateKey: ownerKey,
      host: SERVER_URL,
      prefix: `githaiku-host-${Date.now()}`,
      autoCreateSpace: true,
      manifest,
      includeAccountRegistryPermissions: false,
    });
    await owner.signIn();
    console.log("[Setup] Manifest-recap owner signed in, DID:", owner.did);
  });

  test("ensureOwnedSpaceHosted('secrets') resolves the owner's secrets space URI", async () => {
    const spaceId = await owner.ensureOwnedSpaceHosted("secrets");
    console.log("[Host] secrets space hosted:", spaceId);
    expect(spaceId).toContain(":secrets");
    expect(spaceId.startsWith("tinycloud:pkh:eip155:")).toBe(true);
  });

  test("ensureOwnedSpaceHosted is idempotent (safe to call again)", async () => {
    // Server-side host SIWE is idempotent; calling again must not throw and must
    // resolve to the same space URI.
    const first = await owner.ensureOwnedSpaceHosted("secrets");
    const second = await owner.ensureOwnedSpaceHosted("secrets");
    expect(second).toBe(first);
  });

  test("scoped secrets.put SUCCEEDS after hosting (the case that 404s today)", async () => {
    // Without the host step this returns `404 Space not found` /
    // `Unauthorized ... tinycloud.kv/put`. After hosting it must succeed.
    const putResult = await owner.secrets.put(SECRET_NAME, SECRET_VALUE, {
      scope: SCOPE,
    });
    if (!putResult.ok) {
      console.error("[Put] failed:", putResult.error);
    }
    expect(putResult.ok).toBe(true);
  });

  test("scoped secrets.get round-trips the value", async () => {
    const getResult = await owner.secrets.get(SECRET_NAME, { scope: SCOPE });
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.data).toBe(SECRET_VALUE);
    }
  });
});
