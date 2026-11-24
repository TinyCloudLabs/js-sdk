import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseSignedSiweCacao, type DelegationStatus, type TinyCloudSession } from "@tinycloud/sdk-core";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import "./replication/node-loader";
import { TinyCloudNode } from "./TinyCloudNode";
import { startLocalNode, type LocalNode } from "./test-support/local-node";
import { startUnregisteredLocationRegistry, type UnregisteredLocationRegistry } from "./test-support/unregistered-location-registry";

// TC-3522: what a renewal lease lets a real node do, and what it never lets it do. Needs a node that renews
// (tinycloud-node 1.26 or later); TC_RENEWAL_E2E_NODE_BIN names it, and the suite is skipped without it.
//
// The node's scheduler renews a lease-held grant once half its period remains, checking every 5 minutes, so one run
// takes about 20 minutes. Three owners share one node, each with a 17-minute grant:
//   A: a lease to minute 19. Renewed once, to the lease's end and no further: the grant works past its signed end and
//      stops at the lease's end. A peer grant issued from the renewed grant reaches past the grant's signed end, the
//      node honours it there, and it stops by the lease's end.
//   B: a lease the owner revokes at once. Never renewed; the grant and its peer end at their signed 17 minutes.
//   C: a lease whose grant the owner revokes. The peer stops at once and the grant is never renewed.
const nodeBinary = process.env.TC_RENEWAL_E2E_NODE_BIN;
const MINUTE = 60_000;
const GRANT_MS = 17 * MINUTE;
const RUN_MS = 30 * MINUTE;

// Real time on purpose: the node's renewal scheduler runs on its own clock, which a test cannot move.
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function randomKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}

async function signedEnd(authorization: string): Promise<number> {
  const cacao = await parseSignedSiweCacao(authorization.replace(/^Bearer\s+/i, ""));
  return Date.parse(cacao.expiresAt!);
}

describe.skipIf(!nodeBinary)("a renewal lease on a real node", () => {
  let node: LocalNode;
  let registry: UnregisteredLocationRegistry;
  const config = () => ({ host: node.host, tinycloudRegistryUrl: registry.url.origin, wasmBindings: new NodeWasmBindings(), autoBootstrapAccount: false });

  beforeAll(async () => {
    registry = startUnregisteredLocationRegistry();
    node = await startLocalNode(nodeBinary!, "/var/tmp/tc3522-renewal-lease-");
  }, 60_000);
  afterAll(async () => {
    await node?.stop();
    registry?.stop(true);
  });

  /** An owner with a GRANT_MS session (the grant), one stored value, and a lease to `leaseEnd`. */
  async function owner(name: string, leaseEnd: number) {
    const wallet = new TinyCloudNode({ ...config(), signer: new PrivateKeySigner(randomKey()),
      domain: "renewal-lease.test", autoCreateSpace: true, enablePublicSpace: false, sessionExpirationMs: GRANT_MS });
    await wallet.signIn();
    expect((await wallet.kv.put(`${name}/value`, name)).ok).toBe(true);
    const grant = wallet.restorableSession!;
    const lease = await wallet.createRenewalLease(new Date(leaseEnd));
    return { wallet, grant, lease, grantEnd: await signedEnd(grant.delegationHeader.Authorization) };
  }

  async function agentFor(grant: TinyCloudSession): Promise<TinyCloudNode> {
    const agent = new TinyCloudNode(config());
    await agent.restoreSession({ ...grant, tinycloudHosts: [node.host] });
    return agent;
  }

  /** The agent issues a peer a read grant asking for an hour; returns the peer's access and the grant's CID and end. */
  async function peerGrant(agent: TinyCloudNode, name: string) {
    const peer = new TinyCloudNode(config());
    const issued = await agent.delegateTo(peer.did.split("#")[0]!, [
      { service: "tinycloud.kv", space: agent.restorableSession!.spaceId, path: `${name}/`, actions: ["tinycloud.kv/get"] },
    ], { expiry: "1h" });
    const access = await peer.useDelegation(issued.delegation);
    return { access, cid: issued.delegation.cid, end: issued.delegation.expiry.getTime() };
  }

  test("a lease renews a grant to the lease's end and no further; a revoked lease or grant renews nothing; peers end with them", async () => {
    const t0 = Date.now();
    // B and C first, so the scheduler pass that renews A has already reached them.
    const b = await owner("b", t0 + 60 * MINUTE);
    const c = await owner("c", t0 + 60 * MINUTE);
    const a = await owner("a", t0 + 19 * MINUTE);

    expect((await b.wallet.revokeDelegation(b.lease.leaseCid)).ok).toBe(true);
    const bAgent = await agentFor(b.grant);
    const bPeer = await peerGrant(bAgent, "b");
    expect(bPeer.end).toBeLessThanOrEqual(b.grantEnd);
    expect((await bPeer.access.kv.get("value")).ok).toBe(true);

    const cPeer = await peerGrant(await agentFor(c.grant), "c");
    expect((await cPeer.access.kv.get("value")).ok).toBe(true);
    expect((await c.wallet.revokeDelegation(c.grant.delegationCid)).ok).toBe(true);
    expect((await cPeer.access.kv.get("value")).ok).toBe(false);

    // Wait for the node to renew A.
    let renewed: DelegationStatus | undefined;
    while (Date.now() < a.grantEnd) {
      const status = await a.wallet.getDelegationStatus(a.grant.delegationCid);
      if (status.ok && (status.data.renewal_history?.length ?? 0) > 0) { renewed = status.data; break; }
      await sleep(15_000);
    }
    if (!renewed) throw new Error("A was not renewed before its signed end");
    const leaseEnd = Math.floor(Date.parse(a.lease.leaseExpiresAt) / 1000);
    expect(renewed.effective_expiry).toBe(leaseEnd);

    // The renewed grant restores to the lease's end. A peer grant from it, asking for an hour, reaches past the grant's
    // signed end and ends by the lease's.
    const aAgent = new TinyCloudNode(config());
    await aAgent.restoreSessionWithRenewal({ ...a.grant, tinycloudHosts: [node.host] }, a.lease.leaseAuthorization);
    expect(aAgent.sessionEnd?.getTime()).toBe(leaseEnd * 1000);
    const aPeer = await peerGrant(aAgent, "a");
    expect(aPeer.end).toBeGreaterThan(a.grantEnd);
    expect(aPeer.end).toBeLessThanOrEqual(leaseEnd * 1000);
    const aPeerStatus = await a.wallet.getDelegationStatus(aPeer.cid);
    expect(aPeerStatus.ok && aPeerStatus.data.effective_expiry).toBeLessThanOrEqual(leaseEnd);
    expect((await aPeer.access.kv.get("value")).ok).toBe(true);

    // The same pass reached B and C: neither was renewed, and neither restores through its lease.
    for (const { wallet, grant, lease } of [b, c]) {
      const status = await wallet.getDelegationStatus(grant.delegationCid);
      expect(status.ok && (status.data.renewal_history ?? []).length).toBe(0);
      const candidate = new TinyCloudNode(config());
      await expect(candidate.restoreSessionWithRenewal({ ...grant, tinycloudHosts: [node.host] }, lease.leaseAuthorization)).rejects.toThrow();
    }

    // Past the grants' signed ends: B and its peer have stopped; A and its peer still work through A's renewal.
    await sleep(Math.max(0, Math.max(a.grantEnd, b.grantEnd) - Date.now()) + 5_000);
    expect((await bPeer.access.kv.get("value")).ok).toBe(false);
    expect((await bAgent.kv.get("b/value")).ok).toBe(false);
    expect((await aAgent.kv.get("a/value")).ok).toBe(true);
    expect((await aPeer.access.kv.get("value")).ok).toBe(true);

    // A and its peer stop at the lease's end, and A is not renewed past it.
    await sleep(Math.max(0, leaseEnd * 1000 - Date.now()) + 5_000);
    expect((await aAgent.kv.get("a/value")).ok).toBe(false);
    expect((await aPeer.access.kv.get("value")).ok).toBe(false);
    const after = await a.wallet.getDelegationStatus(a.grant.delegationCid);
    expect(after.ok && after.data.active).toBe(false);
    expect(after.ok && after.data.renewal_history?.length).toBe(renewed.renewal_history?.length);
  }, RUN_MS);
});
