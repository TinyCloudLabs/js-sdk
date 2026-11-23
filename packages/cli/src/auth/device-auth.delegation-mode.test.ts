import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings } from "@tinycloud/node-sdk";

// TC_HOME is read when the profile store loads, so import device-auth afterwards.
const originalTcHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-device-mode-"));
process.env.TC_HOME = home;
const { acquireDeviceDelegation, loginWithDeviceAuthorization } = await import("./device-auth.js");
const { keyToDID } = await import("./local-key.js");
const { sharePublishingPermissions } = await import("../share/publishing-manifest.js");

afterAll(async () => {
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  await rm(home, { recursive: true, force: true });
});

describe("TC-3810 device-auth delegationMode (F1)", () => {
  test("loginWithDeviceAuthorization does not send delegationMode: terminal by default", async () => {
    const startBodies: Record<string, unknown>[] = [];
    const fetchFn = Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/api/device-authorizations")) {
          startBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return Response.json({ error: "stop_after_capture" }, { status: 400 });
        }
        throw new Error(`Unexpected URL: ${String(url)}`);
      },
      { preconnect: () => {} },
    ) as typeof globalThis.fetch;

    await expect(
      loginWithDeviceAuthorization({
        profileName: "owner-device-default",
        nodeOrigin: "https://tee.node.tinycloud.xyz",
        shareOrigin: "https://share.tinycloud.xyz",
        permissions: sharePublishingPermissions(),
        openkeyHost: "https://api.openkey.test",
        fetchFn,
      }),
    ).rejects.toThrow();

    expect(startBodies).toHaveLength(1);
    expect("delegationMode" in startBodies[0]!).toBe(false);
    expect(startBodies[0]!.delegationMode).toBeUndefined();
  });

  test("acquireDeviceDelegation forwards delegationMode: terminal only when explicitly requested", async () => {
    const startBodies: Record<string, unknown>[] = [];
    const fetchFn = Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/api/device-authorizations")) {
          startBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return Response.json({ error: "stop_after_capture" }, { status: 400 });
        }
        throw new Error(`Unexpected URL: ${String(url)}`);
      },
      { preconnect: () => {} },
    ) as typeof globalThis.fetch;

    const wasm = new NodeWasmBindings();
    const key = JSON.parse(wasm.createSessionManager().jwk("default")!) as Record<string, string>;
    await expect(
      acquireDeviceDelegation({
        sessionDid: keyToDID(key),
        jwk: key,
        nodeOrigin: "https://tee.node.tinycloud.xyz",
        shareOrigin: "https://share.tinycloud.xyz",
        permissions: sharePublishingPermissions(),
        openkeyHost: "https://api.openkey.test",
        delegationMode: "terminal",
        fetchFn,
      }),
    ).rejects.toThrow();

    expect(startBodies).toHaveLength(1);
    expect(startBodies[0]!.delegationMode).toBe("terminal");
  });
});
