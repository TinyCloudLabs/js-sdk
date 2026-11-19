import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { SiweMessage } from "siwe";
import { extractRecapAttenuations, genericAppId, ownerFullAccess } from "@tinycloud/sdk-core";
import { NodeUserAuthorization } from "./NodeUserAuthorization";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";
import { TinyCloudNode } from "../index";
import { unregisteredLocationRegistryResponse } from "../test-support/unregistered-location-registry";

const REGISTRY_ORIGIN = "https://registry.generic-manifest.test";
const DAY_MS = 24 * 60 * 60 * 1000;
const warning = (appId: string) =>
  `TinyCloud: this app signed in without a manifest, so its session covers only its own folder (applications/${appId}/) and lasts 7 days. ` +
  "To ask for what your app needs, pass a manifest: https://docs.tinycloud.xyz/reference/protocol/app-manifests";

let originalFetch: typeof fetch;
let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const registryResponse = unregisteredLocationRegistryResponse(input, REGISTRY_ORIGIN, init);
    if (registryResponse) return registryResponse;
    const url = String(input);
    if (url.endsWith("/info")) return Response.json({ protocol: 1, version: "1.0.0", features: [] });
    if (url.endsWith("/delegate") && init?.method === "POST") return Response.json({ activated: ["space"], skipped: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  warn.mockRestore();
});

function auth(extra: Partial<ConstructorParameters<typeof NodeUserAuthorization>[0]> = {}) {
  return new NodeUserAuthorization({
    tinycloudRegistryUrl: REGISTRY_ORIGIN,
    signer: new PrivateKeySigner("1".padStart(64, "0")),
    wasmBindings: new NodeWasmBindings(),
    domain: "notes.example.com:8443",
    tinycloudHosts: ["https://tinycloud.test"],
    signStrategy: { type: "auto-sign" },
    enablePublicSpace: false,
    ...extra,
  });
}

const genericWarnings = () =>
  warn.mock.calls.filter(([message]) => String(message).startsWith("TinyCloud: this app signed in without a manifest"));

test("a sign-in that declares nothing signs only the app's own folder, for 7 days", async () => {
  const before = Date.now();
  const session = await auth().signIn();
  const resources = Object.keys(extractRecapAttenuations(session.siwe!)).map((uri) => uri.replace(/^.*?:(?=[a-z]+\/)/, ""));
  expect(resources.sort()).toEqual([
    "applications/capabilities",
    "applications/kv/com.example.notes/",
    "applications/sql/com.example.notes/",
  ]);
  const expiry = new Date(new SiweMessage(session.siwe!).expirationTime!).getTime();
  expect(expiry - before).toBeGreaterThan(7 * DAY_MS - 60_000);
  expect(expiry - before).toBeLessThanOrEqual(7 * DAY_MS + 60_000);
});

test("each generic sign-in warns once, on the plain and the prepared path", async () => {
  const a = auth();
  await a.signIn();
  expect(genericWarnings()).toEqual([[warning("com.example.notes")]]);
  await a.prepareOpenKeySignIn();
  expect(genericWarnings()).toEqual([[warning("com.example.notes")], [warning("com.example.notes")]]);
});

test("declared sign-ins neither warn nor use the generic folder", async () => {
  const declared = [
    auth({ manifest: { app_id: "com.example.declared", name: "Declared" } }),
    auth({ ...ownerFullAccess("default") }),
  ];
  for (const a of declared) {
    const session = await a.signIn();
    expect(Object.keys(extractRecapAttenuations(session.siwe!)).some((uri) => uri.includes("com.example.notes"))).toBe(false);
  }
  expect(genericWarnings()).toEqual([]);
});

test("a Node client without a domain names its folder node.app, not the SIWE default domain", () => {
  const config = { privateKey: "1".padStart(64, "0"), host: "https://tinycloud.test" };
  expect(new TinyCloudNode(config).auth!.capabilityRequest!.manifests.map((m) => m.app_id)).toEqual(["node.app"]);
  const named = new TinyCloudNode({ ...config, domain: "notes.example.com" });
  expect(named.auth!.capabilityRequest!.manifests.map((m) => m.app_id)).toEqual(["com.example.notes"]);
});

test("generic app ids reverse the host name and fall back to node.app", () => {
  expect(genericAppId("Notes.Example.com:3000")).toBe("com.example.notes");
  expect(genericAppId("localhost")).toBe("localhost");
  for (const host of [undefined, null, "", "[::1]:3000", "bad_host.example"]) expect(genericAppId(host)).toBe("node.app");
});
