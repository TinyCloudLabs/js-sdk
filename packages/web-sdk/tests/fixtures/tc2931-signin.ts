import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { privateKeyToAccount } from "viem/accounts";
import { ed25519 } from "@noble/curves/ed25519";
import { bases } from "multiformats/basics";
import { SiweMessage } from "siwe";
import { REGISTRY_NOT_FOUND_BODY, pkhDid, createInMemoryRegistryCacheStore, createInMemoryRegistrySequenceStore } from "@tinycloud/sdk-core";
import { signedLocationRecordForTest, signedRegistryResponseForTest } from "../../../node-sdk/src/test-support/restored-policy-node";

const privateKey = `0x${"13".repeat(32)}` as const;
const account = privateKeyToAccount(privateKey);
const nodeDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 1, ...ed25519.getPublicKey(new Uint8Array(32).fill(7))]))}`;
const ownerDid = pkhDid(account.address, 1);
const space = (name: string) => `tinycloud:pkh:eip155:1:${account.address}:${name}`;
const record = await signedLocationRecordForTest({ ownerDid, ownerPrivateKey: privateKey, host: "https://node.test", nodeDid, spaces: [space("applications"), space("account"), space("default"), space("secrets")], sequence: 1 });
const results: object[] = [];
let TinyCloudWeb: typeof import("../../src/modules/tcw").TinyCloudWeb;
const { TinyCloudNode } = await import("@tinycloud/node-sdk");
for (const config of [
  { name: "third-party default", origin: "https://notes.example", rows: 1 },
  { name: "third-party cannot opt in", origin: "https://notes.example", rows: 1, autoBootstrapAccount: true, includeAccountRegistryPermissions: true },
  { name: "domain override cannot opt in", origin: "https://notes.example", rows: 1, domain: "home.tinycloud.xyz" },
  { name: "first-party unchanged", origin: "https://home.tinycloud.xyz", rows: 8 },
  { name: "first-party explicit opt out", origin: "https://home.tinycloud.xyz", rows: 1, autoBootstrapAccount: false, includeAccountRegistryPermissions: true },
  { name: "direct node explicit opt out", origin: "https://home.tinycloud.xyz", rows: 1, directNode: true, autoBootstrapAccount: false, includeAccountRegistryPermissions: true },
  { name: "new account needs first-party setup", origin: "https://notes.example", error: "ACCOUNT_SETUP_REQUIRED", registered: false },
  { name: "prepared OpenKey request requires setup before signing", origin: "https://notes.example", directNode: true, prepareOnly: true, requireExistingAccount: true, error: "ACCOUNT_SETUP_REQUIRED", registered: false },
  { name: "unknown registry remains unavailable", origin: "https://notes.example", error: "unavailable", unavailable: true },
]) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: config.origin, pretendToBeVisual: true });
  for (const key of ["window", "document", "HTMLElement", "customElements", "localStorage", "navigator"] as const) {
    Object.defineProperty(globalThis, key, { value: key === "window" ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  TinyCloudWeb ??= (await import("../../src/modules/tcw")).TinyCloudWeb;
  const signed: string[] = [];
  const fetches: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    fetches.push(url.pathname);
    if (url.origin === "https://registry.test") {
      if (config.unavailable) return new Response("unavailable", { status: 503 });
      if (config.registered === false) return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 });
      const response = signedRegistryResponseForTest(input, init, "https://registry.test", record);
      if (response) return response;
    }
    if (url.origin === "https://node.test") {
      if (url.pathname === "/info") return Response.json({ nodeId: nodeDid, protocol: 1, version: "1.26.2", features: [] });
      if (url.pathname === "/.well-known/tinycloud/node-keys") return Response.json({ nodeDid });
      if (url.pathname === "/delegate") return Response.json({ activated: record.spaces.map((entry) => entry.space), skipped: [] });
      if (url.pathname === "/invoke") return Response.json({ data: [] });
    }
    throw new Error(`Unexpected fixture request ${url.origin}${url.pathname}`);
  }) as typeof fetch;
  const provider = { request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [account.address];
    if (method === "eth_chainId") return "0x1";
    if (method === "personal_sign") {
      const message = String(params?.[0]);
      const text = message.startsWith("0x") ? Buffer.from(message.slice(2), "hex").toString() : message;
      signed.push(text);
      return account.signMessage({ message: text });
    }
    throw new Error(`Unexpected wallet method ${method}`);
  } };
  const options = {
    provider, ui: false, persistSession: false, autoDiscoverLocalNode: false,
    registryCacheStore: createInMemoryRegistryCacheStore(), registrySequenceStore: createInMemoryRegistrySequenceStore(),
    tinycloudHosts: ["https://node.test"], tinycloudRegistryUrl: "https://registry.test",
    manifest: { app_id: "tc2931-notes", name: "Notes", defaults: false, includePublicSpace: false, permissions: [{ service: "tinycloud.kv", path: "notes/", actions: ["get", "put"] }] },
    ...(config.autoBootstrapAccount === undefined ? {} : { autoBootstrapAccount: config.autoBootstrapAccount }),
    ...(config.includeAccountRegistryPermissions === undefined ? {} : { includeAccountRegistryPermissions: config.includeAccountRegistryPermissions }),
    ...(config.domain === undefined ? {} : { domain: config.domain }),
  };
  const app = config.directNode ? new TinyCloudNode({
    ...options, host: "https://node.test", requireExistingAccount: config.requireExistingAccount, signer: {
      getAddress: async () => account.address, getChainId: async () => 1,
      signMessage: async (message) => {
        signed.push(String(message));
        return account.signMessage({ message: String(message) });
      },
    },
  }) : new TinyCloudWeb(options);
  try {
    if (config.error) {
      let failure: any;
      try {
        if (config.prepareOnly) await (app as InstanceType<typeof TinyCloudNode>).prepareOpenKeySignIn();
        else await app.signIn();
      } catch (error) { failure = error; }
      assert(failure, config.name);
      assert.equal(signed.length, 0, config.name);
      assert(!fetches.includes("/delegate"), config.name);
      if (config.error === "ACCOUNT_SETUP_REQUIRED") {
        assert.equal(failure.code, config.error);
        assert.equal(failure.setupUrl, "https://home.tinycloud.xyz/");
      } else assert.notEqual(failure.code, "ACCOUNT_SETUP_REQUIRED");
      results.push({ name: config.name, refusedBeforeSignature: true });
    } else {
      await app.signIn();
      assert.equal(signed.length, 1, config.name);
      const recap = new SiweMessage(signed[0]!).resources!.at(-1)!;
      const attenuation = JSON.parse(Buffer.from(recap.slice("urn:recap:".length), "base64url").toString()).att;
      assert.equal(Object.keys(attenuation).length, config.rows, config.name);
      if (config.rows === 1) assert.deepEqual(Object.keys(attenuation), [`${space("applications")}/kv/tc2931-notes/notes/`]);
      results.push({ name: config.name, rows: Object.keys(attenuation).length });
    }
  } finally {
    await app.signOut();
    dom.window.close();
  }
}
console.log(JSON.stringify({ tc2931: results }));
