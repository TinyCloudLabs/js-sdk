import { describe, expect, test } from "bun:test";
import { authorizationVerdictOf } from "@tinycloud/sdk-services";
import {
  importPortableDelegation,
  parsePortableDelegation,
  serializePortableDelegation,
} from "./portable";

const delegation = {
  cid: "bafy-s0",
  delegationHeader: { Authorization: "eyJhbGciOiJFZERTQSJ9.payload.signature" },
  ownerAddress: "0x0000000000000000000000000000000000000001",
  chainId: 1,
  host: "https://node.example.test",
  spaceId:
    "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:applications",
  path: "docs/a",
  actions: ["tinycloud.kv/get"],
  expiry: new Date("2026-08-01T00:00:00Z"),
  delegateDID: "did:key:recipient",
  resources: [
    {
      service: "kv",
      space:
        "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:applications",
      path: "docs/a",
      actions: ["tinycloud.kv/get"],
    },
  ],
};

describe("portable delegation admission", () => {
  test("round-trips without changing authorization bytes", () => {
    expect(
      parsePortableDelegation(
        JSON.parse(serializePortableDelegation(delegation)),
      ),
    ).toMatchObject({
      cid: delegation.cid,
      delegationHeader: delegation.delegationHeader,
      expiry: delegation.expiry,
      resources: delegation.resources,
    });
  });

  test("imports through ordinary POST /delegate", async () => {
    const requests: Request[] = [];
    const fetchFn = async (input: string | URL, init?: RequestInit) => {
      requests.push(new Request(input.toString(), init));
      return new Response(
        JSON.stringify({ activated: [delegation.spaceId], skipped: [] }),
        { status: 200 },
      );
    };
    await importPortableDelegation(fetchFn, delegation.host, delegation);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe("/delegate");
    expect(requests[0]!.headers.get("authorization")).toBe(
      delegation.delegationHeader.Authorization,
    );
  });

  describe("delegated SQL caveats", () => {
    const sqlDelegation = (caveats: Record<string, unknown>[] | undefined, flat = false) => ({
      ...delegation,
      actions: ["tinycloud.sql/read"],
      ...(flat ? { caveats } : {}),
      resources: [{
        service: "sql",
        space: delegation.spaceId,
        path: "data.sqlite",
        actions: ["tinycloud.sql/read"],
        ...(flat || caveats === undefined ? {} : { caveats }),
      }],
    });

    function spyFetch(): { requests: string[]; fetchFn: (input: string | URL) => Promise<Response> } {
      const requests: string[] = [];
      return {
        requests,
        fetchFn: async (input) => {
          requests.push(input.toString());
          return new Response(JSON.stringify({ activated: [] }), { status: 200 });
        },
      };
    }

    test.each([
      ["delegated form in resources", sqlDelegation([{ tables: ["Notes"] }])],
      ["two empty-only entries", sqlDelegation([{}, {}])],
      ["delegated form in the flat caveats", sqlDelegation([{ readOnly: true }], true)],
    ] as const)("refuses %s with no request unless the node is known to support it", async (_label, value) => {
      const { requests, fetchFn } = spyFetch();
      await expect(importPortableDelegation(fetchFn, delegation.host, value)).rejects.toMatchObject({
        code: "SQL_DELEGATED_CAVEATS_UNSUPPORTED",
      });
      await expect(
        importPortableDelegation(fetchFn, delegation.host, value, { supportsSqlDelegatedCaveats: false }),
      ).rejects.toMatchObject({ code: "SQL_DELEGATED_CAVEATS_UNSUPPORTED" });
      expect(requests).toEqual([]);
      await importPortableDelegation(fetchFn, delegation.host, value, { supportsSqlDelegatedCaveats: true });
      expect(requests).toHaveLength(1);
    });

    test.each([
      ["no caveats", sqlDelegation(undefined)],
      ["[{}]", sqlDelegation([{}])],
      ["a constrained-statements profile", sqlDelegation([{ mode: "constrained-statements", readOnly: true, statements: [] }])],
    ] as const)("does not gate %s", async (_label, value) => {
      const { requests, fetchFn } = spyFetch();
      await importPortableDelegation(fetchFn, delegation.host, value);
      expect(requests).toHaveLength(1);
    });

    test("a delegated-looking caveat on another service is not gated", async () => {
      const { requests, fetchFn } = spyFetch();
      await importPortableDelegation(fetchFn, delegation.host, {
        ...delegation,
        resources: [{ ...delegation.resources[0]!, caveats: [{ tables: ["Notes"] }] }],
      });
      expect(requests).toHaveLength(1);
    });
  });
  test.each([
    [401, "", "unauthenticated"],
    [401, "Forbidden", "unauthenticated"],
    [403, "Unauthorized Action: docs/a", "forbidden"],
    [403, "session expired", "forbidden"],
  ] as const)("preserves HTTP %i and server body %s from /delegate", async (status, body, verdict) => {
    const error: unknown = await importPortableDelegation(
      async () => new Response(body, { status }), delegation.host, delegation,
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ status });
    expect((error as Error).message).toContain(String(status));
    if (body) expect((error as Error).message).toContain(body);
    expect(authorizationVerdictOf(error)).toBe(verdict);
  });

});
