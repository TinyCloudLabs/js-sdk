import { expect, spyOn, test } from "bun:test";

import { invokeOperation } from "./invoke.js";
import { authOperationDefinitions } from "./operations/auth.js";
import { explorationOperationDefinitions } from "./operations/exploration.js";
import { secretsGetOperationDefinitions } from "./operations/secrets-get.js";
import { statusOperationDefinitions } from "./operations/status.js";
import { lookupOperation, operationDefinitionsForCatalog } from "./registry.js";
import { createAuthRuntimeFixture } from "../test-support/auth-runtime.js";

const expectedOperationIds = [
  "tinycloud.account.applications.list",
  "tinycloud.account.spaces.list",
  "tinycloud.auth.capabilities",
  "tinycloud.auth.import",
  "tinycloud.auth.request",
  "tinycloud.auth.status",
  "tinycloud.kv.delete",
  "tinycloud.kv.get",
  "tinycloud.kv.head",
  "tinycloud.kv.list",
  "tinycloud.kv.put",
  "tinycloud.secrets.get",
  "tinycloud.status.get",
] as const;

test("registry contains exactly the reviewed v1 operations", () => {
  const definitions = operationDefinitionsForCatalog();

  expect(definitions.map((definition) => definition.id).sort()).toEqual([...expectedOperationIds]);
  expect(definitions.every((definition) => definition.version === 1)).toBe(true);
  expect(new Set(definitions.map((definition) => definition.id)).size).toBe(definitions.length);
  expect([
    ...statusOperationDefinitions,
    ...authOperationDefinitions,
    ...explorationOperationDefinitions,
    ...secretsGetOperationDefinitions,
  ]).toHaveLength(13);
});

test("registry resolves each v1 operation and rejects unknown versions", () => {
  for (const operationId of expectedOperationIds) {
    expect(lookupOperation(operationId, 1)).toMatchObject({
      status: "found",
      definition: { id: operationId, version: 1 },
    });
    expect(lookupOperation(operationId, 2)).toEqual({
      status: "operation_version_unsupported",
      supportedVersions: [1],
    });
  }

  expect(lookupOperation("tinycloud.unknown.get", 1)).toEqual({
    status: "operation_not_found",
  });
});

test("real registry-keyed invocation reaches safe status and capabilities paths", async () => {
  const fixture = await createAuthRuntimeFixture();
  try {
    const status = await invokeOperation("tinycloud.status.get", 1, { profile: fixture.profile }, {});
    const authStatus = await invokeOperation("tinycloud.auth.status", 1, { profile: fixture.profile }, {});
    const capabilities = await invokeOperation(
      "tinycloud.auth.capabilities",
      1,
      { profile: fixture.profile },
      {},
    );

    expect(status).toMatchObject({ status: "ok", operation: { operationId: "tinycloud.status.get" } });
    expect(authStatus).toMatchObject({ status: "ok", operation: { operationId: "tinycloud.auth.status" } });
    expect(capabilities).toMatchObject({
      status: "ok",
      operation: { operationId: "tinycloud.auth.capabilities" },
      output: { capabilities: [] },
    });
  } finally {
    fixture.hermetic.stop();
  }
});

test("registered auth.request plans a registered operation without executing its handler", async () => {
  const fixture = await createAuthRuntimeFixture();
  const target = authOperationDefinitions.find((definition) => definition.id === "tinycloud.auth.capabilities");
  if (target === undefined) throw new Error("missing registered capabilities definition");
  const execute = spyOn(target, "execute");

  try {
    const result = await invokeOperation(
      "tinycloud.auth.request",
      1,
      { profile: fixture.profile },
      {
        operationId: "tinycloud.auth.capabilities",
        operationVersion: 1,
        input: {},
      },
    );

    expect(result).toMatchObject({
      status: "ok",
      operation: { operationId: "tinycloud.auth.request", operationVersion: 1 },
      output: { missing: [] },
    });
    expect(execute).not.toHaveBeenCalled();
  } finally {
    execute.mockRestore();
    fixture.hermetic.stop();
  }
});
