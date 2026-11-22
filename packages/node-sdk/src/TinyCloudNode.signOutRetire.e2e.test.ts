import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { signedRestorableSession } from "./test-support/signed-restorable-session";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import "./replication/node-loader";
import { TinyCloudNode } from "./TinyCloudNode";
import type { TinyCloudSession } from "@tinycloud/sdk-core";
import { startUnregisteredLocationRegistry, type UnregisteredLocationRegistry } from "./test-support/unregistered-location-registry";

// TC-3443: a node with `POST /session/retire` (tinycloud-node#678). Released
// nodes before it answer 404, so this runs only against a binary named here.
const nodeBinary = process.env.TC_SESSION_RETIRE_E2E_NODE_BIN;
const ownerKey = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d4b2c197a7e5e7b7";

describe.skipIf(!nodeBinary)("sign-out retires the session key on a real node", () => {
  let directory: string;
  let host: string;
  let child: ChildProcess | undefined;
  let registry: UnregisteredLocationRegistry;

  beforeAll(async () => {
    directory = await mkdtemp("/var/tmp/tc3443-sdk-retire-");
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
    child.once("exit", (code) => launched.reject(new Error(`Real node exited before readiness (${code})`)));
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
    registry?.stop(true);
  });

  test("after sign-out the node confirms, and refuses the old session key and its bootstrap keys with session_retired", async () => {
    const config = {
      host,
      tinycloudRegistryUrl: registry.url.origin,
      wasmBindings: new NodeWasmBindings(),
      domain: "retire.test",
      autoBootstrapAccount: false,
      enablePublicSpace: false,
    };
    // A local private key bootstraps the account itself (a bare signer counts as interactive and skips it).
    const owner = new TinyCloudNode({
      ...config, privateKey: ownerKey, signer: new PrivateKeySigner(ownerKey), autoCreateSpace: true, autoBootstrapAccount: true,
    });
    await owner.signIn();
    const put = await owner.kv.put("retire/message", "private");
    expect(put.ok, JSON.stringify(put.ok ? undefined : put.error)).toBe(true);
    const leaving = owner.restorableSession!;
    // The account bootstrap's own session keys, activated on the node at sign-in.
    const bootstraps = (owner as unknown as { bootstrapSessions: TinyCloudSession[] }).bootstrapSessions
      .filter((session) => session.verificationMethod !== leaving.verificationMethod);
    expect(bootstraps.length, JSON.stringify(owner.bootstrapStatus)).toBeGreaterThan(0);

    await owner.signOut();
    expect(await owner.nodeSignOutStatus()).toEqual({ confirmed: [host], nothingToRecord: [], notConfirmed: [] });

    // Each signed-out key, restored elsewhere with its wallet-signed root, is refused.
    for (const session of [leaving, ...bootstraps]) {
      const copy = new TinyCloudNode(config);
      await copy.restoreSession({
        delegationHeader: session.delegationHeader,
        delegationCid: session.delegationCid,
        spaceId: session.spaceId,
        jwk: session.jwk,
        verificationMethod: session.verificationMethod,
        address: session.address,
        chainId: session.chainId,
        siwe: session.siwe,
        signature: session.signature,
      });
      const refused = await copy.kv.get("retire/message");
      expect(refused.ok).toBe(false);
      expect(JSON.stringify(refused), session.spaceId).toContain("session_retired");
    }

    // The owner's next session is unaffected.
    await owner.signIn();
    const read = await owner.kv.get("retire/message");
    expect(read.ok, JSON.stringify(read.ok ? undefined : read.error)).toBe(true);
  }, 120_000);

  test("a root the node refuses is dropped once: the node records the retire without it, and the host is reported refused", async () => {
    const config = {
      host,
      tinycloudRegistryUrl: registry.url.origin,
      wasmBindings: new NodeWasmBindings(),
      domain: "retire.test",
      autoBootstrapAccount: false,
      enablePublicSpace: false,
    };
    const strangerKey = randomBytes(32).toString("hex");
    const stranger = new TinyCloudNode({ ...config, signer: new PrivateKeySigner(strangerKey), autoCreateSpace: true });
    await stranger.signIn();
    const put = await stranger.kv.put("retire/message", "private");
    expect(put.ok, JSON.stringify(put.ok ? undefined : put.error)).toBe(true);
    const leaving = stranger.restorableSession!;
    // A root the stranger signs for its own session key over the owner's space: it verifies, but no node admits it.
    const ownerSpace = config.wasmBindings.makeSpaceId(await new PrivateKeySigner(ownerKey).getAddress(), 1, "default");
    const foreign = await signedRestorableSession({
      privateKey: strangerKey,
      sessionKey: { jwk: leaving.jwk, verificationMethod: leaving.verificationMethod },
      spaces: { owner: ownerSpace },
    });
    (stranger as unknown as { runtimePermissionGrants: unknown[] }).runtimePermissionGrants.push({
      session: { ...foreign },
      delegation: {
        cid: foreign.delegationCid, delegationHeader: foreign.delegationHeader, spaceId: foreign.spaceId,
        path: "", actions: [], expiry: new Date(foreign.expiresAt), delegateDID: foreign.verificationMethod,
        ownerAddress: foreign.address, chainId: foreign.chainId,
        siweProof: { siwe: foreign.siwe, signature: foreign.signature },
      },
      operations: [],
      expiresAt: new Date(foreign.expiresAt),
      provenance: "delegated",
    });

    await stranger.signOut();
    const status = await stranger.nodeSignOutStatus();
    expect(status?.confirmed, JSON.stringify(status)).toEqual([]);
    expect(status?.nothingToRecord).toEqual([]);
    expect(status?.notConfirmed).toHaveLength(1);
    expect(status?.notConfirmed[0]).toMatchObject({ host, reason: "refused", status: 401 });
    expect(typeof status?.notConfirmed[0]?.delegation).toBe("number");

    // The retry without that root recorded: the key is refused.
    const copy = new TinyCloudNode(config);
    await copy.restoreSession({
      delegationHeader: leaving.delegationHeader,
      delegationCid: leaving.delegationCid,
      spaceId: leaving.spaceId,
      jwk: leaving.jwk,
      verificationMethod: leaving.verificationMethod,
      address: leaving.address,
      chainId: leaving.chainId,
      siwe: leaving.siwe,
      signature: leaving.signature,
    });
    const refused = await copy.kv.get("retire/message");
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).toContain("session_retired");
  }, 120_000);
});
