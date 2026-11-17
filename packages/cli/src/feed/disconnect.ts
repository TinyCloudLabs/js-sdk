import type { FeedDatabase } from "@tinycloud/sdk-services/feed";
import { ExitCode } from "../config/constants.js";
import { CLIError, cliErrorFromService } from "../output/errors.js";

export interface FeedDisconnectResult {
  agentId: string;
  /** The delegation `feed connect` issued to the agent, now revoked on the node. */
  cid: string;
  revoked: true;
  /** The owner's registry row for the agent is gone. */
  removed: true;
}

/**
 * Take an agent off the owner's feed: revoke the grant `feed connect` issued, then drop its registry row.
 *
 * The CID comes from the owner's own registry (`feed_agents.authorization_json`, written by `connectFeedAgent`), so no
 * node-side delegation lookup or local grant record is needed: the owner session that issued the grant revokes it with
 * its own key (`revoke`). Revoke runs first and any failure leaves the row, so a retry finds it. The reserved binding
 * (`feed_agent_bindings`) stays: that token keeps naming this agent, and only the same DID can connect to it again.
 */
export async function disconnectFeedAgent(
  registry: FeedDatabase, agentId: string, revoke: (cid: string) => Promise<void>,
): Promise<FeedDisconnectResult> {
  const found = await registry.query<string>("SELECT authorization_json FROM feed_agents WHERE agent_id = ?", [agentId]);
  // No registry table yet means nothing was ever connected.
  if (!found.ok && !/no such table/i.test(found.error.message)) throw cliErrorFromService(found.error);
  const row = found.ok ? found.data.rows[0] : undefined;
  if (!row) {
    throw new CLIError("FEED_AGENT_NOT_FOUND", `No agent is connected under the feed token "${agentId}". Nothing was changed.`, ExitCode.NOT_FOUND);
  }
  const authorization = row[0] as string;
  let cid: unknown;
  try {
    const parsed: unknown = JSON.parse(authorization);
    if (parsed !== null && typeof parsed === "object" && "cid" in parsed) cid = parsed.cid;
  } catch {
    cid = undefined;
  }
  if (typeof cid !== "string" || cid === "") {
    throw new CLIError("FEED_GRANT_UNREADABLE", `The registry row for "${agentId}" has no readable grant ID, so the grant can't be revoked from it. Nothing was changed.`, ExitCode.ERROR);
  }

  await revoke(cid);

  // Delete exactly the row that was revoked: a reconnect in between wrote a different authorization and keeps its row.
  const removed = await registry.execute("DELETE FROM feed_agents WHERE agent_id = ? AND authorization_json = ?", [agentId, authorization]);
  if (!removed.ok) throw cliErrorFromService(removed.error);
  return { agentId, cid, revoked: true, removed: true };
}
