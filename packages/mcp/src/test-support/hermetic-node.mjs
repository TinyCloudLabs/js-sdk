import '../../../operations/test-support/test-bootstrap.mjs';
import { createHermeticEncryptedNode as createNode } from "../../../node-sdk/src/test-support/hermetic-encrypted-node.ts";
import { installMcpRegistryFixture } from "./registry-fixture.mjs";

export async function createHermeticEncryptedNode(...args) {
  installMcpRegistryFixture();
  const fixture = await createNode(...args);
  return fixture;
}
