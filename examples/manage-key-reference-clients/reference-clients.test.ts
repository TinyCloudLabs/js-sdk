import { expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { TINYCLOUD_CANONICAL_IDENTITY_CLAIM } from "@tinycloud/sdk-core";
import { resolveNotesClientIdentity } from "./notes-client";
import { resolveTasksClientIdentity } from "./tasks-client";

const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const canonicalIdentity = {
  version: "v1" as const,
  keyId: "user-42-canonical-key",
  address: account.address,
  chainId: 1,
  did: `did:pkh:eip155:1:${account.address}`,
  spaceId: `tinycloud:pkh:eip155:1:${account.address}:shared-user-space`,
};

test("independent OAuth client adapters resolve one user's canonical address and space", () => {
  // Notes consumes a complete, already verified OIDC claims object while Tasks
  // receives only its provider's canonical-identity claim. They are separate
  // adapters and distinct inputs, not two calls over a shared object.
  const notes = resolveNotesClientIdentity({
    iss: "https://issuer.example.test",
    sub: "user-42",
    [TINYCLOUD_CANONICAL_IDENTITY_CLAIM]: { ...canonicalIdentity },
  });
  const tasks = resolveTasksClientIdentity({ ...canonicalIdentity });

  expect(notes).toEqual(canonicalIdentity);
  expect(tasks).toEqual(canonicalIdentity);
  expect(notes.address).toBe(tasks.address);
  expect(notes.did).toBe(tasks.did);
  expect(notes.spaceId).toBe(tasks.spaceId);
});
