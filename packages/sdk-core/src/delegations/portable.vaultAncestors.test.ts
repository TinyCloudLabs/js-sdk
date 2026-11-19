import { describe, expect, test } from "bun:test";
import { bases } from "multiformats/basics";
import { ed25519 } from "@noble/curves/ed25519";
import { delegationTouchesVault, sessionTouchesVault } from "./portable";

// TC-2944: a grant that reaches vault data from above (the whole key space, or
// a whole space) is routed like one that names it. Node-level grants are not.
const SPACE = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";
const SEED = new Uint8Array(32).fill(23);
const PUBLIC = ed25519.getPublicKey(SEED);
const DID = `did:key:${bases.base58btc.encode(Uint8Array.from([0xed, 0x01, ...PUBLIC]))}`;
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function compact(att: Record<string, Record<string, unknown[]>>): string {
  const input = [
    b64({ alg: "EdDSA", typ: "JWT", ucv: "0.10.0", jwk: { kty: "OKP", crv: "Ed25519", x: Buffer.from(PUBLIC).toString("base64url") } }),
    b64({ iss: DID, aud: DID, exp: 4_000_000_000, prf: [], att }),
  ].join(".");
  return `${input}.${Buffer.from(ed25519.sign(new TextEncoder().encode(input), SEED)).toString("base64url")}`;
}

function siwe(att: Record<string, Record<string, unknown[]>>): string {
  return [
    "example.com wants you to sign in with your Ethereum account:",
    "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
    "",
    "By signing this message you agree to the terms.",
    "",
    `URI: ${DID}`,
    "Version: 1",
    "Chain ID: 1",
    "Nonce: abcdef01",
    "Issued At: 2026-08-01T00:00:00.000Z",
    "Expiration Time: 2026-08-01T01:00:00.000Z",
    "Resources:",
    `- urn:recap:${b64({ att, prf: [] })}`,
  ].join("\n");
}

const KV = { "tinycloud.kv/get": [{}], "tinycloud.kv/list": [{}] };
const HOST = { "tinycloud.space/host": [{}] };

// [label, grant, routed to the TEE origin as a delegation, as a session's own recap]
const grants: Array<[string, Record<string, Record<string, unknown[]>>, boolean, boolean]> = [
  ["the key-space root", { [`${SPACE}/kv/`]: KV }, true, false],
  ["the key-space root without a slash", { [`${SPACE}/kv`]: KV }, true, false],
  ["a space root with kv abilities", { [SPACE]: KV }, true, false],
  ["a root grant next to an ordinary one", { [`${SPACE}/kv/notes`]: KV, [`${SPACE}/kv/`]: KV }, true, false],
  ["a root grant next to a vault name", { [`${SPACE}/kv/`]: KV, [`${SPACE}/kv/vault/api-key`]: KV }, true, true],
  ["a vault name", { [`${SPACE}/kv/vault/api-key`]: KV }, true, true],
  ["the secrets space", { [`${SPACE.replace(/:default$/, ":secrets")}/kv/`]: KV }, true, true],
  ["an ordinary prefix", { [`${SPACE}/kv/notes/`]: KV }, false, false],
  ["space hosting only", { [SPACE]: HOST }, false, false],
  ["a sql database", { [`${SPACE}/sql/vault`]: { "tinycloud.sql/read": [{}] } }, false, false],
  ["a node-level name", { "tinycloud://node.example/kv/": KV }, false, false],
];

describe("grants that reach vault data from above", () => {
  test.each(grants)("a signed delegation for %s", async (_label, att, asDelegation) => {
    expect(await delegationTouchesVault(compact(att))).toBe(asDelegation);
  });

  // A session's recap is audienced to the session key, so a broad key-space
  // root names no vault entry and does not move sign-in to the TEE origin.
  test.each(grants)("a session recap for %s", async (_label, att, _asDelegation, asSession) => {
    const delegationHeader = { Authorization: compact({ [`${SPACE}/kv/notes`]: KV }) };
    expect(await sessionTouchesVault({ siwe: siwe(att), delegationHeader })).toBe(asSession);
  });

  test("a session without a recap is read as a delegation", async () => {
    expect(await sessionTouchesVault({ delegationHeader: { Authorization: compact({ [`${SPACE}/kv/`]: KV }) } })).toBe(true);
    expect(await sessionTouchesVault({ delegationHeader: { Authorization: compact({ [`${SPACE}/kv/notes/`]: KV }) } })).toBe(false);
  });

  test("a grant that cannot be read still counts as vault", async () => {
    expect(await delegationTouchesVault("not-a-grant")).toBe(true);
  });
});
