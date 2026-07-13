import { describe, expect, test } from "bun:test";
import { blake3 } from "@noble/hashes/blake3";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";

import { NodeWasmBindings } from "./NodeWasmBindings";
import { decodeAuthorizationBytes } from "./TinyCloudNode";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";

const INVALID_AUTHORIZATION =
  "Delegation Authorization is not canonical base64url DAG-CBOR";

describe("decodeAuthorizationBytes", () => {
  test.each([
    ["padded base64url", "Zm8=", "fo"],
    ["unpadded base64url", "Zm8", "fo"],
    ["Bearer-prefixed base64url", "Bearer Zm8=", "fo"],
  ])("accepts %s", (_label, authorization, expected) => {
    expect(new TextDecoder().decode(decodeAuthorizationBytes(authorization))).toBe(expected);
  });

  test.each([
    ["dotted JWS", "eyJhbGciOiJub25lIn0.e30."],
    ["other prefix", "Basic Zm8="],
    ["whitespace", " Zm8="],
    ["interior padding", "Z=m8"],
    ["wrong padding count", "Zm8=="],
    ["non-canonical trailing bits", "Zm9="],
  ])("rejects %s", (_label, authorization) => {
    expect(() => decodeAuthorizationBytes(authorization)).toThrow(INVALID_AUTHORIZATION);
  });
});

test("real WASM Authorization bytes round-trip to the delegation CID", async () => {
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner("1".padStart(64, "0"));
  const address = await signer.getAddress();
  const chainId = await signer.getChainId();
  const sessionManager = wasm.createSessionManager();
  const keyId = "authorization-round-trip";
  sessionManager.renameSessionKeyId("default", keyId);
  const jwk = JSON.parse(sessionManager.jwk(keyId)!);
  const issuedAt = new Date();
  const prepared = wasm.prepareSession({
    abilities: { kv: { "": ["tinycloud.kv/get"] } },
    address,
    chainId,
    domain: "localhost",
    issuedAt: issuedAt.toISOString(),
    expirationTime: new Date(issuedAt.getTime() + 60_000).toISOString(),
    spaceId: makePkhSpaceId(address, chainId, "authorization-round-trip"),
    jwk,
  });
  const delegationSession = wasm.completeSessionSetup({
    ...prepared,
    signature: await signer.signMessage(prepared.siwe),
  });

  const authorization = delegationSession.delegationHeader.Authorization;
  const exactBytes = decodeAuthorizationBytes(authorization);
  const independentlyDerivedCid = CID.createV1(
    0x55,
    createDigest(0x1e, blake3(exactBytes)),
  ).toString();

  expect(authorization).toMatch(/={1,2}$/);
  expect(Buffer.from(exactBytes).toString("base64url")).toBe(
    authorization.replace(/^Bearer /i, "").replace(/=+$/, ""),
  );
  expect(independentlyDerivedCid).toBe(delegationSession.delegationCid);
});

test("real WASM invokeAny preserves constrained-statement caveats", async () => {
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner("2".padStart(64, "0"));
  const address = await signer.getAddress();
  const chainId = await signer.getChainId();
  const sessionManager = wasm.createSessionManager();
  const keyId = "caveated-invocation";
  sessionManager.renameSessionKeyId("default", keyId);
  const jwk = JSON.parse(sessionManager.jwk(keyId)!);
  const issuedAt = new Date();
  const spaceId = makePkhSpaceId(address, chainId, "caveated-invocation");
  const prepared = wasm.prepareSession({
    abilities: {
      sql: { "xyz.tinycloud.listen/conversations": ["tinycloud.sql/read"] },
    },
    address,
    chainId,
    domain: "localhost",
    issuedAt: issuedAt.toISOString(),
    expirationTime: new Date(issuedAt.getTime() + 60_000).toISOString(),
    spaceId,
    jwk,
  });
  const session = wasm.completeSessionSetup({
    ...prepared,
    signature: await signer.signMessage(prepared.siwe),
  });
  const caveat = {
    mode: "constrained-statements",
    readOnly: true,
    statements: [
      {
        name: "listen.getConversation",
        sql: "SELECT id FROM conversation WHERE id = ?",
        fixedParams: [{ index: 0, value: "conv_456" }],
      },
    ],
  };

  const headers = wasm.invokeAny(session, [
    {
      spaceId,
      service: "sql",
      path: "xyz.tinycloud.listen/conversations",
      action: "tinycloud.sql/read",
      caveats: [caveat],
    },
  ]);
  const authorization = headers.Authorization as string;
  const payload = JSON.parse(
    Buffer.from(authorization.split(".")[1]!, "base64url").toString(),
  );
  const resource = `${spaceId}/sql/xyz.tinycloud.listen/conversations`;

  expect(payload.att[resource]["tinycloud.sql/read"]).toEqual([caveat]);

  const uncaveatedHeaders = wasm.invokeAny(session, [
    {
      spaceId,
      service: "sql",
      path: "xyz.tinycloud.listen/conversations",
      action: "tinycloud.sql/read",
    },
  ]);
  const uncaveatedAuthorization = uncaveatedHeaders.Authorization as string;
  const uncaveatedPayload = JSON.parse(
    Buffer.from(uncaveatedAuthorization.split(".")[1]!, "base64url").toString(),
  );
  expect(uncaveatedPayload.att[resource]["tinycloud.sql/read"]).toEqual([{}]);
});
