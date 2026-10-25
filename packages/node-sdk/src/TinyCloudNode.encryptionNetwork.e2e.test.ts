import { mkdtempSync, rmSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NodeWasmBindings } from "./NodeWasmBindings";
import "./nodeDefaults";
import "./replication/node-loader";
import { TinyCloudNode } from "./TinyCloudNode";

// Never touch a real home: point HOME and tool homes at a throwaway dir first.
const tc1910Home = mkdtempSync("/var/tmp/tc1910.");
if (!tc1910Home.startsWith("/var/tmp/tc1910.")) throw new Error("test home guard failed");
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "COURIER_HOME", "TC_HOME"]) {
  process.env[name] = tc1910Home;
}
afterAll(() => rmSync(tc1910Home, { recursive: true, force: true }));


const nodeBinary = process.env.TC_REPLICATION_E2E_NODE_BIN;
const ownerKey =
  "1f5a9c1d2b3e4f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8";

// A manifest sign-in whose only authority is sql + kv: the encryption network
// operations are covered by a non-primary grant, and their invocations must
// still carry one session's key, iss and prf (TC-1910).
describe.skipIf(!nodeBinary)(
  "manifest sign-in creates the account encryption network on a real node",
  () => {
    let directory: string;
    let host: string;
    let child: ChildProcess | undefined;

    beforeAll(async () => {
      directory = await mkdtemp("/var/tmp/tc1910-sdk-network-");
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
      const timer = setTimeout(
        () => launched.reject(new Error("Real node did not become ready")),
        45_000,
      );
      let output = "";
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("Rocket has launched")) launched.resolve();
      };
      child.stdout!.on("data", onData);
      child.stderr!.on("data", onData);
      child.once("error", launched.reject);
      child.once("exit", (code) =>
        launched.reject(new Error(`Real node exited before readiness (${code})`)),
      );
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
    });

    test("sql + kv manifest: network create returns 200 and the network exists", async () => {
      const node = new TinyCloudNode({
        host,
        privateKey: ownerKey,
        wasmBindings: new NodeWasmBindings(),
        domain: "tc1910.test",
        autoCreateSpace: true,
        enablePublicSpace: false,
        manifest: {
          app_id: "com.tc1910.app",
          name: "TC1910",
          defaults: false,
          permissions: [
            {
              service: "tinycloud.sql",
              path: "details.sqlite",
              actions: ["read", "write", "schema"],
            },
            { service: "tinycloud.kv", path: "data/", actions: ["get", "put", "list"] },
          ],
        },
      });
      await node.signIn();
      await node.waitForAccountRegistrySync();

      // A request-level 401 would surface here as a thrown HTTP error.
      const created = await node.createEncryptionNetwork("default");
      const networkId = node.getDefaultEncryptionNetworkId("default");
      expect(created.networkId).toBe(networkId);
      const read = await node.getEncryptionNetwork(networkId);
      expect(read?.networkId).toBe(networkId);
    }, 120_000);
  },
);
