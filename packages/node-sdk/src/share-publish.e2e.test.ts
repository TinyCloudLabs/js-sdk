import { mkdtempSync, rmSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bindPathBoundContentSource,
  encryptAddressedShareContent,
  planPathBoundShare,
  prepareAddressedShare,
} from "@tinycloud/share-sdk";
import { NodeWasmBindings } from "./NodeWasmBindings";
import "./nodeDefaults";
import "./replication/node-loader";
import { TinyCloudNode } from "./TinyCloudNode";
import { publishEmailShareV3 } from "./share-publish.js";
import { startUnregisteredLocationRegistry, type UnregisteredLocationRegistry } from "./test-support/unregistered-location-registry";

// Never touch a real home: point HOME and tool homes at a throwaway dir first.
const home = mkdtempSync("/var/tmp/tc3582.");
if (!home.startsWith("/var/tmp/tc3582.")) throw new Error("test home guard failed");
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "COURIER_HOME", "TC_HOME"]) {
  process.env[name] = home;
}
afterAll(() => rmSync(home, { recursive: true, force: true }));

const nodeBinary = process.env.TC_REPLICATION_E2E_NODE_BIN;
const ownerKey = "1f5a9c1d2b3e4f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8";
// The default encryption network of the wallet behind `ownerKey`; the CLI resolves its `share/` prefix against it.
const ownerNetwork = "urn:tinycloud:encryption:did:pkh:eip155:1:0x2Aef9946EFbacdA956380DB7Eb6802FAd7a9634B:default";
const vectors = new URL("../../sdk-core/test-fixtures/opencredentials-v1/golden-descriptor-digests.json", import.meta.url);

// TC-3582 step 0: does a real node accept the Policy/v3 registration of an exact-email, path-bound share built the way
// `tinycloud share publish --to <email>` builds it (a `share/<shareId>` key on the default encryption network, the
// descriptor and issuer pinned for the built-in OpenCredentials issuer)? Loopback only: no witness, Share or registry call.
describe.skipIf(!nodeBinary)("exact-email path-bound share registers on a real node", () => {
  let directory: string;
  let host: string;
  let child: ChildProcess | undefined;
  let registry: UnregisteredLocationRegistry;
  let output = "";

  beforeAll(async () => {
    directory = await mkdtemp("/var/tmp/tc3582-node-");
    registry = startUnregisteredLocationRegistry();
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") return reject(new Error("No local node port"));
        server.close(() => resolve(address.port));
      });
    });
    host = `http://127.0.0.1:${port}`;
    child = spawn(nodeBinary!, ["serve"], {
      cwd: directory,
      env: {
        ...process.env,
        TINYCLOUD_STORAGE__DATADIR: join(directory, "data"),
        TINYCLOUD_PORT: String(port),
        TINYCLOUD_ADDRESS: "127.0.0.1",
        ROCKET_PORT: String(port),
        ROCKET_ADDRESS: "127.0.0.1",
        TINYCLOUD_KEYS__TYPE: "Static",
        // Path-bound email shares are encrypted under a named key; the node serves those only with this gate on.
        TINYCLOUD_ENCRYPTION_NETWORK__NAMED_KEYS_V1: "true",
        TINYCLOUD_ENCRYPTION_NETWORK__DELETION_LEDGER_PATH: join(directory, "deletion-ledger.jsonl"),
        TINYCLOUD_KEYS__SECRET: randomBytes(48).toString("base64url"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const launched = Promise.withResolvers<void>();
    const timer = setTimeout(() => launched.reject(new Error("Real node did not become ready")), 45_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Rocket has launched")) launched.resolve();
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.once("error", launched.reject);
    child.once("exit", (code) => launched.reject(new Error(`Real node exited before readiness (${code})`)));
    try {
      await launched.promise;
    } finally {
      clearTimeout(timer);
    }
  }, 60_000);

  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = Promise.withResolvers<void>();
      child.once("exit", () => exited.resolve());
      child.kill("SIGTERM");
      await exited.promise;
    }
    if (directory) await rm(directory, { recursive: true, force: true });
    registry?.stop(true);
  });

  test("publishEmailShareV3 with the CLI's request shape", async () => {
    const descriptor = ((await Bun.file(vectors).json()) as { vectors: { name: string; descriptor: unknown }[] }).vectors.find((vector) => vector.name === "email")!.descriptor;
    const node = new TinyCloudNode({
      host,
      tinycloudRegistryUrl: registry.url.origin,
      privateKey: ownerKey,
      wasmBindings: new NodeWasmBindings(),
      domain: "tc3582.test",
      autoCreateSpace: true,
      enablePublicSpace: false,
      // The scope of the CLI's `builtin:share-publishing` manifest (packages/cli/src/share/publishing-manifest.ts): the node
      // registers an email share's policy only for an owner holding decrypt on the account's `default/share/` prefix.
      manifest: {
        app_id: "xyz.tinycloud.share",
        name: "TinyCloud Share publishing",
        space: "default",
        defaults: false,
        permissions: [
          { service: "tinycloud.capabilities", path: "", skipPrefix: true, actions: ["tinycloud.capabilities/read"] },
          { service: "tinycloud.kv", path: "shares/", skipPrefix: true, actions: ["tinycloud.kv/get", "tinycloud.kv/metadata", "tinycloud.kv/put", "tinycloud.kv/list"] },
          { service: "tinycloud.encryption", path: `${ownerNetwork}/share/`, skipPrefix: true, actions: ["tinycloud.encryption/decrypt"] },
        ],
      },
    });
    await node.signIn();
    await node.waitForAccountRegistrySync();
    const ownerSpaceId = node.spaceId!;
    await node.createEncryptionNetwork("default");
    const network = node.getDefaultEncryptionNetworkId();

    // The adapter's order: plan the path-bound key, encrypt, store, bind, publish.
    const shareId = crypto.randomUUID().replaceAll("-", "");
    const plan = planPathBoundShare({ shareId, encryptionNetwork: network });
    const plaintext = new TextEncoder().encode("hello from tc-3582\n");
    const encrypted = await encryptAddressedShareContent({ plan, keys: node.keys, plaintext, metadata: { contentType: "text/plain" } });
    const resourcePath = `shares/${shareId}/note.txt`;
    const stored = await node.kvForSpace(ownerSpaceId).put(resourcePath, encrypted.storedBytes, { contentType: "application/vnd.tinycloud.encrypted-envelope+json" });
    expect(stored.ok).toBe(true);
    const contentSource = bindPathBoundContentSource({
      plan, envelope: encrypted.envelope, storedBytes: encrypted.storedBytes,
      kvResource: `${ownerSpaceId}/kv/${resourcePath}`, selector: "exact",
    });
    const policyActions = ["tinycloud.kv/get", "tinycloud.kv/metadata"] as const;
    const prepared = prepareAddressedShare({ target: { kind: "email", address: "person@example.com" }, actions: ["read"], policyActions: [...policyActions], filename: "note.txt" });
    if (prepared.target.kind !== "email") throw new Error("expected an email target");
    const identity = await node.activeNodeIdentity();
    const published = await publishEmailShareV3({
      shareId,
      shareOrigin: "https://share.example",
      // The sealed envelope accepts only a canonical https origin; a loopback node is http. The node itself is reached through `node`, not this origin.
      nodeOrigin: "https://node.example",
      nodeAudience: identity.nodeDid,
      enforcerDid: identity.nodeDid,
      spaceId: ownerSpaceId,
      target: prepared.target,
      resource: { kind: "exact", path: resourcePath },
      actions: ["read"],
      policyActions: [...policyActions],
      contentSource,
      deliveryEmail: "person@example.com",
      filename: "note.txt",
      mediaType: "text/plain",
      byteLength: plaintext.byteLength,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
      authority: {
        ownerDid: node.credentialHolderDid,
        createOwnerRoot: (request) => node.createUnifiedOwnerRoot(request),
        sign: (bytes) => node.signSessionBytes(bytes),
        registerPolicy: (request) => node.registerPolicy(request),
      },
      credentialDescriptor: descriptor,
      issuerDid: "did:web:issuer.credentials.org",
      issuerKid: "did:web:issuer.credentials.org#controller",
    });
    expect(published.link.kind).toBe("policy");
    expect(published.deliveryMaterial).toBeDefined();
  }, 120_000);
});
