import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { RuntimeOperationContext } from "../contract.js";
import { lookupOperation } from "../registry.js";

const owner = "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const contacts = "xyz.tinycloud.tinyapps.contacts/person/";
const inbox = "xyz.tinycloud.inbox/db/";
const media = "xyz.tinycloud.inbox/media/";
const appKey = "apps/xyz.tinycloud.share/xyz.tinycloud.tinyapps.contacts/seal-v1";
const network = `urn:tinycloud:encryption:${owner.replace("tinycloud:", "did:")}:default`;
const foreign = owner.replace("1111", "2222");

function operation() {
  const lookup = lookupOperation("tinycloud.person.history", 1);
  expect(lookup.status).toBe("found");
  if (lookup.status !== "found") throw new Error("Person history operation is missing");
  return lookup.definition;
}

function fixture() {
  const databases = new Map<string, Database>();
  const cards = new Map<string, unknown>();
  const bodies = new Map<string, string>();
  const opened: Array<Uint8Array | Error> = [];
  const bodyReads: string[] = [];
  let decrypted = 0;
  const db = (name: string) => {
    const sqlite = new Database(":memory:");
    databases.set(`${inbox}${name}`, sqlite);
    return sqlite;
  };
  const context: RuntimeOperationContext = {
    summary: { profile: "fixture", host: "https://fixture.invalid", posture: "delegate-session", space: `${owner}:messages` },
    runtime: { granted: [], node: {
      spaceId: `${owner}:messages`,
      sqlForSpace(space: string) {
        expect(space.toLowerCase()).toBe(`${owner}:messages`);
        return { db: (name: string) => ({
          async query(sql: string, params: (string | number | null)[] = []) {
            try {
              const statement = databases.get(name)!.query(sql);
              const rows = statement.values(...params);
              return { ok: true, data: { columns: statement.columnNames, rows } };
            } catch (error) {
              return { ok: false, error: { code: "SQL_ERROR", message: (error as Error).message } };
            }
          },
        }) };
      },
      keys: {
        async decrypt() {
          decrypted++;
          const next = opened.shift();
          if (next === undefined || next instanceof Error) throw next ?? new Error("Unexpected decryption");
          return next;
        },
      },
      kvForSpace(space: string) {
        expect([`${owner}:applications`, `${owner}:messages`]).toContain(space.toLowerCase());
        return {
          async list({ prefix }: { prefix: string }) {
            return { ok: true, data: { keys: [...cards.keys()].filter((key) => key.startsWith(prefix)), truncated: false } };
          },
          async get(key: string) {
            if (space.toLowerCase().endsWith(":messages")) bodyReads.push(key);
            const value = bodies.get(key) ?? (cards.has(key) ? JSON.stringify(cards.get(key)) : undefined);
            return value === undefined
              ? { ok: false, error: { code: "KV_NOT_FOUND" } }
              : { ok: true, data: { data: new TextEncoder().encode(value) } };
          },
        };
      },
    } },
  };
  db("state").exec(`
    CREATE TABLE inbox_shards(sequence INTEGER PRIMARY KEY);
    INSERT INTO inbox_shards VALUES (1),(2);
    CREATE TABLE accounts(id TEXT, owner_did TEXT, connector TEXT, provider_account_id TEXT);
    INSERT INTO accounts VALUES ('gmail','${owner.replace("tinycloud:", "did:")}','gmail','owner@example.test');
    CREATE TABLE chats(account_id TEXT, source_chat_id TEXT, kind TEXT, title TEXT);
    INSERT INTO chats VALUES ('gmail','41','mail-thread',NULL),('gmail','42','mail-thread',NULL);
  `);
  const main = db("main");
  main.exec("CREATE TABLE layout_complete(id INTEGER, source TEXT); INSERT INTO layout_complete VALUES(1, 'fresh');");
  const other = db("main-2");
  for (const shard of [main, other]) shard.exec(`
    CREATE TABLE mail(account_id TEXT, source_mail_id TEXT, source_thread_id TEXT, internal_date INTEGER,
      from_json TEXT, to_json TEXT, cc_json TEXT, subject TEXT, deleted_at INTEGER, text_kv_key TEXT, html_kv_key TEXT);
    CREATE TABLE participants(account_id TEXT, source_chat_id TEXT, source_participant_id TEXT,
      display_name TEXT, address TEXT, role TEXT, observed_at INTEGER);
    CREATE TABLE messages(account_id TEXT, source_chat_id TEXT, source_message_id TEXT, sender_id TEXT,
      direction TEXT, sent_at INTEGER, received_at INTEGER, deleted_at INTEGER, expires_at INTEGER, body_kv_key TEXT);
  `);
  const stamp = 1_700_000_000_000;
  const mail = (shard: Database, id: string, thread: string, timestamp: number, from: unknown[], to: unknown[], cc: unknown[] = [], deleted: number | null = null) => {
    shard.run("INSERT INTO mail VALUES ('gmail',?,?,?,?,?,?,?,?,NULL,NULL)", [id, thread, timestamp, JSON.stringify(from), JSON.stringify(to), JSON.stringify(cc), `Subject ${id}`, deleted]);
  };
  const ada = { name: "Ada Quíll", address: "ADA@example.test" };
  mail(main, "100", "41", stamp, [ada], []);
  mail(other, "102", "41", stamp + 1, [], [ada], [ada]);
  mail(other, "101", "42", stamp + 2, [{ name: "Another Person", address: "ada+other@example.test" }], []);
  mail(main, "103", "41", stamp + 3, [ada], [], [], stamp + 3);
  cards.set(`${contacts}ada-quill-deadbeef`, {
    v: 1, at: "2026-11-23T12:00:00Z", by: "owner", data: { name: "Ada Quíll", added: "2026-11-23" },
  });
  return { context, cards, bodies, bodyReads, opened, decrypts: () => decrypted, mail, state: databases.get(`${inbox}state`)!, main, other, stamp,
    close() { for (const database of databases.values()) database.close(); } };
}

test("finds a fuzzy Contacts name and counts matching mail once per message across shards", async () => {
  const data = fixture();
  try {
    const result = await operation().execute(data.context, { person: "ada quil", includePreviews: false });
    expect(result).toMatchObject({ status: "ok", output: {
      contacts: [{ id: `${contacts}ada-quill-deadbeef`, name: "Ada Quíll", match: "name" }],
      counts: { mailThreads: 1, mailMessages: 2, telegramChats: 0, telegramMessages: 0 },
      lastContactAt: new Date(data.stamp + 1).toISOString(),
      conversations: [{ kind: "mail", id: { accountId: "gmail", sourceChatId: "41" }, latestMessageId: "102", subject: "Subject 102", messageCount: 2 }],
    } });
  } finally {
    data.close();
  }
});

test("uses exact case-insensitive mail addresses and never reads plaintext Contacts details", async () => {
  const data = fixture();
  try {
    data.cards.set(`${contacts}wrong-owner-deadbeef`, { v: 1, data: { name: "Wrong Person", private: { emails: ["ada@example.test"] } } });
    const sealedKey = `${contacts}sealed-deadbeef`;
    const header = JSON.stringify(["tinycloud.app.seal/v1", owner.replace("tinycloud:", "did:"), `${owner}:applications`, sealedKey]);
    data.cards.set(sealedKey, { v: 1, data: { name: "Sealed Person", sealed: JSON.stringify({ v: 2, keyPath: appKey, networkId: network, aad: Buffer.from(header).toString("base64") }) } });
    const result = await operation().execute(data.context, { person: "aDa@Example.TEST", includePreviews: false });
    expect(result).toMatchObject({ status: "ok", output: {
      contacts: [], coverage: { contactsDetails: "unavailable" }, counts: { mailMessages: 2 },
      conversations: [{ id: { accountId: "gmail", sourceChatId: "41" }, latestMessageId: "102" }],
    } });
    const none = await operation().execute(data.context, { person: "ada+missing@example.test", includePreviews: false });
    expect(none).toMatchObject({ status: "ok", output: { conversations: [], lastContactAt: null } });
    expect(data.decrypts()).toBe(0);
  } finally { data.close(); }
});

test("opens only a granted, record-bound sealed contact and uses its exact aliases", async () => {
  const data = fixture();
  try {
    const key = `${contacts}ada-quill-deadbeef`;
    const header = JSON.stringify(["tinycloud.app.seal/v1", owner.replace("tinycloud:", "did:"), `${owner}:applications`, key]);
    data.cards.set(key, { v: 1, data: {
      name: "Ada", sealed: JSON.stringify({ v: 2, keyPath: appKey, networkId: network, aad: Buffer.from(header).toString("base64") }),
      private: { emails: ["wrong@example.test"] },
    } });
    const withKey: RuntimeOperationContext = {
      ...data.context,
      runtime: { ...data.context.runtime, granted: [{ service: "tinycloud.encryption", path: `${network}/${appKey}`, actions: ["tinycloud.encryption/decrypt"] }] },
    };
    const input = { person: "ada@example.test", includePreviews: false };
    data.opened.push(new TextEncoder().encode(`${header}\n${JSON.stringify({ emails: ["ADA@example.test"], links: ["https://t.me/Ada_Quill"] })}`));
    expect(await operation().execute(withKey, input)).toMatchObject({ status: "ok", output: {
      contacts: [{ id: key, name: "Ada", emails: ["ada@example.test"], telegramHandles: ["@ada_quill"], match: "email" }],
      coverage: { contactsDetails: "available" },
    } });
    data.opened.push(new TextEncoder().encode(`${header.replace(key, `${contacts}other-deadbeef`)}\n{"emails":["ada@example.test"]}`));
    expect(await operation().execute(withKey, input)).toMatchObject({ status: "ok", output: {
      contacts: [], coverage: { contactsDetails: "unavailable" },
    } });
  } finally { data.close(); }
});

test("decrypts only with the exact Contacts app-key grant, and a refused decrypt leaves details unavailable", async () => {
  const data = fixture();
  try {
    const key = `${contacts}ada-quill-deadbeef`;
    const header = JSON.stringify(["tinycloud.app.seal/v1", owner.replace("tinycloud:", "did:"), `${owner}:applications`, key]);
    data.cards.set(key, { v: 1, data: { name: "Ada", sealed: JSON.stringify({ v: 2, keyPath: appKey, networkId: network, aad: Buffer.from(header).toString("base64") }) } });
    const granted = (...paths: string[]): RuntimeOperationContext => ({
      ...data.context,
      runtime: { ...data.context.runtime, granted: paths.map((path) => ({ service: "tinycloud.encryption", path, actions: ["tinycloud.encryption/decrypt"] })) },
    });
    const input = { person: "ada@example.test", includePreviews: false };
    const opened = new TextEncoder().encode(`${header}\n${JSON.stringify({ emails: ["ada@example.test"] })}`);
    // A bare-network or sibling-key decrypt grant says nothing about this key.
    data.opened.push(opened);
    for (const path of [network, `${network}/apps`, `${network}/${appKey}x`, `${network}/apps/xyz.tinycloud.share/other/seal-v1`]) {
      expect(await operation().execute(granted(path), input)).toMatchObject({ status: "ok", output: { contacts: [], coverage: { contactsDetails: "unavailable" } } });
    }
    expect(data.decrypts()).toBe(0);
    expect(await operation().execute(granted(network, `${network}/${appKey}`), input)).toMatchObject({
      status: "ok", output: { contacts: [{ id: key }], coverage: { contactsDetails: "available" } },
    });
    expect(data.decrypts()).toBe(1);
    data.opened.push(Object.assign(new Error("403 Forbidden"), { status: 403 }));
    expect(await operation().execute(granted(`${network}/${appKey}`), input)).toMatchObject({
      status: "ok", output: { contacts: [], coverage: { contactsDetails: "unavailable" } },
    });
    expect(data.decrypts()).toBe(2);
  } finally { data.close(); }
});

test("joins Telegram participants across shards, counting both directions only in a direct chat", async () => {
  const data = fixture();
  try {
    data.state.run("INSERT INTO accounts VALUES ('tg',?,'telegram','9')", [owner.replace("tinycloud:", "did:")]);
    data.state.exec("INSERT INTO chats VALUES ('tg','12','private','Ada Quill'),('tg','13','supergroup','Workshop')");
    data.main.exec(`INSERT INTO participants VALUES ('tg','12','4242','Ada Quill','@old_ada','sender',10),
      ('tg','13','4242','Ada Quill',NULL,'sender',10), ('tg','13','9','Owner','@owner','self',10)`);
    data.other.exec(`INSERT INTO participants VALUES ('tg','12','4242','Ada Quill','@ada_quill','sender',20),
      ('tg','13','51','Other','@other','member',20)`);
    const message = (shard: Database, chat: string, id: string, sender: string, direction: string, time: number,
      deleted: number | null = null, expires: number | null = null, body: string | null = null) =>
      shard.run("INSERT INTO messages VALUES ('tg',?,?,?,?,?,NULL,?,?,?)", [chat, id, sender, direction, time, deleted, expires, body]);
    const body = `${media}tg/bodies/${"a".repeat(64)}`;
    data.bodies.set(body, JSON.stringify({ text: "Next\u001b call\non Tuesday", content: null }));
    message(data.main, "12", "8", "4242", "incoming", data.stamp);
    message(data.other, "12", "99", "9", "outgoing", data.stamp + 4, null, null, body);
    message(data.main, "12", "100", "4242", "incoming", data.stamp + 4, null, null, body);
    message(data.main, "12", "101", "4242", "incoming", data.stamp + 9, null, data.stamp + 9);
    message(data.other, "13", "102", "4242", "incoming", data.stamp + 3);
    message(data.main, "13", "103", "51", "incoming", data.stamp + 10);
    message(data.other, "13", "104", "4242", "incoming", data.stamp + 11, data.stamp + 12);
    const result = await operation().execute(data.context, { person: "@ADA_QUILL" });
    expect(result).toMatchObject({ status: "ok", output: {
      counts: { telegramChats: 2, telegramMessages: 4, mailMessages: 0 },
      coverage: { telegram: "partial" },
      lastContactAt: new Date(data.stamp + 4).toISOString(),
      conversations: [
        { id: { accountId: "tg", sourceChatId: "12" }, latestMessageId: "100", messageCount: 3, preview: "Next call on Tuesday" },
        { id: { accountId: "tg", sourceChatId: "13" }, latestMessageId: "102", messageCount: 1, preview: null },
      ],
    } });
    expect(data.bodyReads).toEqual([body]);
    expect(await operation().execute(data.context, { person: "@old_ada", includePreviews: false }))
      .toMatchObject({ status: "ok", output: { conversations: [], coverage: { telegram: "partial" } } });
  } finally { data.close(); }
});

test("keyset paging preserves global counts and stable tie order without fetching out-of-page bodies", async () => {
  const data = fixture();
  try {
    data.mail(data.other, "105", "42", data.stamp + 1, [{ address: "ada@example.test" }], []);
    const body = `${media}gmail/bodies/${"b".repeat(64)}`;
    const attachment = `${media}gmail/${"c".repeat(64)}`;
    data.other.run("UPDATE mail SET text_kv_key = ? WHERE source_mail_id = '102'", [body]);
    data.other.run("UPDATE mail SET text_kv_key = ? WHERE source_mail_id = '105'", [attachment]);
    data.bodies.set(body, "x".repeat(300));
    const run = (cursor?: string, person = "ada@example.test") => operation().execute(data.context, { person, cursor, limit: 1 });
    const first = await run();
    if (first.status !== "ok") throw new Error("No first page");
    const { nextCursor, counts, lastContactAt } = first.output;
    expect(typeof nextCursor).toBe("string");
    expect(first).toMatchObject({ status: "ok", output: {
      counts: { mailThreads: 2, mailMessages: 3 },
      conversations: [{ id: { sourceChatId: "41" }, preview: "x".repeat(240) }],
    } });
    expect(await run(nextCursor)).toMatchObject({ status: "ok", output: {
      counts, lastContactAt,
      conversations: [{ id: { sourceChatId: "42" }, preview: null }], nextCursor: null,
    } });
    expect(await run(nextCursor, "other@example.test")).toMatchObject({ status: "error", error: { code: "INPUT_INVALID" } });
    expect(data.bodyReads).toEqual([body]);
  } finally { data.close(); }
});

test("previews strip hostile markup in linear time from at most 64 KB of a sender-controlled body", async () => {
  const data = fixture();
  try {
    const key = `${media}gmail/bodies/${"d".repeat(64)}`;
    data.other.run("UPDATE mail SET html_kv_key = ? WHERE source_mail_id = '102'", [key]);
    const preview = async () => {
      const started = performance.now();
      const result = await operation().execute(data.context, { person: "ada@example.test" });
      const elapsed = performance.now() - started;
      if (result.status !== "ok") throw new Error("No result");
      return { elapsed, text: result.output.conversations[0]?.preview };
    };
    data.bodies.set(key, "<style>p{color:red}</style><p>Hello&nbsp;<b>Ada</b> &amp; team</p><!-- hidden --><script>alert(1)</script>Thanks");
    expect((await preview()).text).toBe("Hello Ada & team Thanks");
    for (const flood of ["<", "<a", "<script>", "<!--", "<style x"]) {
      data.bodies.set(key, flood.repeat(Math.ceil(1_000_000 / flood.length)));
      const { elapsed } = await preview();
      expect(elapsed).toBeLessThan(200);
    }
    data.bodies.set(key, `${"x".repeat(64 * 1024)}<p>beyond the preview window</p>`);
    expect((await preview()).text).toBe("x".repeat(240));
  } finally { data.close(); }
});

test("requires only the two owner-bound roots without previews, and refuses an owner mismatch", async () => {
  const data = fixture();
  try {
    const definition = operation();
    const reader = {
      ...data.context, runtime: { ...data.context.runtime, granted: [
        { service: "tinycloud.sql", space: `${owner}:messages`, path: inbox, actions: ["tinycloud.sql/read"] },
      ] },
    };
    expect(await definition.authority(reader, { person: "Ada", includePreviews: false })).toEqual([
      { service: "tinycloud.kv", space: `${owner}:applications`, path: contacts, actions: ["tinycloud.kv/list", "tinycloud.kv/get"] },
    ]);
    await expect(definition.authority(reader, { person: "Ada" })).rejects.toThrow(media);
    const foreignReader = {
      ...reader, runtime: { ...reader.runtime, granted: [{ ...reader.runtime.granted[0]!, space: `${foreign}:messages` }] },
    };
    await expect(definition.authority(foreignReader, { person: "Ada", includePreviews: false })).rejects.toThrow(inbox);
    expect(await definition.execute({ ...data.context, summary: { ...data.context.summary, ownerDid: foreign.replace("tinycloud:", "did:") } }, { person: "Ada" }))
      .toMatchObject({ status: "error", error: { code: "READ_CONTEXT_MISMATCH" } });
  } finally { data.close(); }
});

test("rejects non-contiguous shard state and uses main only when the registry is absent", async () => {
  const data = fixture();
  try {
    const run = () => operation().execute(data.context, { person: "ada@example.test", includePreviews: false });
    data.state.exec("UPDATE inbox_shards SET sequence = 3 WHERE sequence = 2");
    expect(await run()).toMatchObject({ status: "error", error: { code: "OUTPUT_INVALID", message: expect.stringContaining("SHARD_REGISTRY_INVALID") } });
    data.state.exec("DROP TABLE inbox_shards");
    expect(await run()).toMatchObject({ status: "ok", output: { counts: { mailMessages: 1 }, conversations: [{ latestMessageId: "100" }] } });
  } finally { data.close(); }
});
