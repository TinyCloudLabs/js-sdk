import { z } from "zod";
import * as nodeSdk from "@tinycloud/node-sdk";

import type {
  OperationContext,
  OperationDefinition,
  OperationExecutionOutcome,
  OperationExposure,
  OperationSensitivity,
  TinyCloudPosture,
} from "../contract.js";
import { operationError } from "../errors.js";
import { kvRefusal } from "../kv-failure.js";
import { signInRecovery } from "../recovery.js";
import {
  canonicalSecretRequestOwner,
  isValidSecretRequestScope,
  missingSecretRecovery,
  resolveSecretsOwner,
  validSecretNames,
  type SecretSetup,
} from "../secret-request.js";
import { canonicalizeSecretScope } from "../secrets.js";

export interface SecretsStatusInput {
  readonly names: readonly string[];
  readonly scope?: string;
  readonly owner?: string;
}

export interface SecretsStatusOutput {
  readonly status: "ready" | "pending" | "consent_required";
  readonly owner: string;
  readonly names: readonly string[];
  readonly scope?: string;
  readonly present: readonly string[];
  readonly pending: readonly string[];
  readonly denied: readonly string[];
  readonly setup?: SecretSetup;
  readonly hint?: string;
}

/** Each probe's own bound; the operation's response deadline is {@link SECRETS_STATUS_DEADLINE_MS}. */
const PROBE_TIMEOUT_MS = 15_000;
const SECRETS_STATUS_DEADLINE_MS = 18_000;

const SecretsStatusInputSchema: z.ZodType<SecretsStatusInput, z.ZodTypeDef, unknown> = z.object({
  names: z.array(z.string()),
  scope: z.string().optional(),
  owner: z.string().optional(),
}).strict().superRefine((input, context) => {
  try {
    validSecretNames(input.names);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["names"], message: "Invalid secret names." });
  }
  try {
    const scope = canonicalizeSecretScope(input.scope);
    if (scope !== undefined && !isValidSecretRequestScope(scope)) throw new Error("invalid scope");
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["scope"], message: "Invalid secret scope." });
  }
  if (input.owner !== undefined) {
    try {
      canonicalSecretRequestOwner(input.owner);
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["owner"], message: "Invalid owner." });
    }
  }
}).transform((input): SecretsStatusInput => {
  const scope = canonicalizeSecretScope(input.scope);
  return {
    names: validSecretNames(input.names),
    ...(scope === undefined ? {} : { scope }),
    ...(input.owner === undefined ? {} : { owner: canonicalSecretRequestOwner(input.owner) }),
  };
});

const SecretSetupSchema = z.object({
  url: z.string().url(),
  names: z.array(z.string()).min(1),
  scope: z.string().optional(),
  owner: z.string(),
  action: z.literal("add_secret"),
}).strict();

const SecretsStatusOutputSchema: z.ZodType<SecretsStatusOutput> = z.object({
  status: z.enum(["ready", "pending", "consent_required"]),
  owner: z.string(),
  names: z.array(z.string()).min(1),
  scope: z.string().optional(),
  present: z.array(z.string()),
  pending: z.array(z.string()),
  denied: z.array(z.string()),
  setup: SecretSetupSchema.optional(),
  hint: z.string().optional(),
}).strict();

const SECRETS_STATUS_POSTURES: readonly TinyCloudPosture[] = [
  "owner-openkey",
  "delegate-session",
  "local-owner-key",
];

const SECRETS_STATUS_EXPOSURE: OperationExposure = {
  cli: { status: "required" },
  mcp: { status: "required" },
  skill: { status: "required" },
  docs: { status: "required" },
};

const SECRETS_STATUS_SENSITIVITY: OperationSensitivity = {
  input: [],
  output: [],
};

export const secretsStatusOperationDefinition: OperationDefinition<SecretsStatusInput, SecretsStatusOutput> = {
  id: "tinycloud.secrets.status",
  version: 1,
  title: "Check whether TinyCloud secrets exist",
  description:
    "Report, without reading any value, which named secrets exist in the owner's secrets space: ready, pending (with a Secret Manager request link), or consent_required for names this identity may not read. Each name needs tinycloud.kv/get; this operation never requests it. It never signs in: it uses only the profile's stored session, and writes no profile state.",
  input: SecretsStatusInputSchema as z.ZodType<SecretsStatusInput>,
  output: SecretsStatusOutputSchema,
  effects: ["read"],
  runtime: "restored",
  postures: SECRETS_STATUS_POSTURES,
  exposure: SECRETS_STATUS_EXPOSURE,
  sensitivity: SECRETS_STATUS_SENSITIVITY,
  deadlineMs: SECRETS_STATUS_DEADLINE_MS,
  // Never evaluated against the session: a missing grant is reported as
  // `consent_required`, never saved as an authority request.
  authority: async () => [],
  execute: executeSecretsStatus,
};

export const secretsStatusOperationDefinitions: readonly [typeof secretsStatusOperationDefinition] = [
  secretsStatusOperationDefinition,
];

type ProbeOutcome = "present" | "pending" | "auth_required" | "denied" | "unreachable";

interface StatusKvNode {
  kvForSpace(spaceId: string): {
    get(key: string, options: { raw: true; prefix: ""; timeout: number }): Promise<{ ok: boolean; error?: unknown }>;
  };
}

async function executeSecretsStatus(
  context: OperationContext,
  input: SecretsStatusInput,
): Promise<OperationExecutionOutcome<SecretsStatusOutput>> {
  const runtime = context.runtime;
  const node = runtime?.node as StatusKvNode | undefined;
  if (runtime === undefined || typeof node?.kvForSpace !== "function") {
    return {
      status: "error",
      error: operationError("NODE_ERROR", "The TinyCloud node could not check the secrets.", { retryable: true }),
    };
  }

  const local = runtime.localOwner === true;
  const resolution = resolveSecretsOwner({
    local,
    posture: context.summary.posture,
    ...(context.summary.ownerDid === undefined ? {} : { ownerDid: context.summary.ownerDid }),
    ...(context.summary.principalDid === undefined ? {} : { principalDid: context.summary.principalDid }),
    ...(context.summary.space === undefined ? {} : { space: context.summary.space }),
  }, input.owner);
  if (!resolution.ok) {
    return {
      status: "error",
      error: operationError("INPUT_INVALID", resolution.message, { details: { reason: resolution.code } }),
    };
  }
  const owner = resolution.owner;
  const skipped = runtime.skippedGrantReasons ?? [];

  // The node authorizes the EIP-55 space id; a lowercased address fails the
  // KV capability match, so a capability 401 would look like a plain 401.
  const pkh = nodeSdk.parsePkhDid(owner)!;
  const kv = node.kvForSpace(nodeSdk.makePkhSpaceId(pkh.address, pkh.chainId, "secrets"));
  const outcomes = await Promise.all(input.names.map(async (name): Promise<ProbeOutcome> => {
    const path = input.scope === undefined
      ? `vault/secrets/${name}`
      : `vault/secrets/scoped/${input.scope}/${name}`;
    try {
      const result = await kv.get(path, { raw: true, prefix: "", timeout: PROBE_TIMEOUT_MS });
      if (result.ok) return "present";
      const error = result.error;
      if (typeof error === "object" && error !== null && "code" in error && error.code === "KV_NOT_FOUND") {
        return "pending";
      }
      const refusal = kvRefusal(error);
      if (refusal === "auth_required") return "auth_required";
      if (refusal === "permission_denied") return "denied";
      return "unreachable";
    } catch {
      return "unreachable";
    }
  }));

  const namesWith = (outcome: ProbeOutcome): string[] =>
    input.names.filter((_, index) => outcomes[index] === outcome);
  const present = namesWith("present");
  const pending = namesWith("pending");
  const denied = namesWith("denied");

  // (a) Every probe answered: skipped stored grants made no difference.
  if (present.length + pending.length < input.names.length) {
    // (b) A plain 401 means the session itself is not accepted.
    if (outcomes.includes("auth_required") || skipped.includes("activation_unauthenticated")) {
      return {
        status: "error",
        error: operationError(
          "AUTH_REQUIRED",
          "The node did not accept this profile's stored session. Sign in again, then retry.",
          { retryable: false, details: { recovery: signInRecovery(context.summary.profile, context.summary.posture) } },
        ),
      };
    }
    // (c) An outage: a refusal now may be a grant that could not activate.
    if (outcomes.includes("unreachable") || skipped.includes("activation_unavailable")) {
      return {
        status: "error",
        error: operationError("NODE_UNREACHABLE", "The TinyCloud node could not be reached.", { retryable: true }),
      };
    }
  }

  // (d) Only the node's own refusals remain.
  const recovery = pending.length === 0
    ? undefined
    : missingSecretRecovery({
      owner,
      local,
      names: pending,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
    });
  return {
    status: "ok",
    output: {
      status: denied.length > 0 ? "consent_required" : pending.length > 0 ? "pending" : "ready",
      owner,
      names: [...input.names],
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      present,
      pending,
      denied,
      ...(recovery === undefined
        ? {}
        : recovery.kind === "add_secret"
        ? { setup: recovery.setup }
        : { hint: recovery.hint }),
    },
  };
}
