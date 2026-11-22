import { z } from "zod";
import type { PermissionEntry } from "@tinycloud/sdk-core";
import type { SecretReadResult } from "@tinycloud/node-sdk";
import { secretKeyPath } from "@tinycloud/sdk-services";

import { evaluateOperationAuthority } from "../authority.js";
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
  const decrypt = planSecretDecrypt(context, input, reference);

  return [
    {
      service: "tinycloud.kv",
      space: reference.space,
      path: reference.permissionPath,
      actions: ["tinycloud.kv/get"],
    },
    decryptRequirement(decrypt.path),
  ];
}

interface SecretDecryptPlan {
  /** The owner's encryption network. */
  readonly network: string;
  /** The secret's own key; absent for a name or scope over 64 bytes, or a non-default network. */
  readonly key?: string;
  /** The one this read is planned on: `key`, or `network` for a secret without one or a network-only session. */
  readonly path: string;
}

/**
 * The decrypt a secret read needs (TC-3284): the secret's own key, so an owner is asked only for that. A session that
 * already decrypts with the whole network but not this key (a grant from before per-secret keys) reads with the
 * network, so secrets still in the older format stay readable to it.
 */
function planSecretDecrypt(
  context: OperationContext,
  input: SecretsGetInput,
  reference: SecretReference,
): SecretDecryptPlan {
  const node = context.runtime?.node;
  let networkSpace = reference.space;
  if (input.space === undefined) {
    try {
      networkSpace = operationSpaceResolver(node, context.summary.space)("secrets");
    } catch {
      // Definition-focused callers may omit authenticated identity metadata;
      // the runtime path supplies the owner space before production planning.
    }
  }
  const network = resolveEncryptionNetworkId(node, networkSpace);
  let key: string | undefined;
  if (network.endsWith(":default")) {
    try {
      key = `${network}/${secretKeyPath(reference.name, reference.scope)}`;
    } catch {
      // A name or scope over 64 bytes has no key of its own.
    }
  }
  const granted = (context.runtime?.granted ?? []) as unknown as PermissionEntry[];
  const holds = (path: string) =>
    evaluateOperationAuthority(granted, [decryptRequirement(path) as unknown as PermissionEntry]).satisfied;
  const path = key === undefined || (!holds(key) && holds(network)) ? network : key;
  return { network, ...(key === undefined ? {} : { key }), path };
}

function decryptRequirement(path: string): CapabilityRequirement {
  return {
    service: "tinycloud.encryption",
    path,
    actions: ["tinycloud.encryption/decrypt"],
  };
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

  // Resolved only for the two per-secret-key outcomes: a plain read never needs the network id here.
  const plan = (): SecretDecryptPlan | undefined => {
    try {
      return planSecretDecrypt(context, input, reference);
    } catch {
      return undefined;
    }
  };
  return classifySecretRead(reference, result, context.runtime?.localOwner === true, plan);
}

function classifySecretRead(
  reference: SecretReference,
  result: SecretReadResult,
  localOwner: boolean,
  plan: () => SecretDecryptPlan | undefined,
): OperationExecutionOutcome<SecretsGetOutput> {
  switch (result.status) {
    case "ok":
      return { status: "ok", output: { value: result.value } };
    case "not_found":
      return missingSecretOutcome(reference, localOwner);
    case "permission_required": {
      // A secret on its own key, read by a session planned on the network decrypt: that grant can never open it.
      const decrypt = plan();
      const hint = result.hint as { service?: unknown; path?: unknown };
      if (decrypt?.key !== undefined && decrypt.path === decrypt.network &&
          hint.service === "tinycloud.encryption" && typeof hint.path === "string" &&
          hint.path.toLowerCase() === decrypt.key.toLowerCase()) {
        return {
          status: "error",
          error: operationError(
            "SECRET_KEY_GRANT_REQUIRED",
            `${reference.name} has its own key, and this profile's access reads only secrets in the older format. Ask the owner to approve access to this secret.`,
            { details: secretErrorDetails(reference, decrypt.key) },
          ),
        };
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
    }
    case "legacy_envelope":
      return {
        status: "error",
        error: operationError(
          "SECRET_LEGACY_ENVELOPE",
          `${reference.name} is stored in the older format, which can be read only with access to all the owner's encrypted data. Ask the owner to run \`${CLI_NAME} secrets migrate\`, which gives it its own key.`,
          { details: secretErrorDetails(reference, plan()?.network) },
        ),
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

/** Value-free details of a per-secret-key outcome: the secret and the decrypt an owner would approve for it. */
function secretErrorDetails(reference: SecretReference, decrypt: string | undefined): Readonly<Record<string, unknown>> {
  return {
    names: [reference.name],
    ...(reference.scope === undefined ? {} : { scope: reference.scope }),
    ...(decrypt === undefined ? {} : { decrypt }),
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
