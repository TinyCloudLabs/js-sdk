import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { extractRecapAttenuations } from "@tinycloud/sdk-core";
import { NodeUserAuthorization } from "./NodeUserAuthorization";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { PrivateKeySigner } from "../signers/PrivateKeySigner";
import { unregisteredLocationRegistryResponse } from "../test-support/unregistered-location-registry";

const REGISTRY_ORIGIN = "https://registry.without-app-host.test";
const WARNED = Symbol.for("tinycloud.warnedWithoutAppHost");
const SHARED_FOLDER_LINE =
  "TinyCloud: this app has no domain, so it shares the folder applications/node.app/ with every other app that has none. " +
  'Set `domain` (for example `domain: "notes.example.com"`) or pass a manifest to give it a folder of its own.';

let originalFetch: typeof fetch;
let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  delete (globalThis as { [WARNED]?: true })[WARNED];
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
  delete (globalThis as { [WARNED]?: true })[WARNED];
});

function auth(extra: Partial<ConstructorParameters<typeof NodeUserAuthorization>[0]> = {}) {
  return new NodeUserAuthorization({
    tinycloudRegistryUrl: REGISTRY_ORIGIN,
    signer: new PrivateKeySigner("1".padStart(64, "0")),
    wasmBindings: new NodeWasmBindings(),
    tinycloudHosts: ["https://tinycloud.test"],
    // TinyCloudNode signs with a default SIWE domain and passes no app host when the app set no `domain`.
    domain: "login.tinycloud.test",
    signStrategy: { type: "auto-sign" },
    enablePublicSpace: false,
    genericAppHost: null,
    ...extra,
  });
}

const sharedFolderLines = () => warn.mock.calls.filter(([message]: unknown[]) => String(message).startsWith("TinyCloud: this app has no domain"));

test("a sign-in without a domain or a manifest says once per process that its folder is shared", async () => {
  const first = auth();
  const session = await first.signIn();
  expect(Object.keys(extractRecapAttenuations(session.siwe!)).some((uri) => uri.endsWith("/kv/node.app/"))).toBe(true);
  await first.signIn();
  await auth().prepareOpenKeySignIn();
  expect(sharedFolderLines()).toEqual([[SHARED_FOLDER_LINE]]);
});

test("a sign-in with a domain, a port or a manifest does not say it", async () => {
  await auth({ genericAppHost: "notes.example.com:8443" }).signIn();
  await auth({ genericAppHost: "[::1]:3000" }).signIn();
  await auth({ manifest: { app_id: "com.example.declared", name: "Declared" } }).signIn();
  expect(sharedFolderLines()).toEqual([]);
});
