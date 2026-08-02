import { describe, expect, it } from "vitest";

import { computeCid, verifyCid } from "../src/cid.js";
import { utf8Bytes } from "../src/bytes.js";

describe("computeCid", () => {
  it('matches the publicly known CIDv1-raw-sha256 vector for "hello world"', async () => {
    // External interop vector: `echo -n "hello world" | ipfs block put --cid-codec=raw`
    expect(await computeCid(utf8Bytes("hello world"))).toBe(
      "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e",
    );
  });

  it("is stable for the protocol-label vector (pinned, self-consistent)", async () => {
    expect(await computeCid(utf8Bytes("tinycloud-share-envelope-v1 test vector"))).toBe(
      "bafkreiclwgh7qxq76iaj5jzkxqu2zqv4xgotluq7njutqopck4byuf2444",
    );
  });

  it("produces canonical lowercase base32 bafkr… strings", async () => {
    const cid = await computeCid(new Uint8Array([1, 2, 3]));
    expect(cid.startsWith("bafkr")).toBe(true);
    expect(cid).toBe(cid.toLowerCase());
  });
});

describe("verifyCid", () => {
  const bytes = utf8Bytes("hello world");
  const good = "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e";

  it("accepts the matching CID", async () => {
    expect(await verifyCid(bytes, good)).toBe(true);
  });

  it("rejects tampered bytes (flip one byte)", async () => {
    const tampered = Uint8Array.from(bytes);
    tampered[0]! ^= 0x01;
    expect(await verifyCid(tampered, good)).toBe(false);
  });

  it("rejects a CID for different bytes", async () => {
    expect(await verifyCid(utf8Bytes("hello worlD"), good)).toBe(false);
  });

  it("rejects garbage CID strings without throwing", async () => {
    expect(await verifyCid(bytes, "not-a-cid")).toBe(false);
    expect(await verifyCid(bytes, "")).toBe(false);
  });

  it("rejects a CIDv0 of any bytes", async () => {
    expect(
      await verifyCid(bytes, "QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn"),
    ).toBe(false);
  });

  it("rejects non-canonical string forms of the right hash (base32 upper)", async () => {
    expect(await verifyCid(bytes, good.toUpperCase())).toBe(false);
  });
});
