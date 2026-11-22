import { describe, expect, test } from "bun:test";
import { expandDelegationPermissionEntries, type PermissionEntry } from "@tinycloud/sdk-core";

import { buildPermissionRequestArtifact } from "./artifacts.js";

// TC-3284: operation identity lowercases the owner in an encryption path, but the owner signs a secret's own key only
// with the owner in EIP-55 form (sdk-core `expandDelegationPermissionEntries`; OpenKey's delegate-session check). A
// request an agent stores must name the key in the form the owner can sign, or every approval of it fails.
const ADDRESS = "0xd559CCd9EB87c530A9a349262669386dE93cf412";
const KEY = `urn:tinycloud:encryption:did:pkh:eip155:1:${ADDRESS}:default/secrets/api_key`;
const LOWERCASE_KEY = `urn:tinycloud:encryption:did:pkh:eip155:1:${ADDRESS.toLowerCase()}:default/secrets/api_key`;
const decrypt = (path: string): PermissionEntry => ({
  service: "tinycloud.encryption",
  path,
  actions: ["tinycloud.encryption/decrypt"],
});

function storedRequest(required: PermissionEntry[]) {
  return buildPermissionRequestArtifact({
    profile: "agent",
    posture: "delegate-session",
    operatorType: "agent",
    host: "https://node.tinycloud.test",
    sessionDid: "did:key:z6MkAgent",
    ownerDid: `did:pkh:eip155:1:${ADDRESS}`,
    missing: required,
    now: () => new Date("2026-07-01T00:00:00.000Z"),
    createRequestId: () => "req_test",
  });
}

describe("a stored request for a secret's own key", () => {
  test("names the owner in EIP-55 form even when the operation planned it lowercase, and the owner can sign it", () => {
    const request = storedRequest([decrypt(LOWERCASE_KEY)]);

    expect(request.requested).toEqual([decrypt(KEY)]);
    expect(expandDelegationPermissionEntries(request.requested).map((entry) => entry.path)).toEqual([KEY]);
  });

  test("stays byte-identical when the owner was already in EIP-55 form", () => {
    const request = storedRequest([decrypt(KEY)]);

    expect(JSON.stringify(request.requested)).toBe(JSON.stringify([decrypt(KEY)]));
  });
});
