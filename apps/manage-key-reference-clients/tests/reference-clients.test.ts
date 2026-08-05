import { expect, test } from "bun:test";
import { NOTES_CLIENT_ID } from "../src/notes-client";
import { runReferenceClients } from "../src/run";
import { TASKS_CLIENT_ID } from "../src/tasks-client";

test("runnable Notes and Tasks clients complete independent OAuth flows for one canonical DID space", async () => {
  const { notes, tasks, events } = await runReferenceClients();

  expect(NOTES_CLIENT_ID).not.toBe(TASKS_CLIENT_ID);
  expect(notes.accessToken).toStartWith("notes-");
  expect(tasks.bearer).toStartWith("tasks-");
  expect(notes.accessToken).not.toBe(tasks.bearer);
  expect(notes.identity).not.toBe(tasks.identity);
  expect(notes.identity.address).toBe(tasks.identity.address);
  expect(notes.identity.did).toBe(tasks.identity.did);
  expect(notes.identity.spaceId).toBe(tasks.identity.spaceId);
  expect(events).toEqual([
    { client: "notes", stage: "authorize", clientId: NOTES_CLIENT_ID },
    { client: "notes", stage: "token", clientId: NOTES_CLIENT_ID },
    { client: "tasks", stage: "authorize", clientId: TASKS_CLIENT_ID },
    { client: "tasks", stage: "token", clientId: TASKS_CLIENT_ID },
  ]);
});
