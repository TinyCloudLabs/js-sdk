import { expect, test } from "bun:test";
import { PrivateKeySigner } from "@tinycloud/node-sdk";
import {
  revokeOwnerCid, verifyOwnerRevocationResponse,
  type OwnerSignatureTransport,
} from "./owner-revocation.js";
import type { OwnerRevocationRequest } from "../auth/prepared-openkey.js";

const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d4b2c197a7e5e7b7");
const address = await signer.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const cid = "bafkreifgtjvoio4u4m3r5giyg267oe6t2i5rr3qvbny3tb7325dmw7ask4";

// Billing's exact plain SIWE text layout, with OpenKey's host as domain.
function billingSiwe(request: OwnerRevocationRequest, overrides: {
  address?: string; uri?: string; nonce?: string; issuedAt?: string; expiration?: string; extra?: string;
} = {}): string {
  return [
    "openkey.tinycloud.xyz wants you to sign in with your Ethereum account:",
    overrides.address ?? address, "", "",
    `URI: ${overrides.uri ?? `ucan:${request.cid}`}`,
    "Version: 1", "Chain ID: 1", `Nonce: ${overrides.nonce ?? request.nonce}`,
    `Issued At: ${overrides.issuedAt ?? new Date(Date.parse(request.expiresAt) - 600_000).toISOString()}`,
    `Expiration Time: ${overrides.expiration ?? request.expiresAt}`,
    ...(overrides.extra ? [overrides.extra] : []),
  ].join("\n");
}

function request(): OwnerRevocationRequest {
  return { kind: "owner-revocation", ownerDid, cid, nonce: "1234567890abcdef", expiresAt: new Date(Date.now() + 600_000).toISOString() };
}

test("accepts billing's exact plain owner SIWE layout and its signature", async () => {
  const input = request();
  const siwe = billingSiwe(input);
  const authorization = await verifyOwnerRevocationResponse(input, { siwe, signature: await signer.signMessage(siwe) });
  expect(authorization).toMatch(/^[A-Za-z0-9_-]+={0,2}$/);
});

test("refuses changed signer, URI, nonce, time window, statement, Not Before and Resources", async () => {
  const input = request();
  const issuedAt = new Date(Date.now() - 2_000).toISOString();
  const badMessages = [
    billingSiwe(input, { address: "0x0000000000000000000000000000000000000001" }),
    billingSiwe(input, { uri: "ucan:another" }),
    billingSiwe(input, { nonce: "another12345678" }),
    billingSiwe(input, { issuedAt: new Date(Date.now() - 601_000).toISOString() }),
    billingSiwe(input, { expiration: new Date(Date.parse(input.expiresAt) + 1_000).toISOString() }),
    billingSiwe(input, { extra: "Not Before: 2026-10-26T00:00:00.000Z" }),
    billingSiwe(input, { extra: "Resources:\n- urn:cid:another" }),
    billingSiwe(input, { issuedAt, extra: "Resources:\n- urn:recap:eyJhdHQiOnt9fQ" }),
    billingSiwe(input).replace("\n\n\nURI:", "\n\nApprove all grants\nURI:"),
  ];
  for (const siwe of badMessages) {
    await expect(verifyOwnerRevocationResponse(input, { siwe, signature: await signer.signMessage(siwe) }))
      .rejects.toMatchObject({ code: "OWNER_REVOCATION_SIGNATURE_INVALID" });
  }
});

test("one owner signature posts Authorization only; a 403 preserves refusal and invalid text sends nothing", async () => {
  const requested: OwnerRevocationRequest[] = [];
  const completed: boolean[] = [];
  const transport: OwnerSignatureTransport = async ({ request: input }) => {
    requested.push(input);
    const siwe = billingSiwe(input);
    return { url: "https://openkey.tinycloud.xyz/delegate#tv2=test",
      result: Promise.resolve({ siwe, signature: await signer.signMessage(siwe) }),
      async complete(accepted) { completed.push(accepted); } };
  };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return Response.json({ revoked: true, cid });
  }) as typeof fetch;
  await revokeOwnerCid({ ownerDid, cid, host: "https://node.example", openKeyHost: "https://openkey.tinycloud.xyz", transport, fetchFn });
  expect(requested).toHaveLength(1);
  expect(Date.parse(requested[0]!.expiresAt) - Date.now()).toBeLessThanOrEqual(600_000);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://node.example/revoke");
  expect(calls[0]!.init.method).toBe("POST");
  expect(calls[0]!.init.body).toBeUndefined();
  expect((calls[0]!.init.headers as Record<string, string>).Authorization).toMatch(/^[A-Za-z0-9_-]+={0,2}$/);
  expect(completed).toEqual([true]);

  const denied = (async () => new Response("Unauthorized Revoker", { status: 403 })) as unknown as typeof fetch;
  await expect(revokeOwnerCid({ ownerDid, cid, host: "https://node.example", openKeyHost: "https://openkey.tinycloud.xyz", transport, fetchFn: denied }))
    .rejects.toMatchObject({ code: "REVOKE_UNAUTHORIZED", exitCode: 5 });
  expect(completed.at(-1)).toBe(false);

  const invalidTransport: OwnerSignatureTransport = async ({ request: input }) => {
    const siwe = billingSiwe(input, { nonce: "mismatched123456" });
    return { url: "", result: Promise.resolve({ siwe, signature: await signer.signMessage(siwe) }),
      async complete(accepted) { completed.push(accepted); } };
  };
  await expect(revokeOwnerCid({ ownerDid, cid, host: "https://node.example", openKeyHost: "https://openkey.tinycloud.xyz", transport: invalidTransport, fetchFn }))
    .rejects.toMatchObject({ code: "OWNER_REVOCATION_SIGNATURE_INVALID" });
  expect(calls).toHaveLength(1);
});
