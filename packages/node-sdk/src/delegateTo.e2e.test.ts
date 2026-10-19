import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TinyCloudNode } from "./TinyCloudNode";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";

// Runs against a real TinyCloud node binary (the same variable the replication e2e uses).
const NODE_BIN = process.env.TC_REPLICATION_E2E_NODE_BIN;
const OWNER_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f";

describe.skipIf(!NODE_BIN)("delegateTo against a real node", () => {
  let dataDir: string;
  let host: string;
  let child: ChildProcess;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "tc1211-node-"));
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") return reject(new Error("no port"));
        server.close(() => resolve(address.port));
      });
    });
    host = `http://127.0.0.1:${port}`;
    child = spawn(NODE_BIN!, [], {
      cwd: dataDir,
      env: {
        ...process.env,
        TINYCLOUD_STORAGE__DATADIR: join(dataDir, "data"),
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
    child.once("error", (error) => launched.reject(error));
    await launched.promise;
  }, 60_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true });
  });

  async function signedInNode(): Promise<TinyCloudNode> {
    const node = new TinyCloudNode({
      host,
      signer: new PrivateKeySigner(OWNER_KEY),
      wasmBindings: new NodeWasmBindings(),
      domain: "delegate.test",
      autoCreateSpace: true,
      autoBootstrapAccount: false,
      enablePublicSpace: false,
    });
    await node.signIn();
    return node;
  }

  // A did:key without the #fragment form that `getDID` returns.
  const newRecipient = () => new NodeWasmBindings().createSessionManager().getDID("default").split("#")[0]!;
  const kvEntry = { service: "tinycloud.kv", space: "default", path: "qa-seed/", actions: ["tinycloud.kv/get", "tinycloud.kv/list"] };

  test("a delegation the node activated is returned by the account delegation query, signed by the session key", async () => {
    const node = await signedInNode();
    const recipient = newRecipient();
    const { delegation } = await node.delegateTo(recipient, [kvEntry], { expiry: "1h" });

    const page = await node.account.delegations.query({ direction: "granted" });
    expect(page.ok).toBe(true);
    const found = page.ok ? page.data.items.find((item) => item.cid === delegation.cid) : undefined;
    expect(found).toMatchObject({ direction: "granted", status: "active", delegateDid: recipient });
    expect(found?.delegatorDid).not.toBe(node.did);
    expect(found?.delegatorDid.startsWith("did:key:")).toBe(true);
    expect(found?.resources.map((r) => r.actions)).toEqual([["tinycloud.kv/get", "tinycloud.kv/list"]]);

    // The per-space capabilities/read listing only shows owner-signed delegations.
    const ownerSigned = await node.space(node.restorableSession!.spaceId).delegations.list();
    expect(ownerSigned.ok && ownerSigned.data.some((d) => d.cid === delegation.cid)).toBe(false);
  });

  test("delegateTo rejects, naming the space, when the node answers 200 but skips the target space", async () => {
    const node = await signedInNode();
    const spaceId = node.restorableSession!.spaceId;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).endsWith("/delegate")) {
        return new Response(JSON.stringify({ cid: "bafkr4ifake", activated: [], skipped: [spaceId] }), { status: 200 });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      await expect(node.delegateTo(newRecipient(), [kvEntry], { expiry: "1h" })).rejects.toThrow(
        `the node skipped ${spaceId}`,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
