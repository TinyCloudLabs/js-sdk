import "../../operations/test-support/test-bootstrap.mjs";
import { expect, spyOn, test } from "bun:test";
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner, TinyCloudNode, type TinyCloudSession } from "@tinycloud/node-sdk";
import { invokeOperation } from "@tinycloud/operations";
import { RemoteTenantStore } from "./remote-store.js";
import { installMcpRegistryFixture, resetMcpRegistryFixture } from "./test-support/registry-fixture.mjs";
import {
  installFakeOpenKey, LINKS_API_ORIGIN, OPENKEY_API_ORIGIN, OPENKEY_ORIGIN,
  openKeyDelegation, ownerDid, REQUESTER_KEY,
} from "./test-support/openkey-approval.js";

const binary = process.env.TC_MCP_TEST_NODE;
const clockBinary = process.env.TC_MCP_TEST_CLOCK_NODE;
const bootstrapAbilities = { kv: {
  "spaces/": ["tinycloud.kv/get", "tinycloud.kv/list"],
  "applications/": ["tinycloud.kv/get", "tinycloud.kv/list"],
} };

test.skipIf(!binary)("a background approval sets the idle age without a client call; confirmed retirement survives retries", () =>
  proveRetirement(true), 45_000);

test.skipIf(!binary)("a late approval lost before collection still retires the real holder before day seven", () =>
  proveRetirement(false), 45_000);

test.skipIf(!clockBinary)("retirement fences renewal for the original CID while a live control is still stamped", () =>
  proveRetirement(false, clockBinary), 45_000);

test.skipIf(!binary)("only a successful node-accepted operation advances the durable idle clock", () =>
  proveRetirement(true, undefined, true), 45_000);

async function proveRetirement(collect: boolean, schedulerBinary?: string, use = false): Promise<void> {
  // The sibling package's test fixture is outside this package's TypeScript root.
  const { startLocalNode } = await import(new URL("../../node-sdk/src/test-support/local-node.ts", import.meta.url).href) as {
    startLocalNode(binary: string, prefix: string): Promise<{ host: string; stop(): Promise<void> }>;
  };
  const stateDir = await mkdtemp(join(tmpdir(), "mcp-retire-state-"));
  const clockPath = join(stateDir, "renewal-clock");
  const advanceClock = async (time: number) => {
    await writeFile(`${clockPath}.tmp`, String(Math.floor(time / 1000)));
    await rename(`${clockPath}.tmp`, clockPath);
  };
  const oldClock = process.env.TINYCLOUD_RENEWAL_TEST_CLOCK;
  if (schedulerBinary !== undefined) {
    await advanceClock(Date.now());
    process.env.TINYCLOUD_RENEWAL_TEST_CLOCK = clockPath;
  }
  const node = await startLocalNode(schedulerBinary ?? binary!, join(tmpdir(), "mcp-retire-node-")).finally(() => {
    if (oldClock === undefined) delete process.env.TINYCLOUD_RENEWAL_TEST_CLOCK;
    else process.env.TINYCLOUD_RENEWAL_TEST_CLOCK = oldClock;
  });
  installMcpRegistryFixture(node.host);
  const upstream = globalThis.fetch;
  let retireMode: "unavailable" | "not-recorded" | "node" = "node";
  let leaseAuthorization: string | undefined;
  const leaseReplies: Array<{ status: number; body: string }> = [];
  let retirePosts = 0;
  const receipts: unknown[] = [];
  const carried: unknown[] = [];
  let restoreSweepClock: (() => void) | undefined;
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${node.host}/info` && restoreSweepClock) restoreSweepClock();
    if (url === `${node.host}/delegate` && leaseAuthorization !== undefined) {
      const authorization = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("Authorization");
      if (authorization?.replace(/^Bearer\s+/i, "") === leaseAuthorization) {
        const admitted = await upstream(input, init);
        leaseReplies.push({ status: admitted.status, body: await admitted.clone().text() });
        return admitted;
      }
    }
    if (url !== `${node.host}/session/retire`) return upstream(input, init);
    retirePosts++;
    if (retireMode === "unavailable") return new Response(null, { status: 503 });
    if (retireMode === "not-recorded") return Response.json({ recorded: false });
    carried.push(init?.body === undefined ? null : JSON.parse(String(init.body)));
    const response = await upstream(input, init);
    receipts.push(await response.clone().json());
    return response;
  }, upstream);
  const openkey = installFakeOpenKey();
  const config = {
    stateDir, stateSecret: "test-secret-that-is-at-least-thirty-two-bytes",
    publicUrl: new URL("https://mcp.test/mcp"), nodeHost: node.host,
    openkeyHost: OPENKEY_ORIGIN, openkeyApiHost: OPENKEY_API_ORIGIN, linksApiOrigin: LINKS_API_ORIGIN,
    approvalTtlSeconds: 300, delegationExpiry: "1h",
  };
  let store = new RemoteTenantStore(config);
  try {
    const sdkConfig = { host: node.host, wasmBindings: new NodeWasmBindings(), domain: "mcp.test", enablePublicSpace: false };
    const owner = new TinyCloudNode({ ...sdkConfig, privateKey: REQUESTER_KEY, autoCreateSpace: true });
    await owner.signIn();
    const owners = [await ownerDid(REQUESTER_KEY)];
    const subject = "idle-hosted-tenant";
    // Issue the lost-result link 4 min into the past, so approval occurs near
    // the end of a real signed 5-min request without sleeping for minutes.
    const requestCreated = Date.now() - (collect ? 0 : 4 * 60_000);
    const requestClock = collect ? undefined : spyOn(Date, "now").mockReturnValue(requestCreated);
    const root = store.tenantStateRoot(subject);
    const path = join(root, ".tinycloud/profiles/agent/session.json");
    const keyPath = join(root, ".tinycloud/profiles/agent/key.json");
    const marker = join(root, ".tinycloud/last-call");
    const link = await (async () => {
      const status = await store.connectStatus(subject, owners);
      return store.approvalLink(new URL(status.approvalUrl!).searchParams.get("state")!);
    })().finally(() => requestClock?.mockRestore());
    const grantExpiry = new Date(Date.now() + (schedulerBinary === undefined ? 20 * 60_000 : 120_000));
    const grant = await openKeyDelegation({
      tenantStateRoot: root, privateKey: REQUESTER_KEY, space: "account",
      abilities: bootstrapAbilities,
      expiresAt: grantExpiry,
    });
    const header = grant.delegationHeader;
    if (header === null || typeof header !== "object" || !("Authorization" in header) || typeof header.Authorization !== "string") {
      throw new Error("Test grant has no authorization.");
    }
    const authorization = header.Authorization;
    const registered = await fetch(`${node.host}/delegate`, { method: "POST", headers: { Authorization: authorization } });
    expect(registered.ok, await registered.text()).toBe(true);
    const renewal = await signLease(owner, sdkConfig.wasmBindings, grant);
    const approvedAt = Date.parse(renewal.approvedAt);
    if (!collect) expect(approvedAt - requestCreated).toBeGreaterThan(3.9 * 60_000);
    if (schedulerBinary !== undefined) await advanceClock(Date.now());
    // OpenKey has already registered the lease when it sends the result.
    await store.close();
    const producerPost = await upstream(`${node.host}/delegate`, {
      method: "POST", headers: { Authorization: renewal.receipt.leaseAuthorization },
    });
    expect(producerPost.ok, await producerPost.text()).toBe(true);
    leaseAuthorization = renewal.receipt.leaseAuthorization;
    const { id } = await openkey.approve(link, grant, { renewal });
    if (collect) {
      store = new RemoteTenantStore(config);
      expect(await store.sweepIdleTenants()).toBe(0);
      expect(await openkey.delivery(id)).toEqual({ status: "stored" });
      expect(leaseReplies.map((reply) => reply.status), JSON.stringify(leaseReplies)).toEqual([200]);
      expect(Math.abs((await stat(marker)).mtimeMs - approvedAt)).toBeLessThan(2);
    } else {
      openkey.expireResult(id);
      expect(leaseReplies).toEqual([]);
      expect(openkey.acknowledged(id)).toBe(false);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    }
    let lastUse: number | undefined;
    if (use) {
      const run = async (id: string, input: unknown) => {
        const metrics = { replayedGrants: 0, acceptedNodeInvocation: false };
        const target = { profile: "agent", stateRoot: root };
        const result = await invokeOperation(id, 1, target, input, metrics);
        await store.decorateAuthorityResult(subject, owners, result, undefined, metrics.acceptedNodeInvocation);
        return { status: result.status, accepted: metrics.acceptedNodeInvocation };
      };
      expect(await run("tinycloud.auth.capabilities", {})).toEqual({ status: "ok", accepted: false });
      expect(await run("tinycloud.kv.get", { key: 12 })).toEqual({ status: "error", accepted: false });
      expect(Math.abs((await stat(marker)).mtimeMs - approvedAt)).toBeLessThan(2);
      expect(await run("tinycloud.account.spaces.list", {})).toEqual({ status: "ok", accepted: true });
      lastUse = (await stat(marker)).mtimeMs;
      expect(lastUse).toBeGreaterThan(approvedAt);
    }
    await store.close();
    const saved = collect ? await readFile(path, "utf8") : null;
    const key = await readFile(keyPath, "utf8");
    const copy = new TinyCloudNode(sdkConfig);
    await copy.restoreSession(JSON.parse(saved ?? JSON.stringify({ ...grant, jwk: JSON.parse(key) })) as TinyCloudSession);
    const read = () => copy.kvForSpace(String(grant.spaceId)).list({ prefix: "spaces/" });
    expect((await read()).ok).toBe(true);
    await store.close();

    let readControlStatus: RenewalStatusReader | undefined;
    const readHolderStatus = schedulerBinary === undefined ? undefined : renewalStatusReader(
      node.host, renewal.receipt.nodeIdentity.nodeDid, String(grant.delegationCid), String(grant.verificationMethod), key,
    );
    if (schedulerBinary !== undefined) {
      const control = new RemoteTenantStore({ ...config, stateDir: join(stateDir, "control") });
      const controlRoot = await control.initializeTenant("not-retired").finally(() => control.close());
      const controlGrant = await openKeyDelegation({
        tenantStateRoot: controlRoot, privateKey: REQUESTER_KEY, space: "account",
        abilities: bootstrapAbilities, expiresAt: grantExpiry,
      });
      const controlLease = await signLease(owner, sdkConfig.wasmBindings, controlGrant);
      const controlHeader = controlGrant.delegationHeader as TinyCloudSession["delegationHeader"];
      await advanceClock(Date.now());
      for (const proof of [controlHeader.Authorization, controlLease.receipt.leaseAuthorization]) {
        const response = await fetch(`${node.host}/delegate`, { method: "POST", headers: { Authorization: proof } });
        expect(response.ok, await response.text()).toBe(true);
      }
      readControlStatus = renewalStatusReader(node.host, renewal.receipt.nodeIdentity.nodeDid,
        String(controlGrant.delegationCid), String(controlGrant.verificationMethod),
        await readFile(join(controlRoot, ".tinycloud/profiles/agent/key.json"), "utf8"));
      await advanceClock(grantExpiry.getTime() - 45_000);
      await waitForStamps(readHolderStatus!, 1);
      await waitForStamps(readControlStatus, 1);
    }

    // Drive MCP's calendar without advancing the node's real-time token verifier. The first /info
    // call during retirement restores the real clock before the signer issues its 60-second UCAN.
    const day = 24 * 60 * 60_000;
    const anchor = lastUse ?? (collect ? approvedAt : requestCreated);
    const sweep = async (when: number): Promise<number> => {
      const clock = spyOn(Date, "now").mockReturnValue(when);
      restoreSweepClock = () => {
        clock.mockRestore();
        restoreSweepClock = undefined;
      };
      try {
        return await store.sweepIdleTenants();
      } finally {
        restoreSweepClock?.();
      }
    };
    store = new RemoteTenantStore(config);
    expect(await sweep(anchor + 6 * day - 60_000)).toBe(0);
    expect(retirePosts).toBe(0);
    for (const mode of ["unavailable", "not-recorded"] as const) {
      retireMode = mode;
      expect(await sweep(anchor + 6 * day + 60_000)).toBe(0);
      if (saved === null) await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      else expect(await readFile(path, "utf8")).toBe(saved);
      expect(await readFile(keyPath, "utf8")).toBe(key);
      expect(await readFile(join(root, ".tinycloud/retiring"), "utf8")).toBe("true\n");
      expect((await read()).ok).toBe(true);
      await store.close();
      store = new RemoteTenantStore(config);
    }
    expect(openkey.diagnostics.filter((line) => line.endsWith("idle tenant retirement not confirmed"))).toHaveLength(2);
    retireMode = "node";
    expect(await sweep(anchor + 6 * day + 3_600_000)).toBe(1);
    expect(carried).toEqual([collect ? { delegations: [authorization] } : null]);
    expect(receipts).toEqual([expect.objectContaining({ recorded: true })]);
    await expect(readFile(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
    const refused = await read();
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).toContain("session_retired");
    if (readControlStatus !== undefined && readHolderStatus !== undefined) {
      // The control needs another stamp at this clock value, so an unchanged
      // retired history cannot be explained by the scheduler not having run.
      await advanceClock(grantExpiry.getTime() + 30_000);
      await waitForStamps(readControlStatus, 2);
      const control = await readControlStatus();
      console.info("Loopback renewal generations (live control):", control.renewal_history.map((stamp) => stamp.generation));
      expect((await readHolderStatus()).renewal_history).toHaveLength(1);
    }
    expect(await store.connectStatus(subject, owners)).toMatchObject({ connected: false, approvalUrl: expect.any(String) });
  } finally {
    await store.close();
    openkey.restore();
    globalThis.fetch = upstream;
    resetMcpRegistryFixture();
    await Promise.all([node.stop(), rm(stateDir, { recursive: true, force: true })]);
  }
}

async function signLease(wallet: TinyCloudNode, wasm: NodeWasmBindings, original: Record<string, unknown>) {
  const identity = await wallet.renewalNodeIdentity();
  const signer = new PrivateKeySigner(REQUESTER_KEY);
  const lifetimeSeconds = 90 * 86_400;
  const approvedAt = new Date();
  const expiresAt = new Date(approvedAt.getTime() + lifetimeSeconds * 1000 - 60_000).toISOString();
  const prepared = wasm.prepareSession({
    abilities: {},
    rawAbilities: { [`urn:cid:${String(original.delegationCid)}`]: ["tinycloud.delegation/renew"] },
    address: wasm.ensureEip55(await signer.getAddress()),
    chainId: await signer.getChainId(),
    domain: "mcp.test",
    issuedAt: approvedAt.toISOString(),
    expirationTime: expiresAt,
    spaceId: String(original.spaceId),
    delegateUri: identity.renewerDid,
  });
  const lease = wasm.completeSessionSetup({ ...prepared, signature: await signer.signMessage(prepared.siwe) });
  return {
    version: 1 as const,
    approvedAt: approvedAt.toISOString(),
    approvedLeaseLifetimeSeconds: lifetimeSeconds,
    receipt: {
      originalCid: String(original.delegationCid), leaseCid: lease.delegationCid,
      leaseAuthorization: lease.delegationHeader.Authorization, leaseExpiresAt: expiresAt,
      leaseGeneration: 1, nodeIdentity: identity,
    },
  };
}

type RenewalStatus = { status: string; renewal_history: Array<{ generation: number }> };
type RenewalStatusReader = () => Promise<RenewalStatus>;

function renewalStatusReader(host: string, nodeDid: string, cid: string, holder: string, keyJson: string): RenewalStatusReader {
  const key = createPrivateKey({ key: JSON.parse(keyJson), format: "jwk" });
  return async () => {
    const header = { alg: "EdDSA", typ: "JWT", ucv: "0.10.0" };
    const payload = {
      iss: holder, aud: nodeDid, exp: Math.floor(Date.now() / 1000) + 60, nnc: randomUUID(), prf: [],
      att: { [`urn:cid:${cid}`]: { "tinycloud.delegation/status": [{}] } },
    };
    const signingInput = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const auth = `${signingInput}.${sign(null, Buffer.from(signingInput), key).toString("base64url")}`;
    const response = await fetch(`${host}/delegation/status`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ cid }),
    });
    if (!response.ok) throw new Error(`Status ${response.status}: ${await response.text()}`);
    return await response.json() as RenewalStatus;
  };
}

async function waitForStamps(readStatus: RenewalStatusReader, count: number): Promise<void> {
  const until = performance.now() + 5_000;
  let last: unknown;
  while (performance.now() < until) {
    const status = await readStatus();
    last = status;
    if (status.renewal_history.length >= count) return;
    // The real scheduler wakes on its own 25-ms test-clock interval.
    await Bun.sleep(25);
  }
  throw new Error(`Node did not issue ${count} stamps: ${JSON.stringify(last)}`);
}
