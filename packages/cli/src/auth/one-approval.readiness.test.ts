import { expect, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { ensureSpaceSetup } from "./space-setup.js";

const permissions = ["applications", "account"].map(space => ({ service: "tinycloud.kv", space, path: "spaces/", actions: ["tinycloud.kv/list"] }));
test("a ready primary cannot hide a failed requested secondary; probe uses secondary route", async () => {
  const probed: string[] = [];
  const node = { space: (id: string) => { probed.push(id); return { kv: { list: async () => ({ ok: false, error: { code: "KV_NOT_FOUND", message: "Space not found", meta: { status: 404 } } }) } }; } } as unknown as TinyCloudNode;
  await expect(ensureSpaceSetup({ profile: "fixture", host: "https://node.test" }, {
    spaceReady: false,
    requestedSpaces: [
      { space: "applications", spaceId: "applications", spaceReady: true },
      { space: "account", spaceId: "account", spaceReady: false, spaceError: "secondary bootstrap failed" },
    ],
  }, permissions, 0, async () => ({ node }))).rejects.toMatchObject({ code: "SPACE_SETUP_FAILED" });
  expect(probed).toEqual(["account"]);
});
test("pending secondary stays pending even after primary is ready", async () => {
  const node = { space: () => ({ kv: { list: async () => ({ ok: false, error: { code: "KV_NOT_FOUND", message: "Space not found", meta: { status: 404 } } }) } }) } as unknown as TinyCloudNode;
  await expect(ensureSpaceSetup({ profile: "fixture", host: "https://node.test" }, {
    spaceReady: null, requestedSpaces: [
      { space: "applications", spaceId: "applications", spaceReady: true },
      { space: "account", spaceId: "account", spaceReady: null, spacePending: true },
    ],
  }, permissions, 0, async () => ({ node }))).rejects.toMatchObject({ code: "SPACE_SETUP_PENDING" });
});
