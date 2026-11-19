import { describe, expect, test } from "bun:test";

import { createPanelClient, type ClientSource } from "../../src/ui/client";

const storage = {} as ClientSource["storage"];

describe("client sign-out", () => {
  test("a source that can sign out hands the client a function that reaches the source once", async () => {
    let calls = 0;
    const { client } = createPanelClient(1, {
      signedIn: () => true,
      storage,
      signOut: async () => {
        calls += 1;
      },
    });

    expect(client.signOut).toBeFunction();
    await client.signOut?.();
    expect(calls).toBe(1);
  });

  test("a source that cannot sign out leaves the client without one, so the panel offers no button", () => {
    const { client } = createPanelClient(1, { signedIn: () => true, storage });

    expect(client.signOut).toBeUndefined();
  });
});
