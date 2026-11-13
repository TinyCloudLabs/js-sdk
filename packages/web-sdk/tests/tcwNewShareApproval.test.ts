import "./support/browserGlobalsShim";
import { expect, test } from "bun:test";
import type { TinyCloudWeb as TinyCloudWebType } from "../src/modules/tcw";
const { TinyCloudWeb } = require("../src/modules/tcw") as { TinyCloudWeb: typeof TinyCloudWebType };

test("new-share forwards a restored signed session synchronously without a modal or provider", async () => {
  const previousWindow = (globalThis as any).window;
  (globalThis as any).window = { location: { origin: "https://thirdparty.example" } };
  try {
  const tcw = Object.create(TinyCloudWeb.prototype) as TinyCloudWebType;
  const client = { beginShareApproval() { throw new Error("Node owns transport preparation"); } };
  let called = false;
  const options = { expiresAt: new Date(Date.now() + 60_000) };
  const expected = { shareId: "a".repeat(32), registrationPermissions: [], delegation: {} };
  Object.assign(tcw, { config: { openkey: { client } }, signOutInFlight: 0, persistedRestoreBlocked: false,
    _node: { session: undefined, restorableSession: { siwe: "signed session" }, isSessionOnly: true,
      approveNewShare(actualClient: unknown, actualOptions: unknown, origin: string) {
        called = true; expect(actualClient).toBe(client); expect(actualOptions).toBe(options);
        expect(origin).toBe(window.location.origin); return Promise.resolve(expected);
      } },
  });
  const result = tcw.approveNewShare(options);
  expect(called).toBe(true);
  expect(await result).toBe(expected as any);
  (tcw as any).signOutInFlight = 1;
  expect(() => tcw.approveNewShare(options)).toThrow("ended");
  (tcw as any).signOutInFlight = 0;
  (tcw as any).persistedRestoreBlocked = true;
  expect(() => tcw.approveNewShare(options)).toThrow("ended");
  } finally { (globalThis as any).window = previousWindow; }
});
