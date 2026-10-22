import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Manifest } from "@tinycloud/sdk-core";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import "./replication/node-loader";
import { TinyCloudNode } from "./TinyCloudNode";

const nodeBinary = process.env.TC_REPLICATION_E2E_NODE_BIN;

type EncryptionActions = ("decrypt" | "network.create")[];

function manifestFor(networkId: string, actions: EncryptionActions | null) {
  const permissions = actions
    ? [{ service: "tinycloud.encryption", path: networkId, actions }]
    : [];
  return {
    defaults: true,
    name: "TC-1777 e2e",
    app_id: "xyz.tinycloud.tc1777.e2e",
    permissions,
  } as unknown as Manifest;
}

describe.skipIf(!nodeBinary)(
  "first secrets put creates the encryption network on a real node (TC-1777)",
  () => {
    let directory: string;
    let host: string;
    let child: ChildProcess | undefined;
    let createCalls = 0;
    const realFetch = globalThis.fetch;

    beforeAll(async () => {
      // Count POST /encryption/networks calls made by any node in this file.
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (
          init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        const url = input instanceof Request ? input.url : String(input);
        if (method === "POST" && new URL(url).pathname === "/encryption/networks") {
          createCalls += 1;
        }
        return realFetch(input, init);
      }) as typeof fetch;

      directory = await mkdtemp(join(tmpdir(), "tc1777-sdk-net-"));
      const server = createServer();
      const port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string")
            return reject(new Error("No local node port"));
          server.close(() => resolve(address.port));
        });
      });
      host = `http://127.0.0.1:${port}`;
      child = spawn(nodeBinary!, [], {
        cwd: directory,
        env: {
          ...process.env,
          TINYCLOUD_STORAGE__DATADIR: join(directory, "data"),
          TINYCLOUD_PORT: String(port),
          TINYCLOUD_ADDRESS: "127.0.0.1",
          ROCKET_PORT: String(port),
          ROCKET_ADDRESS: "127.0.0.1",
          TINYCLOUD_KEYS__TYPE: "Static",
          TINYCLOUD_KEYS__SECRET: randomBytes(48).toString("base64url"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const launched = Promise.withResolvers<void>();
      let output = "";
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("Rocket has launched")) launched.resolve();
      };
      child.stdout!.on("data", onData);
      child.stderr!.on("data", onData);
      child.once("error", launched.reject);
      child.once("exit", (code) =>
        launched.reject(
          new Error(`Real node exited before readiness (${code})`),
        ),
      );
      await launched.promise;
    }, 60_000);

    afterAll(async () => {
      globalThis.fetch = realFetch;
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = Promise.withResolvers<void>();
        child.once("exit", () => exited.resolve());
        child.kill("SIGTERM");
        await exited.promise;
      }
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    function nodeFor(key: string, manifest?: Manifest): TinyCloudNode {
      return new TinyCloudNode({
        host,
        signer: new PrivateKeySigner(key),
        wasmBindings: new NodeWasmBindings(),
        domain: "tc1777.secrets.test",
        autoCreateSpace: true,
        autoBootstrapAccount: false,
        enablePublicSpace: false,
        ...(manifest ? { manifest } : {}),
      });
    }

    // Each case uses a fresh key so the owner encryption network does not exist yet.
    async function accountNode(actions: EncryptionActions | null) {
      const key = randomBytes(32).toString("hex");
      const address = await new PrivateKeySigner(key).getAddress();
      const networkId = `urn:tinycloud:encryption:did:pkh:eip155:1:${address}:default`;
      const node = nodeFor(key, manifestFor(networkId, actions));
      return { node, networkId };
    }

    // A manifest-based sign-in skips the automatic secrets-space creation, so
    // host it explicitly before any secrets write.
    async function signInWithSecretsSpace(node: TinyCloudNode) {
      await node.signIn();
      await node.ensureOwnedSpaceHosted("secrets");
    }

    test("network.create-only sign-in: first put succeeds, creates network once, no decrypt grant", async () => {
      const { node, networkId } = await accountNode(["network.create"]);
      await signInWithSecretsSpace(node);
      expect(node.getDefaultEncryptionNetworkId()).toBe(networkId);
      createCalls = 0;

      const put = await node.secrets.put("TC1777_FIRST", "first-value");
      expect(put.ok, JSON.stringify(put.ok ? undefined : put.error)).toBe(true);
      expect(createCalls).toBe(1);
      expect(await node.getEncryptionNetwork(networkId)).not.toBeNull();

      const decrypt = node
        .getRuntimePermissionDelegations()
        .filter((d) => d.actions.some((a) => a.includes("decrypt")));
      expect(decrypt).toEqual([]);
    }, 120_000);

    test("two concurrent first puts create the encryption network once", async () => {
      const { node, networkId } = await accountNode(["network.create"]);
      await signInWithSecretsSpace(node);
      createCalls = 0;

      const [a, b] = await Promise.all([
        node.secrets.put("TC1777_A", "a"),
        node.secrets.put("TC1777_B", "b"),
      ]);
      expect(a.ok, JSON.stringify(a.ok ? undefined : a.error)).toBe(true);
      expect(b.ok, JSON.stringify(b.ok ? undefined : b.error)).toBe(true);
      expect(createCalls).toBe(1);
      expect(await node.getEncryptionNetwork(networkId)).not.toBeNull();
    }, 120_000);

    test("session without network.create: put keeps the existing Network not found error and makes no create call", async () => {
      const { node, networkId } = await accountNode(null);
      await signInWithSecretsSpace(node);
      createCalls = 0;

      const put = await node.secrets.put("TC1777_NO_CREATE", "value");
      expect(put.ok).toBe(false);
      if (put.ok) return;
      expect(put.error.code).toBe("STORAGE_ERROR");
      expect(put.error.message).toBe(`Network not found: ${networkId}`);
      expect(createCalls).toBe(0);
    }, 120_000);

    test("session with decrypt: put adds no create call beyond sign-in", async () => {
      const { node } = await accountNode(["decrypt"]);
      await signInWithSecretsSpace(node);
      const createdAtSignIn = createCalls;

      const put = await node.secrets.put("TC1777_DECRYPT", "value");
      expect(put.ok, JSON.stringify(put.ok ? undefined : put.error)).toBe(true);
      expect(createCalls - createdAtSignIn).toBe(0);
    }, 120_000);
  },
);
