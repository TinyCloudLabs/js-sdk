import { spawn, type ChildProcess } from "node:child_process";
import { createPrivateKey, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import "./replication/node-loader";
import { TinyCloudNode } from "./TinyCloudNode";

const nodeBinary = process.env.TC_TERMINAL_DELEGATION_E2E_NODE_BIN;
const ownerKey =
  "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d4b2c197a7e5e7b7";

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/**
 * A child of `parentToken` signed by `holder`'s session key: the re-share a
 * delegate would make, sent straight to `/delegate`. A session-only holder
 * exposes no signing API, so the test reads its in-memory session key.
 */
async function reshare(
  host: string,
  holder: TinyCloudNode,
  parentToken: string,
  parentCid: string,
): Promise<{ status: number; body: string }> {
  const parent = JSON.parse(Buffer.from(parentToken.split(".")[1]!, "base64url").toString());
  const issuer = holder.did.split("#")[0]!;
  const jwk: unknown = Reflect.get(holder, "sessionKeyJwk");
  if (!jwk || typeof jwk !== "object" || !("x" in jwk) || typeof jwk.x !== "string") {
    throw new Error("holder has no in-memory session key");
  }
  const header = {
    alg: "EdDSA",
    jwk: { kty: "OKP", crv: "Ed25519", x: jwk.x },
    typ: "JWT",
    ucv: "0.10.0",
  };
  const audience = new TinyCloudNode({
    host,
    wasmBindings: new NodeWasmBindings(),
    autoBootstrapAccount: false,
  }).did.split("#")[0]!;
  const payload = {
    iss: `${issuer}#${issuer.slice("did:key:".length)}`,
    aud: audience,
    exp: parent.exp - 60,
    nbf: Math.floor(Date.now() / 1000) - 5,
    nnc: `urn:uuid:${randomUUID()}`,
    prf: [parentCid],
    att: parent.att,
  };
  const input = `${b64u(Buffer.from(JSON.stringify(header)))}.${b64u(Buffer.from(JSON.stringify(payload)))}`;
  const signature = sign(null, Buffer.from(input), createPrivateKey({ key: jwk, format: "jwk" }));
  const response = await fetch(`${host}/delegate`, {
    method: "POST",
    headers: { Authorization: `${input}.${b64u(signature)}` },
  });
  return { status: response.status, body: await response.text() };
}

// Set TC_TERMINAL_DELEGATION_E2E_NODE_BIN to a local tinycloud-node executable.
describe.skipIf(!nodeBinary)(
  "disableSubDelegation on a real node",
  () => {
    let directory: string;
    let host: string;
    let child: ChildProcess | undefined;

    beforeAll(async () => {
      directory = await mkdtemp("/var/tmp/tc1436-sdk-terminal-");
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

    async function signedInOwner(): Promise<TinyCloudNode> {
      const owner = new TinyCloudNode({
        host,
        signer: new PrivateKeySigner(ownerKey),
        wasmBindings: new NodeWasmBindings(),
        domain: "terminal.test",
        autoCreateSpace: true,
        autoBootstrapAccount: false,
        enablePublicSpace: false,
      });
      await owner.signIn();
      return owner;
    }

    for (const disableSubDelegation of [true, false]) {
      test(`disableSubDelegation=${disableSubDelegation}: the delegate reads, and the node ${disableSubDelegation ? "refuses" : "accepts"} its re-share`, async () => {
        const owner = await signedInOwner();
        const reader = new TinyCloudNode({
          host,
          wasmBindings: new NodeWasmBindings(),
          autoBootstrapAccount: false,
        });
        const prefix = `terminal-${disableSubDelegation}/`;
        expect((await owner.kv.put(`${prefix}message`, "shared")).ok).toBe(true);

        const issued = await owner.createDelegation({
          path: prefix,
          actions: ["tinycloud.kv/get"],
          delegateDID: reader.did.split("#")[0]!,
          disableSubDelegation,
        });
        expect(issued.disableSubDelegation).toBe(disableSubDelegation);

        const access = await reader.useDelegation(issued);
        const read = await access.kv.get("message");
        expect(read.ok, JSON.stringify(read.ok ? undefined : read.error)).toBe(true);
        expect(read.ok && read.data.data).toBe("shared");

        const child = await reshare(
          host,
          reader,
          issued.delegationHeader.Authorization,
          issued.cid,
        );
        if (disableSubDelegation) {
          expect(child.status).toBe(401);
          expect(child.body).toContain("terminal-parent-cannot-redelegate");
        } else {
          expect(child.status, child.body).toBe(200);
        }
      }, 120_000);
    }

    test("wallet-signed paths refuse disableSubDelegation instead of issuing a re-delegatable grant", async () => {
      const owner = await signedInOwner();
      const space = owner.restorableSession!.spaceId;
      const delegate = new TinyCloudNode({
        host,
        wasmBindings: new NodeWasmBindings(),
        autoBootstrapAccount: false,
      }).did.split("#")[0]!;
      const entry = {
        service: "tinycloud.kv",
        space,
        path: "terminal-wallet/",
        actions: ["tinycloud.kv/get"],
      };
      await expect(
        owner.delegateTo(delegate, [entry], {
          forceWalletSign: true,
          disableSubDelegation: true,
        }),
      ).rejects.toThrow("disableSubDelegation requires a session-key delegation");

      const parent = await owner.delegateTo(delegate, [entry], { forceWalletSign: true });
      await expect(
        owner.createSubDelegation(parent.delegation, {
          path: "terminal-wallet/",
          actions: ["tinycloud.kv/get"],
          delegateDID: delegate,
          disableSubDelegation: true,
        }),
      ).rejects.toThrow("disableSubDelegation requires a session-key delegation");
    }, 120_000);
  },
);
