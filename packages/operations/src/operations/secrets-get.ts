import { z } from "zod";
import type { SecretReadResult } from "@tinycloud/node-sdk";
import { secretNamedKeyPath } from "@tinycloud/sdk-core";
import { formatKeyResource, parseEncryptionResource } from "@tinycloud/sdk-services/encryption/resource";

import { CLI_NAME } from "../cli-name.js";
import {
  type OperationContext,
  type CapabilityRequirement,
  type OperationDefinition,
  type OperationExecutionOutcome,
  type OperationExposure,
  type OperationSensitivity,
  type RuntimeOperationContext,
  type TinyCloudPosture,
} from "../contract.js";
import { OperationInvocationError, operationError, routingOperationError } from "../errors.js";
import { missingSecretRecovery, ownerOfSpace } from "../secret-request.js";
import {
  normalizeSecretsGetInput,
  operationSpaceResolver,
  resolveSecretReference,
  resolveSecretReferenceForOperation,
  type SecretReference,
  type SecretsGetInput,
} from "../secrets.js";

const NODE_NOT_RESPONDING_MESSAGE =
  "Your storage server isn't responding. Try again in a minute.";

interface SecretsGetOutput {
  readonly value: string;
}

const SecretsGetInputSchema: z.ZodType<SecretsGetInput> = z.object({
  name: z.string(),
  scope: z.string().optional(),
  space: z.string().optional(),
  isolated: z.boolean().optional().describe("Read a secret that has its own encryption key"),
}).strict().superRefine((input, context) => {
  try {
    resolveSecretReference(input);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid secret reference." });
  }
}).transform(normalizeSecretsGetInput);

const SecretsGetOutputSchema: z.ZodType<SecretsGetOutput> = z.object({
  value: z.string(),
}).strict();

const SECRETS_GET_POSTURES: readonly TinyCloudPosture[] = [
  "owner-openkey",
  "delegate-session",
  "local-owner-key",
];

const SECRETS_GET_EXPOSURE: OperationExposure = {
  cli: { status: "required" },
  mcp: { status: "required" },
  skill: { status: "required" },
  docs: { status: "required" },
};

const SECRETS_GET_SENSITIVITY: OperationSensitivity = {
  input: [],
  output: ["/value"],
};

export const secretsGetOperationDefinition: OperationDefinition<SecretsGetInput, SecretsGetOutput> = {
  id: "tinycloud.secrets.get",
  version: 1,
  title: "Get a TinyCloud secret",
  description: "Read and decrypt one secret from the selected TinyCloud secrets space.",
  input: SecretsGetInputSchema,
  output: SecretsGetOutputSchema,
  effects: ["read", "local_write"],
  runtime: "authenticated",
  postures: SECRETS_GET_POSTURES,
  exposure: SECRETS_GET_EXPOSURE,
  sensitivity: SECRETS_GET_SENSITIVITY,
  authority: planSecretGet,
  execute: executeSecretGet,
};

export const secretsGetOperationDefinitions: readonly [typeof secretsGetOperationDefinition] = [
  secretsGetOperationDefinition,
];

async function planSecretGet(
  context: RuntimeOperationContext,
  input: SecretsGetInput,
): Promise<readonly CapabilityRequirement[]> {
  const reference = resolveSecretReferenceForOperation(
    input,
    context.runtime.node,
    context.summary.space,
  );
  let networkSpace = reference.space;
  if (input.space === undefined && reference.isolated !== true) {
    try {
      networkSpace = operationSpaceResolver(
        context.runtime.node,
        context.summary.space,
      )("secrets");
    } catch {
      // Definition-focused callers may omit authenticated identity metadata;
      // the runtime path supplies the owner space before production planning.
    }
  }
  const resource = reference.isolated === true
    ? resolveIsolatedKeyResource(context.runtime.node, reference)
    : resolveEncryptionNetworkId(context.runtime.node, networkSpace);

  return [
    {
      service: "tinycloud.kv",
      space: reference.space,
      path: reference.permissionPath,
      actions: ["tinycloud.kv/get"],
    },
    {
      service: "tinycloud.encryption",
      path: resource,
      actions: ["tinycloud.encryption/decrypt"],
    },
  ];
}

async function executeSecretGet(
  context: OperationContext,
  input: SecretsGetInput,
): Promise<OperationExecutionOutcome<SecretsGetOutput>> {
  const reference = resolveSecretReferenceForOperation(
    input,
    context.runtime?.node,
    context.summary.space,
  );
  const node = context.runtime?.node as SecretReadingNode | undefined;
  if (node === undefined || typeof node.readSecret !== "function") {
    return {
      status: "error",
      error: operationError(
        "NODE_ERROR",
        "The TinyCloud node could not read the secret.",
        { retryable: true },
      ),
    };
  }

  let result: SecretReadResult;
  try {
    result = await node.readSecret({
      space: reference.space,
      name: reference.name,
      ...(reference.scope === undefined ? {} : { scope: reference.scope }),
      ...(reference.isolated === true ? { isolated: true } : {}),
    });
  } catch (error) {
    return {
      status: "error",
      error: routingOperationError(error) ?? operationError(
        "NODE_ERROR",
        "The TinyCloud node could not read the secret.",
        { retryable: true },
      ),
    };
  }

  return classifySecretRead(reference, result, context.runtime?.localOwner === true);
}

function classifySecretRead(
  reference: SecretReference,
  result: SecretReadResult,
  localOwner: boolean,
): OperationExecutionOutcome<SecretsGetOutput> {
  switch (result.status) {
    case "ok":
      return { status: "ok", output: { value: result.value } };
    case "not_found":
      if (reference.isolated === true) {
        return { status: "error", error: operationError("KV_NOT_FOUND", "The isolated secret is not set.") };
      }
      return missingSecretOutcome(reference, localOwner);
    case "permission_required":
      if (reference.isolated === true) {
        return { status: "error", error: operationError("PERMISSION_DENIED", "Permission denied while reading the isolated secret.") };
      }
      return {
        status: "authority_required",
        missing: [result.hint as unknown as CapabilityRequirement],
        request: { requestId: "runtime-hint" },
        approval: {
          kind: "openkey",
          requestId: "runtime-hint",
          fallback: `${CLI_NAME} auth grant <request-artifact>`,
        },
      };
    case "node_unreachable":
      return {
        status: "error",
        error: operationError(
          "NODE_NOT_RESPONDING",
          NODE_NOT_RESPONDING_MESSAGE,
          { retryable: true },
        ),
      };
    case "read_failed":
    case "corrupt_envelope":
      return {
        status: "error",
        error: operationError(
          "SECRET_READ_FAILED",
          "The secret ciphertext could not be read.",
        ),
      };
    case "decrypt_failed":
    case "invalid_payload":
      return {
        status: "error",
        error: operationError(
          "SECRET_DECRYPT_FAILED",
          "The secret could not be decrypted.",
        ),
      };
  }

  return {
    status: "error",
    error: operationError("SECRET_READ_FAILED", "The secret read failed."),
  };
}

/**
 * A missing secret: a `/request` link for the owner of the secret's space, or,
 * for a local identity or a secret no link can express, `KV_NOT_FOUND` with
 * the value-free recovery kind.
 */
function missingSecretOutcome(
  reference: SecretReference,
  localOwner: boolean,
): OperationExecutionOutcome<SecretsGetOutput> {
  const owner = ownerOfSpace(reference.space);
  const recovery = missingSecretRecovery({
    owner,
    local: localOwner,
    names: [reference.name],
    ...(reference.scope === undefined ? {} : { scope: reference.scope }),
  });
  if (recovery.kind === "add_secret") {
    const { setup } = recovery;
    return {
      status: "setup_required",
      setup: {
        kind: "secret_manager",
        action: setup.action,
        url: setup.url,
        names: setup.names,
        ...(setup.scope === undefined ? {} : { scope: setup.scope }),
        owner: setup.owner,
        secret: {
          name: reference.name,
          ...(reference.scope === undefined ? {} : { scope: reference.scope }),
          space: reference.space,
        },
        message: "Ask the owner to add this secret in Secret Manager, then retry the operation.",
      },
      requiresCallerInput: true,
    };
  }
  return {
    status: "error",
    error: operationError("KV_NOT_FOUND", recovery.hint, {
      details: {
        names: [reference.name],
        ...(reference.scope === undefined ? {} : { scope: reference.scope }),
        ...(owner === undefined ? {} : { owner }),
        recoveryKind: recovery.kind,
      },
    }),
  };
}

function resolveIsolatedKeyResource(node: unknown, reference: SecretReference): string {
  const candidate = node as Pick<SecretReadingNode, "getEncryptionNetworkIdForSpace">;
  try {
    const networkId = candidate.getEncryptionNetworkIdForSpace?.(reference.space);
    const keyPath = secretNamedKeyPath(reference.space, reference.vaultKey);
    if (typeof networkId === "string" && keyPath !== undefined) {
      const network = parseEncryptionResource(networkId);
      if (network.kind === "network") return formatKeyResource(network.networkId, keyPath);
    }
  } catch {
    // Isolated reads must use the target space's network, not a default fallback.
  }
  throw unresolvedEncryptionNetwork();
}

function resolveEncryptionNetworkId(node: unknown, space: string): string {
  const candidate = node as {
    getEncryptionNetworkIdForSpace?: (spaceId: string) => unknown;
    getDefaultEncryptionNetworkId?: () => unknown;
  };

  let scoped: unknown;
  try {
    scoped = candidate.getEncryptionNetworkIdForSpace?.(space);
  } catch {
    // A scoped resolver is optional and may fail for a non-primary space.
  }
  if (typeof scoped === "string" && scoped.length > 0) return scoped;

  let fallback: unknown;
  try {
    fallback = candidate.getDefaultEncryptionNetworkId?.();
  } catch {
    // Both local sources must fail before the operation reports unresolved.
  }
  if (typeof fallback === "string" && fallback.length > 0) return fallback;

  throw unresolvedEncryptionNetwork();
}

function unresolvedEncryptionNetwork(): OperationInvocationError {
  return new OperationInvocationError(
    operationError(
      "ENCRYPTION_NETWORK_UNRESOLVED",
      "The encryption network for the target secrets space could not be resolved.",
    ),
  );
}

interface SecretReadingNode {
  readSecret(input: {
    space: string;
    name: string;
    scope?: string;
    isolated?: boolean;
  }): Promise<SecretReadResult>;
  getEncryptionNetworkIdForSpace?: (spaceId: string) => unknown;
  getDefaultEncryptionNetworkId?: () => unknown;
}
