import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverFeedResponse, getFeedHandoff, initializeFeedHandoff } from "./index";
import { sqliteHandle, unwrap } from "./sqlite.test-helper";
import type { FeedResponse } from "./types";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

const response: FeedResponse = {
  responseId: "response-full-durable-handoff", sequence: 1,
  cardId: "card-full-durable-handoff", revision: 3, issuanceId: "issuance-full-durable-handoff",
  kind: "answer", choiceId: "draft", createdAt: "2026-10-28T12:00:00.000Z",
};

function database(path?: string) {
  const result = sqliteHandle(path);
  cleanup.push(result.close);
  return result.handle;
}

describe("durable external handoff", () => {
  test("an ambiguous send survives restart without automatically executing again", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tc2205-feed-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "handoff.sqlite");
    const first = sqliteHandle(path);
    const effects = database();
    unwrap(await effects.execute("CREATE TABLE drafts (response_id TEXT NOT NULL, body TEXT NOT NULL)"));
    unwrap(await initializeFeedHandoff(first.handle));
    const deliver = async (item: FeedResponse): Promise<"delivered"> => {
      expect(unwrap(await getFeedHandoff(first.handle, item.responseId, "runtime-one"))?.state)
        .toBe("unconfirmed");
      unwrap(await effects.execute("INSERT INTO drafts VALUES (?, ?)", [item.responseId, item.choiceId ?? ""]));
      throw new Error("connection lost after runtime accepted the draft");
    };
    const sent = unwrap(await deliverFeedResponse({
      handoff: first.handle, recipient: "runtime-one", response, deliver,
    }));
    expect(sent.state).toBe("unconfirmed");
    first.close();

    const reopened = database(path);
    const replay = unwrap(await deliverFeedResponse({
      handoff: reopened, recipient: "runtime-one", response,
      deliver: async (item) => {
        unwrap(await effects.execute("INSERT INTO drafts VALUES (?, ?)", [item.responseId, "duplicate"]));
        return "delivered";
      },
    }));
    expect(replay).toMatchObject({ responseId: response.responseId, state: "unconfirmed", response });
    expect(unwrap(await effects.query("SELECT response_id, body FROM drafts")).rows)
      .toEqual([[response.responseId, "draft"]]);
  });

  test("a prepared record known not to have sent can resume, but a delivered record cannot resend", async () => {
    const handoff = database();
    const effects = database();
    unwrap(await effects.execute("CREATE TABLE drafts (response_id TEXT NOT NULL)"));
    unwrap(await initializeFeedHandoff(handoff));
    unwrap(await handoff.execute(
      "INSERT INTO feed_handoffs (response_id, recipient, response_json, state) VALUES (?, ?, ?, 'prepared')",
      [response.responseId, "runtime-one", JSON.stringify(response)],
    ));
    const deliver = async (item: FeedResponse): Promise<"delivered"> => {
      unwrap(await effects.execute("INSERT INTO drafts VALUES (?)", [item.responseId]));
      return "delivered";
    };
    const first = unwrap(await deliverFeedResponse({ handoff, recipient: "runtime-one", response, deliver }));
    const repeated = unwrap(await deliverFeedResponse({ handoff, recipient: "runtime-one", response, deliver }));
    expect(first.state).toBe("delivered");
    expect(repeated).toEqual(first);
    expect(unwrap(await effects.query("SELECT response_id FROM drafts")).rows).toEqual([[response.responseId]]);

    const conflict = await deliverFeedResponse({
      handoff, recipient: "runtime-one", response: { ...response, issuanceId: "different-issuance" }, deliver,
    });
    expect(conflict.ok).toBe(false);
    expect(unwrap(await getFeedHandoff(handoff, response.responseId, "runtime-one"))).toEqual(first);
  });
});
