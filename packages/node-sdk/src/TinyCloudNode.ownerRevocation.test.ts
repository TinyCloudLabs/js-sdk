import { afterEach, expect, mock, test } from "bun:test";
import { parseSignedSiweCacao } from "@tinycloud/sdk-core";
import fixture from "../../sdk-core/test-fixtures/siwe-cacao/owner-share.json";
import { TinyCloudNode } from "./TinyCloudNode";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("owner revokes a CID in another space without delegating revocation authority", async () => {
  const signer = new PrivateKeySigner(fixture.ownerPrivateKey);
  const node = new TinyCloudNode({
    host: "http://127.0.0.1:8017",
    signer,
    wasmBindings: new NodeWasmBindings(),
  });
  Object.assign(node, {
    _restoredTcSession: {
      address: await signer.getAddress(),
      chainId: 1,
      spaceId: `tinycloud:pkh:eip155:1:${await signer.getAddress()}:account`,
    },
  });

  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("http://127.0.0.1:8017/revoke");
    expect(init?.method).toBe("POST");
    const authorization = new Headers(init?.headers).get("authorization");
    const proof = await parseSignedSiweCacao(authorization!);
    expect(proof).toMatchObject({
      issuer: fixture.ownerDid,
      audience: `ucan:${fixture.delegation.cid}`,
    });
    expect(Object.keys(proof.attenuation)).toEqual([]);
    return Response.json({ revoked: true, cid: fixture.delegation.cid });
  }) as typeof fetch;

  expect(await node.revokeDelegationAsOwner(fixture.delegation.cid))
    .toEqual({ revoked: true, cid: fixture.delegation.cid });
});

test("owner revocation SIWE matches the account-site golden message", async () => {
  const owner = new PrivateKeySigner(fixture.ownerPrivateKey);
  let message = "";
  const node = new TinyCloudNode({
    host: "http://127.0.0.1:8017",
    signer: {
      getAddress: () => owner.getAddress(),
      getChainId: () => owner.getChainId(),
      signMessage: async (siwe: string) => {
        message = siwe;
        return owner.signMessage(siwe);
      },
    },
    wasmBindings: new NodeWasmBindings(),
    domain: "account.tinycloud.xyz",
  });
  Object.assign(node, {
    _restoredTcSession: {
      address: await owner.getAddress(),
      chainId: 1,
      spaceId: `tinycloud:pkh:eip155:1:${await owner.getAddress()}:account`,
    },
  });

  await node.signOwnerRevocation(fixture.delegation.cid, {
    nonce: "abcdefgh",
    issuedAt: new Date("2026-10-16T19:00:00.000Z"),
  });
  expect(message).toBe([
    "account.tinycloud.xyz wants you to sign in with your Ethereum account:",
    "0xe8c2ab8468210C4b507C0563A10da60990eaa792",
    "",
    "",
    `URI: ucan:${fixture.delegation.cid}`,
    "Version: 1",
    "Chain ID: 1",
    "Nonce: abcdefgh",
    "Issued At: 2026-10-16T19:00:00.000Z",
    "Expiration Time: 2026-10-16T19:01:00.000Z",
  ].join("\n"));
});
