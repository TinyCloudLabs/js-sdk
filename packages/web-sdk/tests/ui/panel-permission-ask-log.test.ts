/*
 * The panel's permission request keeps the user-visible answer for a thrown error ("failed") and writes the error's
 * class (name and code) to the SDK debug log, without its message, cause or stack.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createPanelClient, type ClientSource } from "../../src/ui/client";

const SECRET = "SIWE-TEXT-signature-0xdeadbeef";

let logged: unknown[][] = [];
const realError = console.error;

beforeEach(() => {
  logged = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
});

afterEach(() => {
  console.error = realError;
});

function clientFor(requestPermissions: NonNullable<ClientSource["requestPermissions"]>) {
  const source: ClientSource = {
    signedIn: () => true,
    storage: { status: async () => ({ ok: false }) } as unknown as ClientSource["storage"],
    canRequestPermissions: () => true,
    requestPermissions,
  };
  return createPanelClient(1, source).client;
}

describe("panel permission request failure", () => {
  test("a thrown error is logged by name and code and the answer is still 'failed'", async () => {
    const client = clientFor(async () => {
      throw Object.assign(new Error(`bad signature ${SECRET}`), { name: "RuntimeDelegationRejectedError", code: "E_ACTIVATE", cause: SECRET });
    });

    const answer = await client.requestAuthority?.("delegation/list");

    expect(answer).toEqual({ approved: false, code: "failed" });
    expect(logged.at(-1)?.slice(1)).toEqual(["RuntimeDelegationRejectedError", "E_ACTIVATE"]);
    expect(logged.some((line) => (line[2] as { code?: string } | undefined)?.code === "E_ACTIVATE")).toBe(true);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });

  test("an error without a code is logged by name only", async () => {
    const client = clientFor(async () => {
      throw new TypeError(SECRET);
    });

    const answer = await client.requestAuthority?.("delegation/list");

    expect(answer).toEqual({ approved: false, code: "failed" });
    expect(logged.at(-1)?.slice(1)).toEqual(["TypeError", ""]);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });

  test("a decline is not logged", async () => {
    const client = clientFor(async () => ({ approved: false }));

    expect(await client.requestAuthority?.("delegation/list")).toEqual({ approved: false, code: "declined" });
    expect(logged).toHaveLength(0);
  });
});
