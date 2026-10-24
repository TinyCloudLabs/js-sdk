/**
 * TC-1888: a restore with replication configured and no wallet provider stays fail-closed, with a
 * typed reason instead of `gate_unavailable`. A read-only provider (silent `eth_accounts`; signing
 * methods throw 4200) restores.
 */
import { mkdtempSync } from "node:fs";
import { beforeEach, describe, expect, test } from "bun:test";

// Never touch a real home: every tool home is a temp dir, asserted before any write.
const TEST_HOME = mkdtempSync("/var/tmp/tc1888.");
process.env.HOME = TEST_HOME;
process.env.BUN_INSTALL_CACHE_DIR = TEST_HOME;
if (!process.env.HOME.startsWith("/var/tmp/tc1888.")) throw new Error("test home is not a temp dir");

import { BrowserWalletSigner } from "../src/adapters/BrowserWalletSigner";
import { browserReplicaPlugin } from "../src/replica";

const ADDRESS = "0x00000000000000000000000000000000000000aa";
const PRINCIPAL = `did:pkh:eip155:1:${ADDRESS}`;
const STAMP = { incarnation: "wallet-provider", lifecycleEpoch: 1 };
const cleanReport = { erased: [], failed: [], remaining: 0 };

beforeEach(() => {
  expect(process.env.HOME).toBe(TEST_HOME);
});

function fixture() {
  const counts = { restores: 0, denies: 0 };
  const lifecycle = {
    kind: "indexeddb" as const,
    recover: async () => cleanReport,
    restoreSessionStamp: async () => { counts.restores++; return STAMP; },
    deny: async () => { counts.denies++; return { status: "denied" as const, lifecycleEpoch: 2, intents: 0 }; },
    checkDelivery: () => ({ status: "allow" as const }),
  };
  const replication = { enabled: true, prefixes: ["notes/"], storage: { kind: "indexeddb", lifecycle } };
  return { replication, counts };
}

type Guarded = {
  restoreSessionStamp(principal: string, stamp: typeof STAMP): Promise<typeof STAMP>;
  deny(input: { reason: "sign_out"; principal: string }): Promise<{ status: string }>;
  checkDelivery(stamp: typeof STAMP): { status: string; gate?: string };
};

async function recovered(replication: object, signer?: BrowserWalletSigner): Promise<Guarded> {
  const result = await browserReplicaPlugin.recover(replication as never, signer as never);
  return (result.storage as unknown as { lifecycle: Guarded }).lifecycle;
}

/** A provider whose accounts are readable silently while every signing or prompting method throws 4200. */
function readOnlyProvider(accounts: string[]) {
  const calls: string[] = [];
  const provider = {
    request: async ({ method }: { method: string }) => {
      calls.push(method);
      if (method === "eth_accounts") return accounts;
      throw Object.assign(new Error("The requested method is not authorized."), { code: 4200 });
    },
  };
  return { provider, calls };
}

describe("restore with replication configured and no wallet provider", () => {
  test("is gated with the typed reason, before the lifecycle reads anything", async () => {
    const { replication, counts } = fixture();
    const lifecycle = await recovered(replication);

    await expect(lifecycle.restoreSessionStamp(PRINCIPAL, STAMP))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "wallet_provider_required" });

    expect(counts.restores).toBe(0);
    expect(lifecycle.checkDelivery(STAMP)).toEqual({ status: "gated", gate: "wallet_provider_required" });
  });

  test("stays fail-closed on every attempt, and sign-out still reaches the real deny", async () => {
    const { replication, counts } = fixture();
    const lifecycle = await recovered(replication);

    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(lifecycle.restoreSessionStamp(PRINCIPAL, STAMP))
        .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "wallet_provider_required" });
    }
    expect(await lifecycle.deny({ reason: "sign_out", principal: PRINCIPAL })).toMatchObject({ status: "denied" });

    expect(counts).toEqual({ restores: 0, denies: 1 });
  });
});

describe("restore with a read-only provider", () => {
  test("restores from the silent eth_accounts alone and never calls a signing method", async () => {
    const { replication, counts } = fixture();
    const { provider, calls } = readOnlyProvider([ADDRESS]);
    const lifecycle = await recovered(replication, new BrowserWalletSigner(provider as never));

    await expect(lifecycle.restoreSessionStamp(PRINCIPAL, STAMP)).resolves.toEqual(STAMP);

    expect(counts.restores).toBe(1);
    expect(new Set(calls)).toEqual(new Set(["eth_accounts"]));
  });

  test("a provider with no connected account keeps the generic gate_unavailable", async () => {
    const { replication, counts } = fixture();
    const lifecycle = await recovered(replication, new BrowserWalletSigner(readOnlyProvider([]).provider as never));

    await expect(lifecycle.restoreSessionStamp(PRINCIPAL, STAMP))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "gate_unavailable" });
    expect(counts.restores).toBe(0);
  });

  test("a provider connected to another account keeps principal_mismatch", async () => {
    const { replication, counts } = fixture();
    const other = "0x00000000000000000000000000000000000000bb";
    const lifecycle = await recovered(replication, new BrowserWalletSigner(readOnlyProvider([other]).provider as never));

    await expect(lifecycle.restoreSessionStamp(PRINCIPAL, STAMP))
      .rejects.toMatchObject({ code: "REPLICA_GATED", gate: "principal_mismatch" });
    expect(counts.restores).toBe(0);
  });
});
