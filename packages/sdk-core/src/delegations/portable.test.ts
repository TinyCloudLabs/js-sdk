import { describe, expect, test } from "bun:test";
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
});
