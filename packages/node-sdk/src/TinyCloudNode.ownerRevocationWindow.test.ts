import { expect, setSystemTime, test } from "bun:test";
import { parseSignedSiweCacao } from "@tinycloud/sdk-core";
import { SiweMessage } from "siwe";

import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { TinyCloudNode } from "./TinyCloudNode";

async function signedOwnerRevocation() {
  const signer = new PrivateKeySigner("1".padStart(64, "0"));
  const originalSignMessage = signer.signMessage.bind(signer);
  let message = "";
  let signature = "";
  signer.signMessage = async (input) => {
    message = typeof input === "string" ? input : Buffer.from(input).toString("utf8");
    signature = await originalSignMessage(input);
    return signature;
  };
  const node = new TinyCloudNode({
    domain: "revoke.test",
    signer,
    wasmBindings: new NodeWasmBindings(),
    autoBootstrapAccount: false,
  });
  (node as unknown as { _restoredTcSession: { address: string; chainId: number } })._restoredTcSession = {
    address: await signer.getAddress(),
    chainId: 1,
  };
  const authorization = await node.signOwnerRevocation("bafytest");
  return { authorization, siwe: new SiweMessage(message), signature };
}

test("owner revocation signs a 600-second window without Not Before", async () => {
  const before = Date.now();
  const { authorization, siwe } = await signedOwnerRevocation();
  const after = Date.now();
  const parsed = await parseSignedSiweCacao(authorization);

  expect(Date.parse(siwe.issuedAt)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(siwe.issuedAt)).toBeLessThanOrEqual(after);
  expect((Date.parse(siwe.expirationTime!) - Date.parse(siwe.issuedAt)) / 1000).toBe(600);
  expect(siwe.notBefore).toBeUndefined();
  expect(parsed.expiresAt).toBe(siwe.expirationTime);
});

test("owner revocation signed by a client two minutes behind verifies at node time", async () => {
  const nodeTime = new Date("2026-10-26T12:00:00.000Z");
  const clientTime = new Date(nodeTime.getTime() - 2 * 60_000);
  let signed: Awaited<ReturnType<typeof signedOwnerRevocation>>;
  setSystemTime(clientTime);
  try {
    signed = await signedOwnerRevocation();
  } finally {
    setSystemTime();
  }

  expect(signed.siwe.issuedAt).toBe(clientTime.toISOString());
  expect(signed.siwe.notBefore).toBeUndefined();
  expect(Date.parse(signed.siwe.expirationTime!)).toBeGreaterThan(nodeTime.getTime());
  expect((await signed.siwe.verify({ signature: signed.signature, time: nodeTime.toISOString() })).success).toBe(true);
  await expect(parseSignedSiweCacao(signed.authorization)).resolves.toMatchObject({ expiresAt: signed.siwe.expirationTime });
});
