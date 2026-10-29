import type { FeedDatabase, FeedSource } from "@tinycloud/sdk-services/feed";
import type { Result } from "@tinycloud/sdk-services";
import { cliErrorFromService } from "../output/errors.js";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw cliErrorFromService(result.error);
  return result.data;
}

/** Reserve identity before any grant activation; registry provenance follows activation only. */
export async function connectFeedAgent<TGrant extends object>(
  registry: FeedDatabase, source: FeedSource, activate: () => Promise<TGrant>,
): Promise<TGrant> {
  value(await registry.execute(`CREATE TABLE IF NOT EXISTS feed_agents (
    agent_id TEXT PRIMARY KEY, agent_did TEXT NOT NULL, label TEXT NOT NULL,
    output_resource TEXT NOT NULL UNIQUE, response_resource TEXT NOT NULL UNIQUE,
    authorization_json TEXT NOT NULL
  )`));
  value(await registry.execute(`CREATE TABLE IF NOT EXISTS feed_agent_bindings (
    agent_id TEXT PRIMARY KEY, agent_did TEXT NOT NULL,
    output_resource TEXT NOT NULL UNIQUE, response_resource TEXT NOT NULL UNIQUE
  )`));
  // Existing provenanced registry entries also reserve their immutable binding.
  value(await registry.execute(`INSERT INTO feed_agent_bindings
    (agent_id, agent_did, output_resource, response_resource)
    SELECT agent_id, agent_did, output_resource, response_resource FROM feed_agents WHERE agent_id = ?
    ON CONFLICT DO NOTHING`, [source.sourceId]));
  value(await registry.execute(`INSERT INTO feed_agent_bindings
    (agent_id, agent_did, output_resource, response_resource) VALUES (?, ?, ?, ?)
    ON CONFLICT DO NOTHING`, [source.sourceId, source.agentDid, source.output.database, source.responses.database]));
  const binding = value(await registry.query<string>(
    "SELECT agent_did, output_resource, response_resource FROM feed_agent_bindings WHERE agent_id = ?", [source.sourceId],
  )).rows[0];
  if (!binding || binding[0] !== source.agentDid || binding[1] !== source.output.database || binding[2] !== source.responses.database) {
    throw new Error("The owner feed token or resources are already bound to another agent identity");
  }
  const existing = value(await registry.query<string>(
    "SELECT agent_did, output_resource, response_resource FROM feed_agents WHERE agent_id = ?", [source.sourceId],
  )).rows[0];
  if (existing && (existing[0] !== source.agentDid || existing[1] !== source.output.database || existing[2] !== source.responses.database)) {
    throw new Error("The owner feed registry does not match the reserved binding");
  }

  // Activation failures retain the binding, but never manufacture a grant row.
  // The same DID/resources may retry; a different DID cannot win during that retry.
  const grant = await activate();
  const provenance = JSON.stringify(grant);
  const saved = value(await registry.execute(`INSERT INTO feed_agents
    (agent_id, agent_did, label, output_resource, response_resource, authorization_json)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (agent_id) DO UPDATE SET
    label = excluded.label, authorization_json = excluded.authorization_json
    WHERE feed_agents.agent_did = excluded.agent_did AND feed_agents.output_resource = excluded.output_resource
    AND feed_agents.response_resource = excluded.response_resource`,
  [source.sourceId, source.agentDid, source.label, source.output.database, source.responses.database, provenance]));
  if (saved.changes !== 1) throw new Error("The activated grant was not registered under its reserved feed binding");
  const confirmed = value(await registry.query<string>(
    "SELECT agent_did, output_resource, response_resource, authorization_json FROM feed_agents WHERE agent_id = ?", [source.sourceId],
  )).rows[0];
  if (!confirmed || confirmed[0] !== source.agentDid || confirmed[1] !== source.output.database ||
    confirmed[2] !== source.responses.database || confirmed[3] !== provenance) {
    throw new Error("The owner feed registry did not confirm the activated grant provenance");
  }
  return grant;
}
