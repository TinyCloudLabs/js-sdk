import { describe, expect, test } from "bun:test";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";

const wasm = new NodeWasmBindings();
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const spaceId = wasm.makeSpaceId(address, 1, "default");
const manager = wasm.createSessionManager();
const jwk = JSON.parse(manager.jwk("default")!) as object;

const now = Date.now();
const prepared = wasm.prepareSession({
  abilities: {
    sql: { "data.sqlite": ["tinycloud.sql/read"] },
    kv: { notes: ["tinycloud.kv/get"] },
  },
  address,
  chainId: 1,
  domain: "cli.example.test",
  issuedAt: new Date(now - 60_000).toISOString(),
  expirationTime: new Date(now + 3_600_000).toISOString(),
  spaceId,
  jwk,
});
const signature = await signer.signMessage(prepared.siwe);
const granted = wasm.completeSessionSetup({ ...prepared, signature });
const session = {
  delegationHeader: granted.delegationHeader,
  delegationCid: granted.delegationCid,
  spaceId,
  verificationMethod: manager.getDID("default"),
  jwk,
};

const profile = {
  mode: "constrained-statements",
  readOnly: true,
  statements: [{ name: "get", sql: "SELECT 1", fixedParams: [] }],
};

/** The caveat lists the signed invocation carries, one per capability. */
function signedCaveats(service: string, path: string, action: string, caveats?: Record<string, unknown>[]): unknown[] {
  const { Authorization } = wasm.invokeAny!(session, [{ spaceId, service, path, action, ...(caveats === undefined ? {} : { caveats }) }]);
  const payload = JSON.parse(Buffer.from(Authorization.replace(/^Bearer\s+/i, "").split(".")[1]!, "base64url").toString()) as {
    att: Record<string, Record<string, unknown[]>>;
  };
  return Object.values(payload.att).flatMap((abilities) => abilities[action] ?? []);
}

describe("NodeWasmBindings.invokeAny and delegated SQL caveats", () => {
  test.each([
    ["delegated form", [{ tables: ["NOTES"], columns: ["id"], readOnly: true }]],
    ["readOnly only", [{ readOnly: true }]],
    ["tables: []", [{ tables: [] }]],
    ["two empty entries", [{}, {}]],
  ] as const)("a sql capability with %s carries no caveat on the invocation", (_label, caveats) => {
    const signed = signedCaveats("sql", "data.sqlite", "tinycloud.sql/read", [...caveats]);
    expect(signed).toEqual([{}]);
  });

  test("a constrained-statements profile is signed on the invocation, unchanged", () => {
    expect(signedCaveats("sql", "data.sqlite", "tinycloud.sql/read", [profile])).toEqual([profile]);
  });

  test("a sql capability with no caveats or [{}] is signed as before", () => {
    expect(signedCaveats("sql", "data.sqlite", "tinycloud.sql/read")).toEqual([{}]);
    expect(signedCaveats("sql", "data.sqlite", "tinycloud.sql/read", [{}])).toEqual([{}]);
  });

  test("another service keeps its caveats, even in the delegated shape", () => {
    for (const caveats of [[{ tables: ["NOTES"] }], [{}, {}]]) {
      expect(signedCaveats("kv", "notes", "tinycloud.kv/get", caveats)).toEqual(caveats);
    }
  });
});
