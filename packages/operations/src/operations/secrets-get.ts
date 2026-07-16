import { z } from "zod";
import type { SecretReadResult } from "@tinycloud/node-sdk";

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
import { OperationInvocationError, operationError } from "../errors.js";
import {
  buildSecretSetupUrl,
  normalizeSecretsGetInput,
  resolveSecretReference,
  type SecretReference,
  type SecretsGetInput,
} from "../secrets.js";

interface SecretsGetOutput {
  readonly value: string;
}

const SecretsGetInputSchema: z.ZodType<SecretsGetInput> = z.object({
  name: z.string(),
  scope: z.string().optional(),
  space: z.string().optional(),
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
  const reference = resolveSecretReference(input);
  const networkId = resolveEncryptionNetworkId(context.runtime.node, reference.space);

  return [
    {
      service: "tinycloud.kv",
      space: reference.space,
      path: reference.permissionPath,
      actions: ["tinycloud.kv/get"],
    },
    {
      service: "tinycloud.encryption",
      path: networkId,
      actions: ["tinycloud.encryption/decrypt"],
    },
  ];
}

async function executeSecretGet(
  context: OperationContext,
  input: SecretsGetInput,
): Promise<OperationExecutionOutcome<SecretsGetOutput>> {
  const reference = resolveSecretReference(input);
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
    });
  } catch {
    return {
      status: "error",
      error: operationError(
        "NODE_ERROR",
        "The TinyCloud node could not read the secret.",
        { retryable: true },
      ),
    };
  }

  return classifySecretRead(reference, result);
}

function classifySecretRead(
  reference: SecretReference,
  result: SecretReadResult,
): OperationExecutionOutcome<SecretsGetOutput> {
  switch (result.status) {
    case "ok":
      return { status: "ok", output: { value: result.value } };
    case "not_found":
      return {
        status: "setup_required",
        setup: {
          kind: "secret_manager",
          secret: {
            name: reference.name,
            ...(reference.scope === undefined ? {} : { scope: reference.scope }),
            space: reference.space,
          },
          url: buildSecretSetupUrl(reference),
          message: "Enter this secret in Secret Manager, then retry the operation.",
        },
        requiresCallerInput: true,
      };
    case "node_unreachable":
      return {
        status: "error",
        error: operationError(
          "NODE_UNREACHABLE",
          "The TinyCloud node could not be reached.",
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

function resolveEncryptionNetworkId(node: unknown, space: string): string {
  const candidate = node as {
    getEncryptionNetworkIdForSpace?: (spaceId: string) => unknown;
    getDefaultEncryptionNetworkId?: () => unknown;
  };

  try {
    const scoped = candidate.getEncryptionNetworkIdForSpace?.(space);
    if (typeof scoped === "string" && scoped.length > 0) return scoped;
    const fallback = candidate.getDefaultEncryptionNetworkId?.();
    if (typeof fallback === "string" && fallback.length > 0) return fallback;
  } catch {
    // The operation returns a stable safe error rather than widening authority.
  }

  throw new OperationInvocationError(
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
  }): Promise<SecretReadResult>;
  getEncryptionNetworkIdForSpace?: (spaceId: string) => unknown;
  getDefaultEncryptionNetworkId?: () => unknown;
}
