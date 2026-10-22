import { describe, expect, it } from "bun:test";
import { receiveShare, ShareReceiveError, type ShareOpenOptions } from "../src/index.js";

const holderDid = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

describe("receiveShare open flow", () => {
  it("refuses to open without a presentation builder before any network call", async () => {
    const calls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response("unexpected", { status: 500 });
    };
    // The builder is a required runtime input that TypeScript callers can omit
    // at the JS boundary; cast only the options object to exercise that path.
    const withoutBuilder = { holderDid, sign: async (bytes: Uint8Array) => bytes, fetchFn } as unknown as ShareOpenOptions;
    const error = await receiveShare("https://share.tinycloud.xyz/s/unused", { open: withoutBuilder }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ShareReceiveError);
    expect((error as ShareReceiveError).code).toBe("authorization-denied");
    expect(calls).toEqual([]);
  });
});
