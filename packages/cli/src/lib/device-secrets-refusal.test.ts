import { describe, expect, test } from "bun:test";
import type { PermissionEntry } from "@tinycloud/node-sdk";
import { deviceRefusal, deviceRefusalMessage } from "./raw-encryption.js";

const ADDRESS = "0xd559ccd9eb87c530a9a349262669386de93cf412";
const SECRETS_LINE = "--device can't read secrets yet. Use tinycloud auth login --paste instead.";

const kv = (space: string, path: string): PermissionEntry => ({
  service: "tinycloud.kv", space, path, actions: ["tinycloud.kv/get"],
});

describe("--device refusal of the secrets space", () => {
  test("every entry in a secrets space is refused with the one --paste line, whoever asked", () => {
    for (const entry of [
      kv("secrets", "vault/secrets/OPENAI_API_KEY"),
      kv(`tinycloud:pkh:eip155:1:${ADDRESS}:secrets`, "vault/secrets/OPENAI_API_KEY"),
      kv("secrets", ""),
    ]) {
      const refused = deviceRefusal([kv("default", "notes/"), entry]);
      expect(refused).toBe("secrets");
      expect(deviceRefusalMessage(refused!, "Use browser or --paste login for this manifest.")).toBe(SECRETS_LINE);
      expect(deviceRefusalMessage(refused!, "Use another OpenKey approval method for this request.")).toBe(SECRETS_LINE);
    }
  });

  test("a refused encryption entry still names what --device allows and where to go next", () => {
    const refused = deviceRefusal([{
      service: "tinycloud.encryption", space: "default", path: "share/", actions: ["tinycloud.encryption/encrypt"],
    }]);
    expect(refused).not.toBe("secrets");
    const message = deviceRefusalMessage(refused!, "Use browser or --paste login for this manifest.");
    expect(message).toContain("--device can't ask for tinycloud.encryption/encrypt");
    expect(message).toContain("Use browser or --paste login for this manifest.");
    expect(message).not.toBe(SECRETS_LINE);
  });
});
