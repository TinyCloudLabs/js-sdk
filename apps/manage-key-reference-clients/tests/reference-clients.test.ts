import { expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { TINYCLOUD_CANONICAL_IDENTITY_CLAIM } from "@tinycloud/sdk-core";
import { NOTES_CLIENT_ID, NotesTokenStore } from "../src/notes-client";
import { TASKS_CLIENT_ID, TasksTokenStore } from "../src/tasks-client";

function oauthIdentity() {
  const address = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  ).address;
  return {
    version: "v1" as const,
    keyId: "same-user-canonical-key",
    address,
    chainId: 1,
    did: `did:pkh:eip155:1:${address}`,
    spaceId: `tinycloud:pkh:eip155:1:${address}:applications`,
  };
}

test("isolated Notes and Tasks OAuth clients resolve one canonical DID space", () => {
  const notesTokens = new NotesTokenStore();
  const tasksTokens = new TasksTokenStore();
  const notes = notesTokens.save({
    client_id: NOTES_CLIENT_ID,
    access_token: "notes-oauth-access-token",
    claims: { [TINYCLOUD_CANONICAL_IDENTITY_CLAIM]: oauthIdentity() },
  });
  const tasks = tasksTokens.save({
    client_id: TASKS_CLIENT_ID,
    access_token: "tasks-oauth-access-token",
    id_token_claims: { [TINYCLOUD_CANONICAL_IDENTITY_CLAIM]: oauthIdentity() },
  });

  expect(NOTES_CLIENT_ID).not.toBe(TASKS_CLIENT_ID);
  expect(notesTokens.accessToken()).toBe("notes-oauth-access-token");
  expect(tasksTokens.accessToken()).toBe("tasks-oauth-access-token");
  expect(notes).not.toBe(tasks);
  expect(notes.address).toBe(tasks.address);
  expect(notes.did).toBe(tasks.did);
  expect(notes.spaceId).toBe(tasks.spaceId);
});

test("each client rejects an OAuth response issued to the other client", () => {
  expect(() => new NotesTokenStore().save({
    client_id: TASKS_CLIENT_ID,
    access_token: "tasks-oauth-access-token",
    claims: { [TINYCLOUD_CANONICAL_IDENTITY_CLAIM]: oauthIdentity() },
  })).toThrow("another client");
  expect(() => new TasksTokenStore().save({
    client_id: NOTES_CLIENT_ID,
    access_token: "notes-oauth-access-token",
    id_token_claims: { [TINYCLOUD_CANONICAL_IDENTITY_CLAIM]: oauthIdentity() },
  })).toThrow("another client");
});
