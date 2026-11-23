import "../../operations/test-support/test-bootstrap.mjs";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { makePkhSpaceId, pkhDid, REGISTRY_NOT_FOUND_BODY, verifyDidKeyEd25519Signature } from "@tinycloud/sdk-core";
import { profileConfigPath, sessionPath, writeJsonAtomic } from "@tinycloud/operations/state";
import { createTinyCloudMcpServer } from "./server.js";

const contacts = "xyz.tinycloud.tinyapps.contacts/person/";
const db = "xyz.tinycloud.inbox/db/";
const media = "xyz.tinycloud.inbox/media/";
const bodyKey = `${media}gmail/bodies/${"a".repeat(64)}`;
const stamp = 1_700_000_000_000;
type Scope = Record<string, string[]>;
type SqlInput = { action: string; sql: string; params: Array<string | number | null> };

async function fixture() {
  const wasm = new NodeWasmBindings();
  const nodeDid = wasm.createSessionManager().getDID("default").split("#")[0]!;
  const signer = new PrivateKeySigner("1".padStart(64, "0")); // disposable fixture identity only
  const address = await signer.getAddress();
  const ownerDid = pkhDid(address, 1);
  const applications = makePkhSpaceId(address, 1, "applications");
  const messages = makePkhSpaceId(address, 1, "messages");
  const grants = new Map<string, { cid: string; scope: Scope }>();
  const activations = new Map<string, string>();
  const invoked: Array<{ action: string; resource: string }> = [];
  const databases = new Map<string, Database>();
  for (const name of ["state", "main", "main-2"]) databases.set(`${db}${name}`, new Database(":memory:"));
  databases.get(`${db}state`)!.exec(`
    CREATE TABLE inbox_shards (sequence INTEGER PRIMARY KEY);
    INSERT INTO inbox_shards VALUES (1),(2);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, owner_did TEXT, connector TEXT, provider_account_id TEXT);
    INSERT INTO accounts VALUES ('gmail','${ownerDid}','gmail','owner@example.test'),('telegram','${ownerDid}','telegram','9');
    CREATE TABLE chats (account_id TEXT, source_chat_id TEXT, kind TEXT, title TEXT);
    INSERT INTO chats VALUES ('gmail','41','mail-thread',NULL),('telegram','56','private','Ada Quill');
  `);
  databases.get(`${db}main`)!.exec("CREATE TABLE layout_complete (id INTEGER, source TEXT); INSERT INTO layout_complete VALUES (1,'fresh');");
  for (const name of ["main", "main-2"]) databases.get(`${db}${name}`)!.exec(`
    CREATE TABLE mail (account_id TEXT, source_mail_id TEXT, source_thread_id TEXT, internal_date INTEGER,
      from_json TEXT, to_json TEXT, cc_json TEXT, subject TEXT, deleted_at INTEGER, text_kv_key TEXT, html_kv_key TEXT);
    CREATE TABLE participants (account_id TEXT, source_chat_id TEXT, source_participant_id TEXT,
      display_name TEXT, address TEXT, role TEXT, observed_at INTEGER);
    CREATE TABLE messages (account_id TEXT, source_chat_id TEXT, source_message_id TEXT, sender_id TEXT,
      direction TEXT, sent_at INTEGER, received_at INTEGER, deleted_at INTEGER, expires_at INTEGER, body_kv_key TEXT);
  `);
  const ada = JSON.stringify([{ name: "Ada Quill", address: "ada@example.test" }]);
  databases.get(`${db}main`)!.run("INSERT INTO mail VALUES ('gmail','100','41',?,?,'[]','[]','First call',NULL,NULL,NULL)", [stamp, ada]);
  databases.get(`${db}main-2`)!.run("INSERT INTO mail VALUES ('gmail','102','41',?,'[]',?,'[]','Synthetic follow-up',NULL,?,NULL)", [stamp + 1, ada, bodyKey]);
  // Handle-only participant: the unsealed name does not imply a cross-provider identity.
  databases.get(`${db}main`)!.run("INSERT INTO participants VALUES ('telegram','56','4242',NULL,'@ada_quill','sender',?)", [stamp]);
  databases.get(`${db}main-2`)!.run("INSERT INTO messages VALUES ('telegram','56','201','4242','incoming',?,NULL,NULL,NULL,NULL)", [stamp + 2]);
  const cardKey = `${contacts}ada-quill-deadbeef`;
  const card = { v: 1, at: "2026-11-23T12:00:00Z", by: "owner", data: { name: "Ada Quill", added: "2026-11-23", sealed: "synthetic opaque details" } };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/info") return Response.json({ protocol: wasm.protocolVersion(), version: "fixture", nodeId: nodeDid, features: [] });
    if (path === "/.well-known/tinycloud/node-keys") return Response.json({ nodeDid });
    if (path.startsWith("/peer/generate/")) return new Response(nodeDid);
    if (/^\/v[12]\/locations\//.test(path)) return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404, headers: { "content-type": "application/json" } });
    const authorization = request.headers.get("authorization")?.replace(/^Bearer /i, "");
    if (request.method === "POST" && path === "/delegate") {
      const cid = authorization === undefined ? undefined : activations.get(authorization);
      return cid ? Response.json({ activated: [cid], skipped: [] }) : new Response("Unexpected delegation", { status: 403 });
    }
    if (request.method !== "POST" || path !== "/invoke" || !authorization) return new Response("Unexpected request", { status: 404 });
    const [head, payload, signature] = authorization.split(".");
    if (!head || !payload || !signature) return new Response("Malformed invocation", { status: 401 });
    const auth = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iss: string; prf: string[]; att: Record<string, Record<string, unknown>> };
    const issuer = auth.iss.split("#")[0]!;
    const grant = grants.get(issuer);
    if (!grant || !auth.prf.includes(grant.cid) || !verifyDidKeyEd25519Signature(issuer,
      new TextEncoder().encode(`${head}.${payload}`), Uint8Array.from(Buffer.from(signature, "base64url")))) {
      return new Response("Wrong session proof", { status: 403 });
    }
    const entries = Object.entries(auth.att);
    if (entries.length !== 1) return new Response("Expected one resource", { status: 403 });
    const [resource, granted] = entries[0]!;
    const actions = Object.keys(granted);
    const [action] = actions;
    if (actions.length !== 1 || !action || !Object.entries(grant.scope).some(([scope, allowed]) =>
      (scope.toLowerCase() === resource.toLowerCase() || (scope.endsWith("/") && resource.toLowerCase().startsWith(scope.toLowerCase()))) && allowed.includes(action)
    )) return new Response("Wrong scope", { status: 403 });
    invoked.push({ resource, action });
    const target = resource.toLowerCase();
    if (action === "tinycloud.kv/list" && target === `${applications}/kv/${contacts}`.toLowerCase()) return Response.json([cardKey]);
    if (action === "tinycloud.kv/get" && target === `${applications}/kv/${cardKey}`.toLowerCase()) return Response.json(card);
    if (action === "tinycloud.kv/get" && target === `${messages}/kv/${bodyKey}`.toLowerCase()) return new Response("Synthetic notes\nfor the next call.");
    const sqlRoot = `${messages}/sql/`.toLowerCase();
    const sqlite = target.startsWith(sqlRoot) ? databases.get(target.slice(sqlRoot.length)) : undefined;
    if (action === "tinycloud.sql/read" && sqlite) {
      const query = await request.json() as SqlInput;
      if (query.action !== "query" || !query.sql.startsWith("SELECT ")) return new Response("Read-only fixture", { status: 403 });
      const statement = sqlite.query(query.sql);
      const rows = statement.values(...query.params);
      return Response.json({ columns: statement.columnNames, rows });
    }
    return new Response("Resource not found", { status: 404 });
  } });
  const host = server.url.origin;
  async function profile(name: string, scope: Scope) {
    const manager = wasm.createSessionManager();
    const jwk = JSON.parse(manager.jwk("default")!);
    const prepared = wasm.prepareSession({ address, chainId: 1, domain: "127.0.0.1", jwk, spaceId: messages,
      abilities: {}, rawAbilities: scope, issuedAt: new Date().toISOString(), expirationTime: new Date(Date.now() + 3_600_000).toISOString() });
    const signature = await signer.signMessage(prepared.siwe);
    const session = wasm.completeSessionSetup({ ...prepared, signature });
    const sessionDid = session.verificationMethod.split("#")[0]!;
    grants.set(sessionDid, { cid: session.delegationCid, scope });
    activations.set(session.delegationHeader.Authorization.replace(/^Bearer /i, ""), session.delegationCid);
    await writeJsonAtomic(profileConfigPath(name), {
      name, host, tinycloudRegistryUrl: host, chainId: 1, spaceName: "messages", spaceId: messages,
      did: sessionDid, sessionDid, ownerDid, operatorType: "agent", posture: "delegate-session", authMethod: "openkey", createdAt: new Date().toISOString(),
    });
    await writeJsonAtomic(sessionPath(name), {
      spaceId: messages, jwk, verificationMethod: session.verificationMethod, address, chainId: 1,
      delegationHeader: session.delegationHeader, delegationCid: session.delegationCid,
      siwe: prepared.siwe, signature, tinycloudHosts: [host],
    });
  }
  return { profile, host, applications, messages, invoked, stop() { server.stop(true); for (const sqlite of databases.values()) sqlite.close(); } };
}

test("local MCP reads scoped Contacts and Inbox history without invoking foreign or write resources", async () => {
  const home = await mkdtemp(join(process.env.HOME!, "person-history-"));
  const previousHome = process.env.TC_HOME;
  process.env.TC_HOME = home;
  const local = await fixture();
  const clients: Client[] = [];
  try {
    const scope = {
      [`${local.applications}/kv/${contacts}`]: ["tinycloud.kv/list", "tinycloud.kv/get"],
      [`${local.messages}/sql/${db}`]: ["tinycloud.sql/read"],
      [`${local.messages}/kv/${media}`]: ["tinycloud.kv/get"],
    };
    await local.profile("reader", scope);
    await local.profile("missing", { [`${local.messages}/sql/${db}`]: ["tinycloud.sql/read"] });
    const connect = async (profile: string) => {
      const server = createTinyCloudMcpServer({ profile, explicitProfile: true, allowOwnerProfile: false });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "person-history-fixture", version: "1.0.0" });
      clients.push(client);
      await client.connect(clientTransport);
      return client;
    };
    const reader = await connect("reader");
    const list = await reader.listTools();
    expect(list.tools.find((tool) => tool.name === "tinycloud_person_history")?.annotations?.readOnlyHint).toBe(true);
    const gmail = await reader.callTool({ name: "tinycloud_person_history", arguments: { person: "Ada Quill" } });
    expect(gmail.structuredContent).toMatchObject({ status: "ok", output: {
      contacts: [{ name: "Ada Quill", emails: [], match: "name" }], counts: { mailThreads: 1, mailMessages: 2 },
      conversations: [{ kind: "mail", id: { sourceChatId: "41" }, latestMessageId: "102", preview: "Synthetic notes for the next call." }],
      coverage: { contactsDetails: "unavailable", telegram: "partial" },
    } });
    const telegram = await reader.callTool({ name: "tinycloud_person_history", arguments: { person: "@ada_quill", includePreviews: false } });
    expect(telegram.structuredContent).toMatchObject({ status: "ok", output: {
      counts: { mailMessages: 0, telegramChats: 1, telegramMessages: 1 },
      conversations: [{ kind: "telegram", id: { sourceChatId: "56" }, latestMessageId: "201" }],
    } });
    const calls = local.invoked.length;
    const missing = await connect("missing");
    expect((await missing.callTool({ name: "tinycloud_person_history", arguments: { person: "Ada Quill", includePreviews: false } })).structuredContent)
      .toMatchObject({ status: "authority_required", missing: [{ service: "tinycloud.kv", path: contacts }] });
    expect(local.invoked).toHaveLength(calls);
    expect([...new Set(local.invoked.map(({ action }) => action))].sort()).toEqual(["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.sql/read"]);
  } finally {
    for (const client of clients) await client.close();
    local.stop();
    if (previousHome === undefined) delete process.env.TC_HOME;
    else process.env.TC_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
