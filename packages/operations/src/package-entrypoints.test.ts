import { expect, test } from "bun:test";

test("operations root keeps registry-keyed invocation as its only public runtime helper", async () => {
  const operations = await import("./index.js");
  expect(Object.keys(operations)).toEqual(["invokeOperation"]);
});

test("state exposes only lock-owning primitives, never the lock-assuming writer", async () => {
  const state = await import("./state.js");
  expect("updateProfileStore" in state).toBe(true);
  expect("updateProfileStoreWhileLocked" in state).toBe(false);
});

test("invitation-approval exposes the one non-blocking approval call", async () => {
  const invitation = await import("./invitation-approval.js");
  expect(Object.keys(invitation)).toEqual(["requestInvitationApproval"]);
});

test("share-history exposes the profile sender history and its refusal error", async () => {
  const history = await import("./share-history.js");
  expect(Object.keys(history).sort()).toEqual(["ShareHistoryUnreadableError", "openProfileShareHistory"]);
});
