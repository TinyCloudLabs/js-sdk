import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as feed from "../../../sdk-services/src/feed";
import { openFeedHandoff } from "./local";
import { runFeedRunner } from "./runner";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const marker = "SYNTHETIC-PRIVATE-NOTIFICATION-CODE-77";
const notification = {
  responseId: "response-notification-projection", sequence: 9,
  cardId: "card-notification-projection", revision: 3, issuanceId: "issuance-notification-projection",
  kind: "followup" as const, choiceId: "approved", supersedesResponseId: "response-earlier",
  text: "An ordinary note may contain CODE-LIKE-0000; do not rewrite text.",
  createdAt: "2026-10-29T12:00:00Z", payloadType: "test.approval-code", payloadVersion: 1,
};
const polluted = {
  ...notification,
  payload: { type: notification.payloadType, version: 1, data: { code: marker } },
  data: marker,
  approvalCode: marker,
  futureUnrecognizedField: { nested: marker },
};

test("notification projection is an explicit safe header and metadata allowlist", () => {
  expect(feed.projectFeedResponseNotification(polluted)).toEqual(notification);
});

test("private extras never reach the durable handoff JSON, callback, or a real child's stdin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tc2205-payload-notification-"));
  directories.push(directory);
  const path = join(directory, "handoff.sqlite");
  const output = join(directory, "runner-input.json");
  const local = await openFeedHandoff(path);
  const code = `const fs=require('node:fs');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>fs.writeFileSync(process.argv[1],input));`;
  let callbackValue: unknown;
  let persistedBeforeCallback: unknown;
  try {
    expect(await feed.initializeFeedHandoff(local.handle)).toMatchObject({ ok: true });
    const result = await feed.deliverFeedResponse({
      handoff: local.handle, recipient: "actual-private-payload-runner", response: polluted,
      deliver: async (item) => {
        callbackValue = item;
        const row = await local.handle.query<string>(
          "SELECT response_json FROM feed_handoffs WHERE response_id = ?", [notification.responseId],
        );
        if (!row.ok) throw new Error("Could not inspect durable notification");
        persistedBeforeCallback = JSON.parse(row.data.rows[0][0]);
        return runFeedRunner([process.execPath, "-e", code, output], item);
      },
    });
    expect(result).toMatchObject({ ok: true, data: { state: "delivered", response: notification } });
    expect(persistedBeforeCallback).toEqual(notification);
    expect(callbackValue).toEqual(notification);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(notification);
    expect(await readFile(output, "utf8")).not.toContain(marker);
  } finally { local.close(); }
  try {
    expect((await readFile(path)).includes(Buffer.from(marker))).toBe(false);
    const reopened = await openFeedHandoff(path);
    try {
      const saved = await feed.getFeedHandoff(reopened.handle, notification.responseId, "actual-private-payload-runner");
      expect(saved).toMatchObject({ ok: true, data: { state: "delivered", response: notification } });
      const raw = await reopened.handle.query<string>("SELECT response_json FROM feed_handoffs");
      expect(raw.ok && raw.data.rows.map((row) => JSON.parse(row[0]))).toEqual([notification]);
    } finally { reopened.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
