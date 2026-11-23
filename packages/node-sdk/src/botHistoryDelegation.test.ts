import "../../operations/test-support/test-bootstrap.mjs";
import { expect, test } from "bun:test";
import { BOT_HISTORY_KEY_PATH } from "@tinycloud/sdk-services";
import { createHermeticEncryptedNode } from "./test-support/hermetic-encrypted-node";

test("an owner cannot delegate the reserved bot-history key to another session", async () => {
  const node = await createHermeticEncryptedNode();
  try {
    const before = node.nativeBearerStats().delegationAttempts;
    await expect(node.owner.delegateTo(node.restorableSession.verificationMethod.split("#")[0]!, [{
      service: "tinycloud.encryption",
      path: `urn:tinycloud:encryption:${node.ownerDid}:default/${BOT_HISTORY_KEY_PATH}`,
      actions: ["decrypt"],
    }])).rejects.toThrow("secret keys must be exact");
    expect(node.nativeBearerStats().delegationAttempts).toBe(before);
  } finally {
    node.stop();
  }
});
