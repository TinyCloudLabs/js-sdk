import { expect, test } from "bun:test";
import * as shareIndex from "../src/share-index/index.js";

test("the public owner schema refuses a partial decrypted record", () => {
  const context = {
    recordV: shareIndex.SUPPORTED_AGENT_RECORD_V,
    shareId: "partial-owner-record",
    accountOwnerDid: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111",
    agentDid: "did:key:z6MkneMkZqwqRiU5mJzSG3kDwzt9P8C59N4NGTfBLfSGE7c7",
    source: "agent",
  } satisfies shareIndex.AgentRecordSchemaContext;
  const partial: unknown = {
    shareId: context.shareId,
    target: {
      origin: "https://node.test",
      nodeAudience: context.agentDid,
      spaceId: "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:default",
    },
    resource: { kind: "exact", path: "shares/partial-owner-record/note.txt" },
    actions: ["tinycloud.kv/get"],
  };

  expect(() => shareIndex.checkAgentRecordSchema(partial, context)).toThrow(shareIndex.ShareRecordSchemaError);
});
