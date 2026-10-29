import { ok } from "../types";
import { feedError, feedJson } from "./store";
import { projectFeedResponseNotification } from "./notification";
import type { FeedApi, FeedHandoff } from "./types";

export const initializeFeedHandoff: FeedApi["initializeFeedHandoff"] = async (handoff) => {
  const result = await handoff.execute(`CREATE TABLE IF NOT EXISTS feed_handoffs (
    response_id TEXT NOT NULL, recipient TEXT NOT NULL, response_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared', 'unconfirmed', 'delivered')),
    PRIMARY KEY (response_id, recipient)
  )`);
  return result.ok ? ok(undefined) : result;
};

export const getFeedHandoff: FeedApi["getFeedHandoff"] = async (handoff, responseId, recipient) => {
  const result = await handoff.query<string>(
    "SELECT response_json, state FROM feed_handoffs WHERE response_id = ? AND recipient = ?", [responseId, recipient]);
  if (!result.ok) return result;
  const row = result.data.rows[0];
  if (!row) return ok(null);
  try {
    return ok({ responseId, recipient, response: projectFeedResponseNotification(JSON.parse(row[0])), state: row[1] as FeedHandoff["state"] });
  } catch {
    return feedError("INVALID_INPUT", "Handoff contains invalid response JSON");
  }
};

export const deliverFeedResponse: FeedApi["deliverFeedResponse"] = async ({ handoff, recipient, response: input, deliver }) => {
  const response = projectFeedResponseNotification(input);
  if (!recipient || !response.responseId) return feedError("INVALID_INPUT", "Handoff requires a recipient and full response ID");
  const inserted = await handoff.execute(
    `INSERT INTO feed_handoffs (response_id, recipient, response_json, state) VALUES (?, ?, ?, 'prepared')
     ON CONFLICT (response_id, recipient) DO NOTHING`, [response.responseId, recipient, feedJson(response)]);
  if (!inserted.ok) return inserted;
  const existing = await getFeedHandoff(handoff, response.responseId, recipient);
  if (!existing.ok) return existing;
  if (!existing.data || feedJson(existing.data.response) !== feedJson(response)) {
    return feedError("INVALID_INPUT", "A response handoff identity cannot change its payload");
  }
  if (existing.data.state !== "prepared") return ok(existing.data);

  // This durable compare-and-set is the only permission to attempt the send.
  // Crash after this point is ambiguous, even if the callback never started.
  const claimed = await handoff.execute(
    "UPDATE feed_handoffs SET state = 'unconfirmed' WHERE response_id = ? AND recipient = ? AND state = 'prepared'",
    [response.responseId, recipient]);
  if (!claimed.ok) return claimed;
  if (claimed.data.changes === 0) {
    const current = await getFeedHandoff(handoff, response.responseId, recipient);
    return current.ok && current.data ? ok(current.data) : current.ok
      ? feedError("NOT_FOUND", "Handoff disappeared before delivery") : current;
  }
  let state: FeedHandoff["state"] = "unconfirmed";
  try {
    const delivered = await deliver(response);
    if (delivered === "delivered") state = "delivered";
  } catch {
    // The runtime may already have accepted it. Keep the response ID and do not resend.
  }
  if (state === "delivered") {
    const saved = await handoff.execute(
      "UPDATE feed_handoffs SET state = 'delivered' WHERE response_id = ? AND recipient = ? AND state = 'unconfirmed'",
      [response.responseId, recipient]);
    if (!saved.ok) return saved;
  }
  return ok({ ...existing.data, state });
};
