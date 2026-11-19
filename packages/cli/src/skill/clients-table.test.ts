import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CLIENT_NAMES } from "./clients.js";

// TC-3278: the per-client skills-folder table is one JSON file, and prompts carries the same file for its installer.
// No single test sees both repos, so each repo pins its own copy's hash: a change here fails this test until the pin
// is edited on purpose, and that edit is the cue to make the matching change to the file in prompts (and its pin).
const TABLE_SHA256 = "67d809cdd93c6fd62a41d811e7ae8c72580308558849954d01158c8c9b4d3238";
const bytes = readFileSync(new URL("./clients.json", import.meta.url));
const table = JSON.parse(bytes.toString("utf8")) as {
  folders: Record<string, { user: string; project: string | null }>;
  clients: Record<string, { label: string; folders: string[]; present: string | null }>;
};

describe("skill client table", () => {
  test("clients.json matches the pinned hash; change it only together with the same file in the prompts repo", () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(TABLE_SHA256);
  });

  test("it carries the ten named clients prompts carries, plus the generic `agents` row", () => {
    expect(Object.keys(table.clients)).toEqual([
      "amp",
      "claude-code",
      "codex",
      "copilot",
      "cursor",
      "gemini",
      "hermes",
      "omp",
      "openclaw",
      "opencode",
      "agents",
    ]);
  });

  test("every folder a client names is in the table, and every folder has a user path", () => {
    for (const client of Object.values(table.clients)) {
      for (const folder of client.folders) expect(table.folders[folder]).toBeDefined();
    }
    for (const folder of Object.values(table.folders)) expect(folder.user.length).toBeGreaterThan(0);
  });

  test("the \"Can't tell which agent this is\" list is built from the table, without the generic row", () => {
    expect(CLIENT_NAMES).toEqual(Object.keys(table.clients).filter((name) => name !== "agents"));
  });
});
