import { expect, test } from "bun:test";
import { CaveatedDelegationUnsupportedError as SdkCoreError } from "@tinycloud/sdk-core";
import { parsePermissionHint } from "@tinycloud/sdk-services";

import { CaveatedDelegationUnsupportedError as CoreError } from "./core";
import { TinyCloudNode as CoreTinyCloudNode } from "./core";
import {
  CaveatedDelegationUnsupportedError as RootError,
  TinyCloudNode as RootTinyCloudNode,
  type SecretPermissionHint,
  type SecretReadResult,
} from "./index";

test("exports CaveatedDelegationUnsupportedError from node root and core", () => {
  expect(RootError).toBe(SdkCoreError);
  expect(CoreError).toBe(SdkCoreError);
});

test("exposes the validated secret permission-hint API", () => {
  const hint: SecretPermissionHint = {
    service: "tinycloud.kv",
    space: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000002:secrets",
    path: "vault/secrets/API_KEY",
    actions: ["tinycloud.kv/get"],
  };
  const result: SecretReadResult = { status: "permission_required", hint };
  expect(parsePermissionHint(hint)).toEqual(hint);
  expect(result.status).toBe("permission_required");
});

test("exposes the effective runtime capability contract from root and core", () => {
  expect(RootTinyCloudNode.prototype.getEffectiveRuntimePermissionEntries).toBe(
    CoreTinyCloudNode.prototype.getEffectiveRuntimePermissionEntries,
  );
  expect(typeof RootTinyCloudNode.prototype.getEffectiveRuntimePermissionEntries).toBe("function");
});
