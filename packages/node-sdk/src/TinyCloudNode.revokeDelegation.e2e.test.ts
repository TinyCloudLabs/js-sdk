import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import "./replication/node-loader";
import { TinyCloudNode } from "./TinyCloudNode";

const nodeBinary = process.env.TC_REPLICATION_E2E_NODE_BIN;
const ownerKey =
  "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d4b2c197a7e5e7b7";
const otherKey =
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// Reuse the pinned executable from the node-sdk real-node CI job.
describe.skipIf(!nodeBinary)(
  "owner revokes delegateTo grants on a real node",
  () => {
    let directory: string;
    let host: string;
    let child: ChildProcess | undefined;

    beforeAll(async () => {
      directory = await mkdtemp("/var/tmp/tc721-sdk-revoke-");
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
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = Promise.withResolvers<void>();
        child.once("exit", () => exited.resolve());
        child.kill("SIGTERM");
        await exited.promise;
      }
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    for (const forceWalletSign of [false, true]) {
      test(`${forceWalletSign ? "wallet-signed" : "session-key"} grant: owner revokes CID and delegate loses read access`, async () => {
        const owner = new TinyCloudNode({
          host,
          signer: new PrivateKeySigner(ownerKey),
          wasmBindings: new NodeWasmBindings(),
          domain: "revoke.test",
          autoCreateSpace: true,
          autoBootstrapAccount: false,
          enablePublicSpace: false,
        });
        const delegate = new TinyCloudNode({
          host,
          wasmBindings: new NodeWasmBindings(),
          autoBootstrapAccount: false,
        });
        await owner.signIn();
        await owner.waitForAccountRegistrySync();
        const space = owner.restorableSession!.spaceId;
        const key = `revoke-${forceWalletSign ? "wallet" : "session"}/message`;
        const prefix = key.slice(0, key.lastIndexOf("/") + 1);
        const put = await owner.kv.put(key, "private");
        expect(put.ok, JSON.stringify(put.ok ? undefined : put.error)).toBe(
          true,
        );

        const issued = await owner.delegateTo(
          delegate.did.split("#")[0]!,
          [
            {
              service: "tinycloud.kv",
              space,
              path: prefix,
              actions: ["tinycloud.kv/get"],
            },
          ],
          { forceWalletSign },
        );
        expect(issued.prompted).toBe(forceWalletSign);
        const access = await delegate.useDelegation(issued.delegation);
        const relativeKey = key.slice(prefix.length);
        const before = await access.kv.get(relativeKey);
        expect(
          before.ok,
          JSON.stringify(before.ok ? undefined : before.error),
        ).toBe(true);
        expect(before.ok && before.data.data).toBe("private");

        const cid = issued.delegation.cid;
        const receipt = await owner.revokeDelegation(cid);
        expect(
          receipt.ok,
          JSON.stringify(receipt.ok ? undefined : receipt.error),
        ).toBe(true);
        expect(receipt.ok && receipt.data).toEqual({ revoked: true, cid });

        const after = await access.kv.get(relativeKey);
        expect(after.ok).toBe(false);
        expect(after.ok ? undefined : after.error.code).toBe(
          "AUTH_UNAUTHORIZED",
        );
      }, 120_000);
    }

    test("another owner cannot revoke a grant or stop its delegate", async () => {
      const owner = new TinyCloudNode({
        host,
        signer: new PrivateKeySigner(ownerKey),
        wasmBindings: new NodeWasmBindings(),
        domain: "revoke.test",
        autoCreateSpace: true,
        autoBootstrapAccount: false,
        enablePublicSpace: false,
      });
      const outsider = new TinyCloudNode({
        host,
        signer: new PrivateKeySigner(otherKey),
        wasmBindings: new NodeWasmBindings(),
        domain: "revoke.test",
        autoCreateSpace: true,
        autoBootstrapAccount: false,
        enablePublicSpace: false,
      });
      const reader = new TinyCloudNode({
        host,
        wasmBindings: new NodeWasmBindings(),
        autoBootstrapAccount: false,
      });
      await owner.signIn();
      await outsider.signIn();
      const space = owner.restorableSession!.spaceId;
      const key = "revoke-outsider/message";
      expect((await owner.kv.put(key, "still delegated")).ok).toBe(true);
      const issued = await owner.delegateTo(reader.did.split("#")[0]!, [
        {
          service: "tinycloud.kv",
          space,
          path: "revoke-outsider/",
          actions: ["tinycloud.kv/get"],
        },
      ]);
      const access = await reader.useDelegation(issued.delegation);
      const before = await access.kv.get("message");
      expect(before.ok && before.data.data).toBe("still delegated");
      const denied = await outsider.revokeDelegation(issued.delegation.cid);
      expect(denied.ok).toBe(false);
      if (denied.ok) throw new Error("another owner revoked the grant");
      expect(denied.error.meta?.status).toBe(403);
      const after = await access.kv.get("message");
      expect(after.ok && after.data.data).toBe("still delegated");
    }, 120_000);
  },
);
