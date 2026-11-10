import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Wallet, utils } from "ethers";
import { SiweMessage } from "siwe";
import { NodeUserAuthorization } from "./NodeUserAuthorization";
import { NodeWasmBindings } from "../NodeWasmBindings";
import { BrowserWasmBindings } from "../../../web-sdk/src/adapters/BrowserWasmBindings";
import type { IWasmBindings } from "@tinycloud/sdk-core";

const wallet = new Wallet(`0x${"11".repeat(32)}`);
const now = new Date("2028-02-29T12:34:56.789Z");
const limit = "2029-02-28T12:34:56.789Z";
const space = `tinycloud:pkh:eip155:1:${wallet.address}:credentials`;
const originalFetch = globalThis.fetch;

afterEach(() => {
  setSystemTime();
  globalThis.fetch = originalFetch;
});

async function hosting(wasm: IWasmBindings, expirationTime?: string) {
  setSystemTime(now);
  await wasm.ensureInitialized?.();
  const signed: Array<{ siwe: string; signature: string }> = [];
  const auth = new NodeUserAuthorization({
    signer: {
      getAddress: async () => wallet.address,
      getChainId: async () => 1,
      signMessage: async (siwe) => {
        const signature = await wallet.signMessage(siwe);
        signed.push({ siwe, signature });
        return signature;
      },
    },
    wasmBindings: wasm,
    tinycloudHosts: ["https://node.test"],
    autoCreateSpace: true,
    domain: "localhost",
    signStrategy: { type: "auto-sign" },
    ...(expirationTime === undefined ? {} : { siweConfig: { expirationTime } }),
  });
  // Start with an established account session; routing is independent of message construction.
  Reflect.set(auth, "_address", wallet.address);
  Reflect.set(auth, "_chainId", 1);
  Reflect.set(auth, "_tinyCloudSession", { address: wallet.address, chainId: 1, spaceId: space, delegationHeader: { Authorization: "session" } });
  Reflect.set(auth, "ensureTinyCloudHosts", async () => {});
  let hosted = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/peer/generate/")) return new Response("did:key:z6MkrJVnaZkeFzdQyMZu7cSo2hVXKC1WG63csUyBp8X8Jza7");
    if (url.endsWith("/delegate")) {
      if (!hosted && new Headers(init?.headers).get("authorization") === "session") {
        return Response.json({ activated: [], skipped: [space] });
      }
      hosted = true;
      return Response.json({ activated: [space], skipped: [] });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { auth, signed };
}

function assertExpiry(signed: { siwe: string; signature: string }, expected: string) {
  const lines = signed.siwe.split("\n");
  const issuedAt = lines.findIndex((line) => line.startsWith("Issued At: "));
  expect(lines.filter((line) => line.startsWith("Expiration Time:"))).toEqual([`Expiration Time: ${expected}`]);
  expect(lines[issuedAt + 1]).toBe(`Expiration Time: ${expected}`);
  expect(signed.siwe).not.toMatch(/[\r\u0085\u2028\u2029]/);
  expect(new SiweMessage(signed.siwe).expirationTime).toBe(expected);
  expect(utils.verifyMessage(signed.siwe, signed.signature)).toBe(wallet.address);
}

for (const [platform, bindings] of [
  ["node", () => new NodeWasmBindings()],
  ["web", () => new BrowserWasmBindings()],
] as const) {
  test(`${platform} primary-space creation signs the bounded host expiry`, async () => {
    const { auth, signed } = await hosting(bindings());
    await auth.ensureSpaceExists();
    assertExpiry(signed[0], limit);
  });
  for (const path of ["hostOwnedSpace", "hostPublicSpace"] as const) {
    test(`${platform} ${path} signs one calendar-year expiry with leap-day clamping`, async () => {
      const { auth, signed } = await hosting(bindings());
      expect(await auth[path](space)).toBe(true);
      assertExpiry(signed[0], limit);
    });
  }
  test(`${platform} hosting preserves a shorter caller expiry`, async () => {
    const expiry = "2028-03-01T01:02:03.000Z";
    const { auth, signed } = await hosting(bindings(), expiry);
    await auth.hostOwnedSpace(space);
    assertExpiry(signed[0], expiry);
  });
  test(`${platform} hosting clamps a longer caller expiry to its tier`, async () => {
    const { auth, signed } = await hosting(bindings(), "2038-02-28T12:34:56.789Z");
    await auth.hostOwnedSpace(space);
    assertExpiry(signed[0], limit);
  });
}

for (const separator of ["\r", "\u0085", "\u2028", "\u2029"]) {
  test(`hosting refuses unsupported separator U+${separator.charCodeAt(0).toString(16)} before signing`, async () => {
    const wasm = new NodeWasmBindings();
    const generate = wasm.generateHostSIWEMessage;
    wasm.generateHostSIWEMessage = (params) => generate(params) + separator;
    const { auth, signed } = await hosting(wasm);
    await expect(auth.hostOwnedSpace(space)).rejects.toThrow("line separator");
    expect(signed).toEqual([]);
  });
}

test("hosting refuses an existing expiry before signing", async () => {
  const wasm = new NodeWasmBindings();
  const generate = wasm.generateHostSIWEMessage;
  wasm.generateHostSIWEMessage = (params) => generate(params) + `\nExpiration Time: ${limit}`;
  const { auth, signed } = await hosting(wasm);
  await expect(auth.hostOwnedSpace(space)).rejects.toThrow("Expiration Time");
  expect(signed).toEqual([]);
});

for (const expiry of ["not-a-date", "2028-02-28T12:34:56.789Z"]) {
  test(`hosting refuses invalid or elapsed caller expiry ${expiry}`, async () => {
    const { auth, signed } = await hosting(new NodeWasmBindings(), expiry);
    await expect(auth.hostOwnedSpace(space)).rejects.toThrow("expiry");
    expect(signed).toEqual([]);
  });
}
