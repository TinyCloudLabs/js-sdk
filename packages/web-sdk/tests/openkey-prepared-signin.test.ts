import "./support/browserGlobalsShim";
import { expect, mock, test } from "bun:test";

const address = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const open = mock(() => ({}));
Object.assign(globalThis, {
  window: {
    location: { host: "example.test", hostname: "example.test", origin: "https://example.test" },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    open,
  },
});

// Use the real TinyCloudWeb, TinyCloudNode, and authorization bridge. Only
// the wallet transport and OpenKey approval result are controlled by the test.
const { TinyCloudWeb } = require("../src/modules/tcw");

function client() {
  const modes: unknown[] = [];
  const legacyCalls: string[] = [];
  const openkey = {
    authorizeTinyCloud(_request: unknown, opts: unknown) {
      modes.push(opts);
      window.open("https://openkey.example.test/widget/sign", "openkey");
      return Promise.reject(new Error("approval stopped by test"));
    },
    signMessage() {
      legacyCalls.push("signMessage");
      throw new Error("Legacy signing called");
    },
  };
  const provider = {
    request: async ({ method }: { method: string }) => {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [address];
      if (method === "eth_chainId") return "0x1";
      legacyCalls.push(method);
      throw new Error(`Unexpected wallet method: ${method}`);
    },
  };
  return {
    modes,
    legacyCalls,
    create: () => TinyCloudWeb.create({
      provider,
      openkey: { client: openkey },
      tinycloudHosts: ["https://node.example.test"],
      autoDiscoverLocalNode: false,
      persistSession: false,
      ui: false,
    }),
  };
}

test("prepared OpenKey sign-in opens the popup in the click handler", async () => {
  open.mockClear();
  const setup = client();
  const web = await setup.create();
  await web.prepareSignIn();
  let beforeFirstMicrotask = false;
  const click = () => {
    const signing = web.signIn();
    beforeFirstMicrotask = open.mock.calls.length === 1;
    return signing;
  };
  await expect(click()).rejects.toThrow("approval stopped by test");
  expect(beforeFirstMicrotask).toBe(true);
  expect(setup.modes).toEqual([{ mode: "popup" }]);
  expect(setup.legacyCalls).toEqual([]);
});

test("OpenKey sign-in without preparation opens after the click handler", async () => {
  open.mockClear();
  const setup = client();
  const web = await setup.create();
  const signing = web.signIn();
  expect(open.mock.calls).toHaveLength(0);
  await expect(signing).rejects.toThrow("approval stopped by test");
  expect(open.mock.calls).toHaveLength(1);
  expect(setup.modes).toEqual([{ mode: "popup" }]);
  expect(setup.legacyCalls).toEqual([]);
});

test("an expired prepared request needs preparation before another click", async () => {
  open.mockClear();
  const setup = client();
  const web = await setup.create();
  await web.prepareSignIn();
  (web as any).preparedSignIn.createdAt = Date.now() - 5 * 60_000 - 1;
  await expect(web.signIn()).rejects.toThrow("call prepareSignIn() again");
  expect(open.mock.calls).toHaveLength(0);
  await web.prepareSignIn();
  const signing = web.signIn();
  expect(open.mock.calls).toHaveLength(1);
  await expect(signing).rejects.toThrow("approval stopped by test");
});
