import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerFeedCommand } from "./feed";
import { cardMdVersion } from "../feed/card-md";
import { ProfileManager } from "../config/profiles";
import * as sdk from "../lib/sdk";
import { initializeFeedDatabases } from "../../../sdk-services/src/feed";
import { sqliteHandle, unwrap } from "../../../sdk-services/src/feed/sqlite.test-helper";
import type { FeedDatabase } from "../../../sdk-services/src/feed";

const directories: string[] = [];
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const action of cleanup.splice(0).reverse()) action();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const SPACE = "tinycloud:pkh:eip155:1:0x00000000000000000000000000000000000000aa:applications";
const card = {
  cardId: "card-1", revision: 1, issuanceId: "issuance-1", kind: "information", needsResponse: false,
  title: "Hello", body: "Body", urgency: 1, createdAt: "2026-11-19T05:00:00Z",
};

/** The owner's Feed delivers the table; the agent only reads it. */
async function setCardMd(responses: FeedDatabase, text: string) {
  unwrap(await responses.execute("CREATE TABLE IF NOT EXISTS card_md (id INTEGER PRIMARY KEY, text TEXT NOT NULL, version TEXT NOT NULL, updated_at TEXT NOT NULL)"));
  unwrap(await responses.execute("DELETE FROM card_md"));
  unwrap(await responses.execute("INSERT INTO card_md (id, text, version, updated_at) VALUES (1, ?, ?, ?)", [text, cardMdVersion(text), "2026-11-19T05:00:00.000Z"]));
}

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "feed-card-md-cmd-"));
  directories.push(home);
  const output = sqliteHandle();
  const responses = sqliteHandle();
  cleanup.push(output.close, responses.close);
  unwrap(await initializeFeedDatabases({ output: output.handle, responses: responses.handle }));
  let published = 0;
  // Each publish needs its own immutable issuance.
  const nextCardFile = () => {
    published += 1;
    const file = join(home, `card-${published}.json`);
    writeFileSync(file, JSON.stringify({ ...card, cardId: `card-${published}`, issuanceId: `issuance-${published}` }));
    return file;
  };
  let responsesReadable = true;
  // The SQL service answers a failed statement (a missing table too) as an error result, not a throw.
  const serviceResponses: FeedDatabase = {
    ...responses.handle,
    query: async (sql, params) => {
      try { return await responses.handle.query(sql, params); }
      catch (error) { return { ok: false as const, error: { code: "SQL_ERROR", message: `SQLite error: ${(error as Error).message}`, service: "sql" } }; }
    },
  };
  const spies = [
    spyOn(ProfileManager, "resolveContext").mockResolvedValue({ profile: "feed-demo" } as never),
    spyOn(ProfileManager, "ensureProfileDir").mockResolvedValue(home),
    spyOn(sdk, "ensureAuthenticated").mockResolvedValue({
      spaceId: SPACE,
      sqlForSpace: () => ({
        db: (resource: string) => {
          if (!resource.includes("feed_responses_")) return output.handle;
          return responsesReadable ? serviceResponses : {
            ...responses.handle,
            query: async () => ({ ok: false as const, error: { code: "UNAVAILABLE", message: "node unreachable", service: "sql" } }),
          };
        },
      }),
    } as never),
  ];
  cleanup.push(() => spies.forEach((spy) => spy.mockRestore()));

  async function run(...args: string[]): Promise<{ stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";
    const out = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as never);
    const err = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as never);
    // A failing command ends with process.exit; turn it into a failure the test can read.
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    try {
      const program = new Command().exitOverride();
      registerFeedCommand(program);
      await program.parseAsync(["node", "tinycloud", "feed", ...args]);
    } catch (error) {
      throw new Error(`${String(error)}\nstdout: ${stdout}\nstderr: ${stderr}`);
    } finally { out.mockRestore(); err.mockRestore(); exit.mockRestore(); }
    return { stdout, stderr };
  }
  return { home, responses: responses.handle, output: output.handle, get cardFile() { return nextCardFile(); }, run, breakResponses: () => { responsesReadable = false; } };
}

test("feed card-md prints the owner's card.md as {text, version, updatedAt} and null before the owner's Feed delivered one", async () => {
  const f = await fixture();
  expect(JSON.parse((await f.run("card-md", "--agent", "demo")).stdout)).toBeNull();
  await setCardMd(f.responses, "Post two cards a day at most.");
  const shown = await f.run("card-md", "--agent", "demo");
  expect(JSON.parse(shown.stdout)).toEqual({
    text: "Post two cards a day at most.", version: cardMdVersion("Post two cards a day at most."), updatedAt: "2026-11-19T05:00:00.000Z",
  });
  expect(shown.stderr).toBe("");
});

test("publish prints the new text on stderr once per version and leaves its JSON output on stdout alone", async () => {
  const f = await fixture();
  // Before the owner's Feed delivers a card.md: nothing extra.
  const none = await f.run("publish", "--agent", "demo", "--file", f.cardFile);
  expect(JSON.parse(none.stdout)).toMatchObject({ cardId: "card-1" });
  expect(none.stderr).toBe("");

  await setCardMd(f.responses, "Use plain words.");
  const first = await f.run("publish", "--agent", "demo", "--file", f.cardFile);
  expect(Object.keys(JSON.parse(first.stdout)).sort()).toEqual(Object.keys(JSON.parse(none.stdout)).sort());
  expect(first.stderr).toBe(`The owner's card.md changed (${cardMdVersion("Use plain words.")}):\nUse plain words.\n`);
  expect((await f.run("publish", "--agent", "demo", "--file", f.cardFile)).stderr).toBe("");

  await setCardMd(f.responses, "Use plain words and short titles.");
  expect((await f.run("publish", "--agent", "demo", "--file", f.cardFile)).stderr)
    .toBe(`The owner's card.md changed (${cardMdVersion("Use plain words and short titles.")}):\nUse plain words and short titles.\n`);
});

test("reading card.md with feed card-md counts as shown, so the next publish stays quiet", async () => {
  const f = await fixture();
  await setCardMd(f.responses, "Read me first.");
  await f.run("card-md", "--agent", "demo");
  expect((await f.run("publish", "--agent", "demo", "--file", f.cardFile)).stderr).toBe("");
  expect(readFileSync(join(f.home, "feed-card-md.json"), "utf8")).toContain(cardMdVersion("Read me first."));
});

test("a card.md that cannot be read never fails the publish: one line on stderr, the card is still published", async () => {
  const f = await fixture();
  f.breakResponses();
  const result = await f.run("publish", "--agent", "demo", "--file", f.cardFile);
  expect(JSON.parse(result.stdout)).toMatchObject({ cardId: "card-1" });
  expect(result.stderr).toBe("Could not read the owner's card.md; this command is not affected.\n");
});
