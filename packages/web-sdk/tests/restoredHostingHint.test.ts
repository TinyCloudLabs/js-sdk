import "./support/browserGlobalsShim";
import { expect, mock, test } from "bun:test";
import type { PersistedSessionData } from "@tinycloud/sdk-core";
import type { TinyCloudWeb as TinyCloudWebType } from "../src/modules/tcw";

const { TinyCloudWeb } = require("../src/modules/tcw") as { TinyCloudWeb: typeof TinyCloudWebType };
const ADDRESS = "0x96F7fB7ed32640d9D3a982f67CD6c09fc53EBEF1";
const HOST = "https://node.test.local";
const SPACE = `tinycloud:pkh:eip155:1:${ADDRESS}:default`;
type Hosting = "hosted" | "not-hosted" | "unknown";

async function fixture(options: {
  hint?: "hosted" | "not-hosted";
  restoredHost?: string;
  restoredSpace?: string;
  priorAddress?: string;
  priorChainId?: number;
  priorHosting?: Hosting;
} = {}) {
  const record: PersistedSessionData = {
    address: ADDRESS,
    chainId: 1,
    sessionKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", d: "private" }),
    siwe: "siwe",
    signature: "signature",
    tinycloudSession: {
      delegationHeader: { Authorization: "Bearer persisted" },
      delegationCid: "persisted",
      spaceId: SPACE,
      verificationMethod: "did:key:fixture",
    },
    tinycloudHosts: [HOST],
    expiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    version: "1.0",
    ...(options.hint ? { spaceHosting: options.hint } : {}),
  };
  const storage = {
    save: mock(async () => undefined),
    load: mock(async () => record),
    clear: mock(async () => undefined),
  };
  const tcw = new TinyCloudWeb({
    sessionStorage: storage,
    ui: false,
    includeAccountRegistryPermissions: false,
    autoBootstrapAccount: false,
  });
  const state = tcw as unknown as {
    _initPromise: Promise<unknown>;
    _node: unknown;
    restoredNetworkWork: { hosting: Promise<void> };
  };
  await state._initPromise;
  const probe = Promise.withResolvers<Hosting>();
  const node = {
    hosts: [options.restoredHost ?? HOST],
    spaceId: options.restoredSpace ?? SPACE,
    spaceHosting: options.priorHosting ?? "unknown" as Hosting,
    restorableSession: {
      address: options.priorAddress ?? ADDRESS,
      chainId: options.priorChainId ?? 1,
    },
    restoreSession: mock(async () => {
      node.spaceHosting = "unknown";
      node.restorableSession = { address: ADDRESS, chainId: 1 };
    }),
    checkSpaceHosting: mock(async () => {
      node.spaceHosting = await probe.promise;
      return node.spaceHosting;
    }),
  };
  state._node = node;
  state._initPromise = Promise.resolve();
  return { tcw, state, node, storage, record, probe };
}

test("a matching stored hint is display-only and the probe corrects it at runtime", async () => {
  const env = await fixture({ hint: "hosted" });
  expect((await env.tcw.restoreSession(ADDRESS)).status).toBe("restored");
  expect(env.tcw.spaceHosting).toBe("hosted");
  expect(env.node.spaceHosting).toBe("unknown");
  expect(env.node.checkSpaceHosting).not.toHaveBeenCalled();

  env.probe.resolve("not-hosted");
  await env.state.restoredNetworkWork.hosting;
  expect(env.tcw.spaceHosting).toBe("not-hosted");
  expect(env.record.spaceHosting).toBe("hosted");
  expect(env.storage.save).not.toHaveBeenCalled();

  const reload = await fixture({ hint: env.record.spaceHosting });
  await reload.tcw.restoreSession(ADDRESS);
  expect(reload.tcw.spaceHosting).toBe("hosted");
  reload.probe.resolve("not-hosted");
  await reload.state.restoredNetworkWork.hosting;
  expect(reload.tcw.spaceHosting).toBe("not-hosted");
});

for (const mismatch of [
  { restoredHost: "https://other-node.test.local" },
  { restoredSpace: `${SPACE}-other` },
]) {
  test(`a stored hint is suppressed for ${JSON.stringify(mismatch)}`, async () => {
    const env = await fixture({ hint: "hosted", ...mismatch });
    await env.tcw.restoreSession(ADDRESS);
    expect(env.tcw.spaceHosting).toBe("unknown");
    env.probe.resolve("not-hosted");
    await env.state.restoredNetworkWork.hosting;
    expect(env.tcw.spaceHosting).toBe("not-hosted");
  });
}

for (const account of [
  { priorAddress: "0x0000000000000000000000000000000000000001" },
  { priorChainId: 137 },
]) {
  test(`an observation from another account is suppressed for ${JSON.stringify(account)}`, async () => {
    const env = await fixture({ priorHosting: "hosted", ...account });
    await env.tcw.restoreSession(ADDRESS);
    expect(env.tcw.spaceHosting).toBe("unknown");
    env.probe.resolve("not-hosted");
    await env.state.restoredNetworkWork.hosting;
  });
}

test("the same account, space and host retain their latest observation until probing", async () => {
  const env = await fixture({ priorHosting: "hosted" });
  await env.tcw.restoreSession(ADDRESS);
  expect(env.tcw.spaceHosting).toBe("hosted");
  env.probe.resolve("not-hosted");
  await env.state.restoredNetworkWork.hosting;
  expect(env.tcw.spaceHosting).toBe("not-hosted");
});

test("an older record starts unknown and updates after the automatic probe", async () => {
  const env = await fixture();
  await env.tcw.restoreSession(ADDRESS);
  expect(env.tcw.spaceHosting).toBe("unknown");
  env.probe.resolve("hosted");
  await env.state.restoredNetworkWork.hosting;
  expect(env.tcw.spaceHosting).toBe("hosted");
});

test("an unknown probe answer replaces a matching stored hint", async () => {
  const env = await fixture({ hint: "hosted" });
  await env.tcw.restoreSession(ADDRESS);
  expect(env.tcw.spaceHosting).toBe("hosted");
  env.probe.resolve("unknown");
  await env.state.restoredNetworkWork.hosting;
  expect(env.tcw.spaceHosting).toBe("unknown");
});
