import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionEntry } from "@tinycloud/node-sdk";

// TC_HOME is read when the profile store loads, so import after setting it.
const originalTcHome = process.env.TC_HOME;
const home = await mkdtemp(join(tmpdir(), "tc-device-refusal-"));
process.env.TC_HOME = home;
const { deviceRefusal, deviceRefusalMessage } = await import("./raw-encryption.js");
const { loadManifestPermissions } = await import("./permissions.js");

afterAll(async () => {
  if (originalTcHome === undefined) delete process.env.TC_HOME;
  else process.env.TC_HOME = originalTcHome;
  await rm(home, { recursive: true, force: true });
});

const decrypt = ["tinycloud.encryption/decrypt"];
const kv: PermissionEntry = { service: "tinycloud.kv", space: "default", path: "notes/", actions: ["tinycloud.kv/get"] };
const defaultDecrypt: PermissionEntry = { service: "tinycloud.encryption", space: "default", path: "", actions: decrypt };

describe("deviceRefusal", () => {
  test.each<[string, PermissionEntry]>([
    ["decrypt on the owner's default network", defaultDecrypt],
    ["the same entry under the short service name", { ...defaultDecrypt, service: "encryption" }],
    ["the same entry in another letter case", { ...defaultDecrypt, service: "TinyCloud.Encryption" }],
    ["encrypt", { ...defaultDecrypt, actions: ["tinycloud.encryption/encrypt"] }],
    ["a nested share prefix", { ...defaultDecrypt, path: "share/" }],
    ["a network URN", { service: "tinycloud.encryption", space: "encryption", path: "urn:tinycloud:encryption:did:pkh:eip155:1:0xabc:default", actions: decrypt }],
  ])("refuses %s", (_name, entry) => {
    expect(deviceRefusal([kv, entry])).toBe(entry);
  });

  test("lets scopes that are neither encryption nor in the secrets space through", () => {
    expect(deviceRefusal([kv, { service: "tinycloud.capabilities", space: "default", path: "", actions: ["tinycloud.capabilities/read"] }])).toBeUndefined();
  });

  test("names the secrets space, whether it is a short name or a full space id", () => {
    expect(deviceRefusal([{ ...kv, space: "secrets" }])).toBe("secrets");
    expect(deviceRefusal([{ ...kv, space: "tinycloud:pkh:eip155:1:0xabc:secrets" }])).toBe("secrets");
  });
});

describe("deviceRefusalMessage", () => {
  test("says the cause only, for a request and for a manifest", () => {
    expect(deviceRefusalMessage(defaultDecrypt, "this request"))
      .toBe("--device can't ask for encryption permissions, and this request asks for tinycloud.encryption/decrypt on space \"default\", path \"\".");
    expect(deviceRefusalMessage(defaultDecrypt, "this manifest"))
      .toBe("--device can't ask for encryption permissions, and this manifest asks for tinycloud.encryption/decrypt on space \"default\", path \"\".");
    expect(deviceRefusalMessage("secrets", "this request")).toBe("--device can't ask for the secrets space, and this request asks for it.");
    expect(deviceRefusalMessage("secrets", "this manifest")).toBe("--device can't ask for the secrets space, and this manifest asks for it.");
  });

  test("escapes and clips what the request wrote, and flags extra limits", () => {
    const hostile: PermissionEntry = { ...defaultDecrypt, path: "a\u001b[31m\nb", caveats: [{ tenant: "alpha" }] };
    const message = deviceRefusalMessage(hostile, "this request");
    expect(message).toContain("path \"a\\u{1b}[31m\\u{a}b\" with extra limits.");
    expect(message).not.toContain("\u001b");
    const long = deviceRefusalMessage({ ...defaultDecrypt, path: "p".repeat(500) }, "this request");
    expect(long.length).toBeLessThan(250);
  });
});

describe("--device manifests", () => {
  const manifestSource = (manifest: Record<string, unknown>) => `base64:${Buffer.from(JSON.stringify(manifest)).toString("base64")}`;

  test.each([
    ["decrypt on the owner's default network", { path: "", skipPrefix: true, actions: ["decrypt"] }],
    ["the short service name", { service: "encryption", path: "", skipPrefix: true, actions: ["decrypt"] }],
    ["no path", { actions: ["decrypt"] }],
  ])("refuse %s with the cause only", async (_name, entry) => {
    const manifest = { app_id: "xyz.tinycloud.agent", space: "default", permissions: [{ service: "tinycloud.kv", path: "notes/", actions: ["get"] }, { service: "tinycloud.encryption", ...entry }] };
    const error = await loadManifestPermissions(manifestSource(manifest), "agent", { allowLogicalSpaces: true, device: true }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "DEVICE_AUTH_UNSUPPORTED_SCOPE",
      exitCode: 2,
      message: expect.stringMatching(/^--device can't ask for encryption permissions, and this manifest asks for tinycloud\.encryption\/decrypt on space "default", path "[^"]*"\.$/),
    });
  });

  test("refuse the secrets space with the cause only", async () => {
    const manifest = { app_id: "xyz.tinycloud.agent", space: "secrets", secrets: { OPENAI_API_KEY: true } };
    await expect(loadManifestPermissions(manifestSource(manifest), "agent", { allowLogicalSpaces: true, device: true }))
      .rejects.toMatchObject({ code: "DEVICE_AUTH_UNSUPPORTED_SCOPE", message: "--device can't ask for the secrets space, and this manifest asks for it." });
  });
});
