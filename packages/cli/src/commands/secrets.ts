import { Command } from "commander";
import { CLI_NAME } from "@tinycloud/operations/cli-name";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { constants as osConstants, homedir, hostname, userInfo } from "node:os";
import {
  type PermissionEntry,
  type PortableDelegation,
  type TinyCloudNode,
} from "@tinycloud/node-sdk";
import { appSecretScope } from "@tinycloud/sdk-core";
import { invokeOperation } from "@tinycloud/operations";
import { isLocalOwnerProfile, ownerSessionLacksProof } from "@tinycloud/operations/profile";
import {
  buildSecretManagerUrl,
  buildSecretRequestUrl,
  canonicalSecretRequestOwner,
  isValidSecretRequestScope,
  missingSecretRecovery,
  ownerOfSpace,
  resolveSecretsOwner,
  SecretRequestInputError,
  type SecretRequestLink,
  validSecretNames,
} from "@tinycloud/operations/secret-request";
import {
  SECRET_DECRYPT_CAPABILITY,
  secretCapabilityAction,
} from "@tinycloud/operations/secret-capabilities";
import { invokeSecretsGetWithLocalAuthorityRetry } from "@tinycloud/operations/cli-runtime";
import { ProfileManager } from "../config/profiles.js";
import {
  formatCheck,
  formatSection,
  operationWarnings,
  outputJson,
  outputWarnings,
  shouldOutputJson,
  withSpinner,
} from "../output/formatter.js";
import { theme } from "../output/theme.js";
import { handleError, CLIError, cliErrorFromService, wrapError } from "../output/errors.js";
import { mergeWarnings } from "../output/warnings.js";
import { ExitCode } from "../config/constants.js";
import { validatePrivateOutput, writePrivateOutput } from "../lib/private-output.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { closeReplication } from "../lib/replication-registry.js";
import { sessionExpiredError, withSignInHint } from "../auth/session-expired.js";
import { sessionExpiresAt } from "../auth/scoped-login.js";
import { resolveSpaceUri } from "../lib/space.js";
import { tryOpenBrowser, warnBrowserNotOpened } from "../lib/browser.js";
import { runProbeChild, type ProbeRequest } from "../lib/probe-child.js";
import { runCommand, type CommandOutcome } from "../lib/run-command.js";
import { safeInline } from "../output/safe-text.js";
import { abortableSleep, DEFAULT_WAIT_TIMEOUT, parseWaitTimeout, runSecretsWait } from "../lib/secrets-wait.js";
import { resolveProfilePosture, type CLIContext, type ProfileConfig } from "../config/types.js";
import {
  ensureDelegationAuthority,
  refreshOpenKeySession,
  type OpenKeyAcquisition,
} from "./auth.js";

// Mirrors `SECRETS_SPACE` in the secret-manager web app's tinycloud-manifest.ts.
// Secrets always live in the literal "secrets" space regardless of the active
// profile's default space; pass `--space` to target another secrets space.
const SECRETS_SPACE = "secrets";
type SecretAction = "get" | "put" | "del" | "list";
type SecretKvAbility =
  | ReturnType<typeof secretCapabilityAction>;
const SECRET_KV_ABILITIES: Record<SecretAction, SecretKvAbility> = {
  get: secretCapabilityAction("get"),
  put: secretCapabilityAction("put"),
  del: secretCapabilityAction("del"),
  list: secretCapabilityAction("list"),
};
type SecretResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; service?: string } };

export type CanonicalSecretGetResult = Awaited<ReturnType<typeof invokeOperation>>;

interface SecretScopeOptions {
  scope?: string;
  source?: "network";
}

interface DelegationCandidate {
  delegation: PortableDelegation;
  permissions: PermissionEntry[];
}

interface ResolvedDelegatedSecretSource extends DelegationCandidate {
  source: string;
}

type SecretDoctorCheck = {
  name: string;
  ok: boolean | "warn";
  detail?: string;
  hint?: string;
};

interface SecretDoctorResult {
  healthy: boolean;
  network: {
    name: string;
    networkId: string;
    exists: boolean;
    state?: string;
  };
  secret?: {
    name: string;
    path: string;
    scope?: string;
    exists: boolean;
    readable: boolean;
  };
  checks: SecretDoctorCheck[];
}

/**
 * Read all data from stdin.
 */
async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function authOptions(options: { privateKey?: string }): { privateKey?: string } | undefined {
  const privateKey = options.privateKey || process.env.TC_PRIVATE_KEY;
  return privateKey ? { privateKey } : undefined;
}

/**
 * D4: a local identity stores its own secrets and never gets a `/request`
 * link. Local means the shared profile predicate (local posture or auth
 * method, or a stored `privateKey`), or an explicit `--private-key` /
 * `TC_PRIVATE_KEY`.
 */
function effectiveLocal(profile: ProfileConfig | null, options: { privateKey?: string }): boolean {
  return (profile !== null && isLocalOwnerProfile(profile)) || authOptions(options) !== undefined;
}

/** A builder input error is a usage error (exit 2) under its own code. */
function secretRequestUsageError(error: unknown): unknown {
  return error instanceof SecretRequestInputError
    ? new CLIError(error.code, error.message, ExitCode.USAGE_ERROR)
    : error;
}

/**
 * The canonical scope of `--scope S` (CLI canonicalizer) or `--app ID`
 * (`appSecretScope`); both together is a usage error.
 */
function requestedSecretScope(options: { scope?: string; app?: string }): string | undefined {
  if (options.scope !== undefined && options.app !== undefined) {
    throw new CLIError("USAGE_ERROR", "Pass either --scope or --app, not both.", ExitCode.USAGE_ERROR);
  }
  if (options.app === undefined) return canonicalizeSecretScope(options.scope);
  try {
    return appSecretScope(options.app);
  } catch (error) {
    throw new CLIError("INVALID_SECRET_SCOPE", error instanceof Error ? error.message : String(error), ExitCode.USAGE_ERROR);
  }
}

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

/** `${user}@${short host}`, or none when the machine's names don't fit the link grammar. */
function defaultRequester(): string | undefined {
  try {
    const requester = `${userInfo().username}@${hostname().split(".")[0]}`;
    return requester.length <= 64 && !CONTROL_OR_FORMAT.test(requester) ? requester : undefined;
  } catch {
    return undefined;
  }
}

function resolveSecretScope(options: { scope?: string }): { scope?: string } | undefined {
  return options.scope ? { scope: options.scope } : undefined;
}

async function resolveSecretSpace(
  input: string | undefined,
  profileName: string,
): Promise<string | undefined> {
  return resolveSpaceUri(input, profileName, { useProfileDefault: false });
}

function secretsServiceForSpace(
  node: TinyCloudNode,
  spaceUri: string | undefined,
) {
  return spaceUri ? node.secretsForSpace(spaceUri) : node.secrets;
}

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const RESERVED_SECRET_SCOPES = new Set(["default", "global"]);

function canonicalizeSecretScope(scope: string | undefined): string | undefined {
  if (scope === undefined) return undefined;

  const trimmed = scope.trim();
  if (trimmed === "") {
    throw new CLIError(
      "INVALID_SECRET_SCOPE",
      "Secret scope must be non-empty; omit scope for global secrets.",
      ExitCode.USAGE_ERROR,
    );
  }

  const canonical = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (canonical === "") {
    throw new CLIError(
      "INVALID_SECRET_SCOPE",
      "Secret scope must contain at least one letter or number.",
      ExitCode.USAGE_ERROR,
    );
  }

  if (RESERVED_SECRET_SCOPES.has(canonical)) {
    throw new CLIError(
      "INVALID_SECRET_SCOPE",
      `Secret scope ${JSON.stringify(scope)} is reserved; omit scope for global secrets.`,
      ExitCode.USAGE_ERROR,
    );
  }

  return canonical;
}

// Mirrors `resolveSecretPath()` in @tinycloud/sdk-services/src/secrets/paths.ts.
// The `vault/` prefix is the wire-level KV path that DataVaultService writes
// to (see DataVaultService.put), and is what `tinycloud.vault` permissions
// expand to via vaultActionExpansion() in sdk-core/src/manifest.ts. Keep this
// helper in sync with the SDK's `permissionPaths.vault` shape.
function resolveSecretPath(
  name: string,
  options: SecretScopeOptions = {},
): { name: string; scope?: string; vaultKey: string; permissionPaths: { vault: string } } {
  const normalizedName = name.trim();
  if (!SECRET_NAME_RE.test(normalizedName)) {
    throw new CLIError(
      "INVALID_SECRET_NAME",
      `Invalid secret name ${JSON.stringify(name)}. Secret names must match ${SECRET_NAME_RE.source}.`,
      ExitCode.USAGE_ERROR,
    );
  }

  const scope = canonicalizeSecretScope(options.scope);
  const vaultKey = scope === undefined
    ? `secrets/${normalizedName}`
    : `secrets/scoped/${scope}/${normalizedName}`;

  return {
    name: normalizedName,
    ...(scope !== undefined ? { scope } : {}),
    vaultKey,
    permissionPaths: {
      vault: `vault/${vaultKey}`,
    },
  };
}

function resolveSecretListPrefix(options: SecretScopeOptions = {}): string {
  const scope = canonicalizeSecretScope(options.scope);
  return scope === undefined
    ? "vault/secrets/"
    : `vault/secrets/scoped/${scope}/`;
}

function resolveProfilesDir(): string {
  const home = process.env.TC_HOME ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return join(home, ".tinycloud", "profiles");
}

async function ensureSecretsNode(
  ctx: CLIContext,
  options: { privateKey?: string },
  openKeyAcquisition?: OpenKeyAcquisition,
  selectedProfile?: ProfileConfig,
): Promise<TinyCloudNode> {
  const auth = authOptions(options);
  if (auth?.privateKey) {
    return ensureAuthenticated(ctx, auth);
  }

  const profile = selectedProfile ?? await ProfileManager.getProfile(ctx.profile).catch(() => null);
  if (profile?.authMethod === "openkey" && canRequestOwnerPermissions(profile)) {
    const session = await ProfileManager.getSession(ctx.profile);
    if (!session || isStoredSessionExpired(session) || ownerSessionLacksProof(session, profile)) {
      if (!process.stdin.isTTY && !process.stderr.isTTY) {
        throw new CLIError(
          "AUTH_REQUIRED",
          `Profile "${ctx.profile}" has ${session ? "an expired or unverified" : "no"} OpenKey session; headless secret access cannot open a browser login.`,
          ExitCode.AUTH_REQUIRED,
          { hint: scopedSecretLoginHint(ctx.profile) },
        );
      }
      // The refresh replaces the refused session; it targets the node discovery picks.
      const { completeDeferredLocalDiscovery } = await import("../lib/host.js");
      await completeDeferredLocalDiscovery(ctx);
      await withSpinner(
        session ? "Refreshing TinyCloud session..." : "Creating TinyCloud session...",
        () => refreshOpenKeySession(ctx.profile, ctx.host, { openKeyAcquisition }),
      );
    }
  }

  return ensureAuthenticated(ctx, auth);
}

async function runSecretOperation<T>(params: {
  ctx: CLIContext;
  node: TinyCloudNode;
  action: SecretAction;
  name?: string;
  scopeOptions?: SecretScopeOptions;
  space?: string;
  label: string;
  operation: () => Promise<SecretResult<T>>;
  /** Test seam for the owner OpenKey acquisition boundary. */
  openKeyAcquisition?: OpenKeyAcquisition;
}): Promise<SecretResult<T>> {
  const first = await runSecretOperationAttempt(params.label, params.operation);
  if (first.ok || !shouldRequestSecretPermissions(first.error)) {
    return first;
  }

  const profile = await ProfileManager.getProfile(params.ctx.profile);
  if (!canRequestOwnerPermissions(profile)) {
    return first;
  }
  assertOwnerApprovalPossible(params.ctx.profile, profile, params.action, params.name);

  const requested = secretPermissionEntries({
    action: params.action,
    name: params.name,
    options: params.scopeOptions,
    space: params.space,
    node: params.node,
  });
  await withSpinner("Requesting secret permissions...", () =>
    ensureDelegationAuthority({
      ctx: params.ctx,
      profile,
      node: params.node,
      requested,
      expiryOption: undefined,
      reason: secretPermissionReason(params.action, params.name),
      yes: true,
      force: true,
      anchorSpace: params.space ?? SECRETS_SPACE,
      openKeyAcquisition: params.openKeyAcquisition,
    }),
  );

  return runSecretOperationAttempt(params.label, params.operation);
}

function secretPermissionReason(action: SecretAction, name?: string): string {
  const target = name ? ` secret "${name}"` : " secrets";
  return `Allow \`${CLI_NAME} secrets ${action}${name ? ` ${name}` : ""}\` to access${target} with the required TinyCloud permissions.`;
}

/** Browser approval is possible when the person can see stderr or answer on stdin. */
function assertOwnerApprovalPossible(profileName: string, profile: ProfileConfig, action: SecretAction, name?: string, missing: readonly Readonly<Record<string, unknown>>[] = []): void {
  if (profile.authMethod !== "openkey" || process.stdin.isTTY || process.stderr.isTTY) return;
  const command = `${CLI_NAME} secrets ${action === "del" ? "delete" : action}${name ? ` ${name}` : ""}`;
  throw new CLIError(
    "PERMISSION_DENIED",
    action === "get"
      ? missing.length > 0 && missing.every((permission) =>
          permission.service === "tinycloud.encryption" &&
          Array.isArray(permission.actions) &&
          permission.actions.length > 0 &&
          permission.actions.every((capability: string) => capability === SECRET_DECRYPT_CAPABILITY))
        ? `Profile "${profileName}" lacks the scoped decrypt authority (${SECRET_DECRYPT_CAPABILITY}) needed to read secret "${name}", and requesting it needs an interactive browser approval.`
        : `Profile "${profileName}" lacks a scoped read or decrypt grant needed to read secret "${name}", and requesting it needs an interactive browser approval.`
      : `Profile "${profileName}" holds no grant for \`${command}\`, and requesting one needs an interactive browser approval.`,
    ExitCode.PERMISSION_DENIED,
    {
      hint: scopedSecretLoginHint(profileName),
    },
  );
}

function scopedSecretLoginHint(profileName: string): string {
  return `Have the owner approve a scoped login whose manifest names the secret: ${CLI_NAME} --profile ${profileName} auth login --method openkey --paste --manifest <manifest.json>. Pass the owner's code on stdin, newline-terminated.`;
}


async function runSecretOperationAttempt<T>(
  label: string,
  operation: () => Promise<SecretResult<T>>,
): Promise<SecretResult<T>> {
  try {
    return await withSpinner(label, operation);
  } catch (error) {
    const permissionError = thrownPermissionError(error);
    if (permissionError) return permissionError;
    throw error;
  }
}

type CanonicalSecretGetWarning = NonNullable<CanonicalSecretGetResult["warnings"]>[number];

/**
 * Carry an operation's warnings on the CLI error that reports the failure, so
 * handleError renders them in the same envelope. Any thrown value (a browser
 * approval can throw a plain Error) is first classified as handleError would.
 */
function withOperationWarnings(error: unknown, warnings: readonly CanonicalSecretGetWarning[] | undefined): unknown {
  if (warnings === undefined || warnings.length === 0) return error;
  const cliError = wrapError(error);
  cliError.metadata = { ...cliError.metadata, warnings };
  return cliError;
}

/**
 * The canonical read, possibly after a session refresh or an approved
 * escalation. Keep the largest multiplicity of each warning across replay
 * attempts, whether the command succeeds or an approval throws.
 */
async function invokeCanonicalSecretGet(params: CanonicalSecretGetParams): Promise<CanonicalSecretGetResult> {
  let warnings: CanonicalSecretGetWarning[] = [];
  const collect = (result: CanonicalSecretGetResult): CanonicalSecretGetResult => {
    warnings = mergeWarnings(warnings, result.warnings ?? []);
    return result;
  };
  try {
    const result = await canonicalSecretGet(params, collect);
    return warnings.length === 0 ? result : { ...result, warnings };
  } catch (error) {
    throw withOperationWarnings(error, warnings);
  }
}

interface CanonicalSecretGetParams {
  ctx: CLIContext;
  node?: TinyCloudNode;
  name: string;
  scope?: string;
  space?: string;
  options: { privateKey?: string };
  label: string;
  openKeyAcquisition?: OpenKeyAcquisition;
}

async function canonicalSecretGet(
  params: CanonicalSecretGetParams,
  collect: (result: CanonicalSecretGetResult) => CanonicalSecretGetResult,
): Promise<CanonicalSecretGetResult> {
  const auth = authOptions(params.options);
  let ownerNode: TinyCloudNode | undefined;
  if (!auth?.privateKey) {
    const profile = await ProfileManager.getProfile(params.ctx.profile).catch(() => null);
    if (profile) {
      const posture = resolveProfilePosture(profile);
      const session = await ProfileManager.getSession(params.ctx.profile);
      if (posture === "delegate-session" && session && isStoredSessionExpired(session)) {
        throw sessionExpiredError(params.ctx.profile, posture);
      }
      if (profile.authMethod === "openkey" && canRequestOwnerPermissions(profile)) {
        if (!session || isStoredSessionExpired(session) || ownerSessionLacksProof(session, profile)) {
          ownerNode = await ensureSecretsNode(params.ctx, params.options, params.openKeyAcquisition, profile);
        }
      }
    }
  }
  const target = {
    profile: params.ctx.profile,
    host: params.ctx.host,
    allowOwnerProfile: true,
    ...(auth ?? {}),
  };
  const input = {
    name: params.name,
    ...(params.scope === undefined ? {} : { scope: params.scope }),
    ...(params.space === undefined ? {} : { space: params.space }),
  };

  const invoke = async () => collect(await withSpinner(
    params.label,
    () => auth?.privateKey
      ? invokeSecretsGetWithLocalAuthorityRetry(target, input)
      : invokeOperation("tinycloud.secrets.get", 1, target, input),
  ));
  let first = await invoke();
  if (first.status === "error" &&
    first.error.code === "SESSION_NOT_FOUND" &&
    auth?.privateKey === undefined) {
    const profile = await ProfileManager.getProfile(params.ctx.profile);
    if (profile.authMethod === "openkey" && canRequestOwnerPermissions(profile)) {
      ownerNode = await ensureSecretsNode(
        params.ctx,
        params.options,
        params.openKeyAcquisition,
        profile,
      );
      first = await invoke();
    }
  }
  if (first.status !== "authority_required") return first;
  // The operations-owned explicit-key path should never return an authority
  // request. Keep this guard for the legacy no-key path only.
  if (auth?.privateKey !== undefined) return first;
  if (first.context.posture !== "owner-openkey" && first.context.posture !== "local-owner-key") {
    return first;
  }

  const profile = await ProfileManager.getProfile(params.ctx.profile);
  if (!canRequestOwnerPermissions(profile)) return first;
  assertOwnerApprovalPossible(params.ctx.profile, profile, "get", params.name, first.missing);
  const node = params.node ?? ownerNode ?? await ensureSecretsNode(
    params.ctx,
    params.options,
    params.openKeyAcquisition,
  );

  await withSpinner("Requesting secret permissions...", () =>
    ensureDelegationAuthority({
      ctx: params.ctx,
      profile,
      node,
      requested: first.missing as PermissionEntry[],
      expiryOption: undefined,
      reason: secretPermissionReason("get", params.name),
      yes: true,
      force: true,
      anchorSpace: params.space ?? SECRETS_SPACE,
      openKeyAcquisition: params.openKeyAcquisition,
    }),
  );

  return invoke();
}

/** Return the canonical envelope produced by the Commander projection before rendering. */
export function invokeCommanderSecretGetAdapter(params: {
  readonly profile: string;
  readonly host?: string;
  readonly input: { readonly name: string; readonly scope?: string; readonly space?: string };
}): Promise<CanonicalSecretGetResult> {
  return invokeCanonicalSecretGet({
    ctx: {
      profile: params.profile,
      host: params.host ?? "https://node.example",
      verbose: false,
      noCache: false,
      quiet: true,
      replication: false,
      replicationDebug: false,
    },
    name: params.input.name,
    ...(params.input.scope === undefined ? {} : { scope: params.input.scope }),
    ...(params.input.space === undefined ? {} : { space: params.input.space }),
    options: {},
    label: "",
  });
}

function throwCanonicalSecretGetError(
  result: CanonicalSecretGetResult,
  name: string,
): never {
  switch (result.status) {
    case "authority_required":
      throw new CLIError(
        "PERMISSION_DENIED",
        "Permission denied while reading secret",
        ExitCode.PERMISSION_DENIED,
      );
    case "setup_required": {
      // handleError re-validates the projected setup against the builder.
      const { url, names, scope, owner, action } = result.setup;
      const message = typeof result.setup.message === "string" ? result.setup.message : `Secret "${name}" is not set.`;
      throw new CLIError(
        "NOT_FOUND",
        message,
        ExitCode.NOT_FOUND,
        {
          hint: `${String(url)}\n${message}`,
          setup: { url, names, ...(scope === undefined ? {} : { scope }), owner, action },
        },
      );
    }
    case "error":
      if (result.error.code === "SESSION_NOT_FOUND" ||
        (result.error.code === "PROFILE_POSTURE_NOT_ALLOWED" && result.context.posture === "unauthenticated")) {
        throw new CLIError(
          "AUTH_REQUIRED",
          "Not signed in to TinyCloud.",
          ExitCode.AUTH_REQUIRED,
          { hint: `Sign in with: ${CLI_NAME} --profile ${result.context.profile} auth login` },
        );
      }
      if (result.error.code === "NODE_UNREACHABLE") {
        throw new CLIError("NETWORK_ERROR", result.error.message, ExitCode.NETWORK_ERROR);
      }
      if (result.error.code === "KV_NOT_FOUND") {
        // A local identity, or a secret no link can express: the operation's
        // message is the value-free put/not-requestable hint.
        throw new CLIError("NOT_FOUND", `Secret "${name}" not found.`, ExitCode.NOT_FOUND, { hint: result.error.message });
      }
      if (result.error.code === "PERMISSION_HINT_INVALID") {
        throw new CLIError(result.error.code, result.error.message, ExitCode.PERMISSION_DENIED);
      }
      throw withSignInHint(cliErrorFromService(result.error), result.context.profile, result.context.posture);
    case "ok":
      throw new Error("Expected a failed canonical secret result.");
  }
}

function canRequestOwnerPermissions(profile: ProfileConfig): boolean {
  const posture = resolveProfilePosture(profile);
  return posture === "owner-openkey" || posture === "local-owner-key";
}

function shouldRequestSecretPermissions(error: { code: string; message: string }): boolean {
  if (error.code !== "PERMISSION_DENIED") return false;
  return /permission|session expired|autosign|capabilit/i.test(error.message);
}

function thrownPermissionError<T>(error: unknown): SecretResult<T> | null {
  const record = error as { code?: unknown; message?: unknown };
  const message = typeof record?.message === "string" ? record.message : String(error);
  const code = typeof record?.code === "string" ? record.code : "PERMISSION_DENIED";
  if (code !== "PERMISSION_DENIED" && !/permission|session expired|autosign|capabilit/i.test(message)) {
    return null;
  }

  return {
    ok: false,
    error: {
      code: "PERMISSION_DENIED",
      message,
    },
  };
}


function hasPermissionAction(actions: string[], action: string): boolean {
  return actions.some(
    (entry) =>
      entry === action ||
      entry.endsWith(`/${action.split("/").at(-1)}`) ||
      entry === action.split("/").at(-1),
  );
}

function delegationCoversPath(
  permissions: PermissionEntry[],
  path: string,
  space: string = SECRETS_SPACE,
): boolean {
  return permissions.some((permission) => {
    if (permission.service !== "tinycloud.kv") return false;
    if (!permissionTargetsSpace(permission, space)) return false;
    if (!hasPermissionAction(permission.actions, secretCapabilityAction("get"))) return false;
    return permission.path === path || (permission.path.endsWith("/") && path.startsWith(permission.path));
  });
}

function spaceMatches(granted: string, requested: string): boolean {
  return granted === requested;
}

function permissionTargetsSpace(permission: PermissionEntry, expectedSpace: string): boolean {
  if (permission.service !== "tinycloud.kv") return false;
  if (typeof permission.space !== "string") return false;
  const space = permission.space.trim();
  if (space === "") return false;
  return spaceMatches(space, expectedSpace);
}

function delegationCoversDecrypt(
  permissions: PermissionEntry[],
  networkId: string,
): boolean {
  return permissions.some((permission) => {
    if (permission.service !== "tinycloud.encryption") return false;
    if (!hasPermissionAction(permission.actions, SECRET_DECRYPT_CAPABILITY)) return false;
    return permission.path === networkId;
  });
}

function parseDelegationExpiry(expiry: unknown): Date {
  const parsed =
    expiry instanceof Date
      ? expiry
      : typeof expiry === "number"
        ? new Date(expiry)
        : new Date(String(expiry));
  if (Number.isNaN(parsed.getTime())) {
    throw new CLIError(
      "INVALID_DELEGATION_SOURCE",
      "Delegation must include a valid expiry.",
      ExitCode.USAGE_ERROR,
    );
  }
  return parsed;
}

function normalizePortableDelegation(value: unknown): PortableDelegation {
  if (value === null || typeof value !== "object") {
    throw new CLIError(
      "INVALID_DELEGATION_SOURCE",
      "Delegation source must contain a PortableDelegation object.",
      ExitCode.USAGE_ERROR,
    );
  }

  const candidate = value as Partial<PortableDelegation> & {
    expiry?: unknown;
    delegationHeader?: unknown;
  };
  const authorization = candidate.delegationHeader as { Authorization?: unknown } | undefined;
  if (
    typeof candidate.cid !== "string" ||
    typeof candidate.spaceId !== "string" ||
    typeof candidate.path !== "string" ||
    !Array.isArray(candidate.actions) ||
    typeof candidate.delegateDID !== "string" ||
    typeof candidate.ownerAddress !== "string" ||
    typeof candidate.chainId !== "number" ||
    typeof authorization !== "object" ||
    authorization === null ||
    typeof authorization.Authorization !== "string"
  ) {
    throw new CLIError(
      "INVALID_DELEGATION_SOURCE",
      "Delegation source must contain a PortableDelegation object.",
      ExitCode.USAGE_ERROR,
    );
  }

  return {
    ...candidate,
    actions: [...candidate.actions],
    expiry: parseDelegationExpiry(candidate.expiry),
    delegationHeader: { Authorization: authorization.Authorization },
  } as PortableDelegation;
}

function normalizeDelegationCandidates(
  value: unknown,
  source: string,
): DelegationCandidate[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeDelegationCandidates(entry, source));
  }

  if (value === null || typeof value !== "object") {
    throw new CLIError(
      "INVALID_DELEGATION_SOURCE",
      `Delegation source "${source}" must be a delegation file or imported profile reference.`,
      ExitCode.USAGE_ERROR,
    );
  }

  const candidate = value as Record<string, unknown> & {
    delegation?: unknown;
    permissions?: PermissionEntry[];
  };

  if (candidate.delegation !== undefined) {
    const delegation = normalizePortableDelegation(candidate.delegation);
    return [{
      delegation,
      permissions: Array.isArray(candidate.permissions) && candidate.permissions.length > 0
        ? candidate.permissions
        : permissionsFromDelegation(delegation),
    }];
  }

  const delegation = normalizePortableDelegation(candidate);
  return [{
    delegation,
    permissions: permissionsFromDelegation(delegation),
  }];
}

function permissionsFromDelegation(delegation: PortableDelegation): PermissionEntry[] {
  if (delegation.resources?.length) {
    return delegation.resources.map((resource) => ({
      service: resource.service.startsWith("tinycloud.")
        ? resource.service
        : `tinycloud.${resource.service}`,
      space: resource.space,
      path: resource.path,
      actions: [...resource.actions],
    }));
  }

  const service = delegation.actions[0]?.includes("/")
    ? delegation.actions[0].slice(0, delegation.actions[0].indexOf("/"))
    : "tinycloud.unknown";

  return [{
    service,
    space: delegation.spaceId,
    path: delegation.path,
    actions: [...delegation.actions],
  }];
}

async function loadDelegationCandidates(source: string): Promise<DelegationCandidate[]> {
  try {
    const raw = JSON.parse(await readFile(source, "utf8")) as unknown;
    return normalizeDelegationCandidates(raw, source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      if (error instanceof SyntaxError) {
        throw new CLIError(
          "INVALID_DELEGATION_SOURCE",
          `Delegation source "${source}" must be valid JSON.`,
          ExitCode.USAGE_ERROR,
        );
      }
      throw new CLIError(
        "INVALID_DELEGATION_SOURCE",
        `Delegation source "${source}" could not be read.`,
        ExitCode.USAGE_ERROR,
      );
    }
  }

  try {
    const importedPath = join(resolveProfilesDir(), source, "additional-delegations.json");
    const raw = JSON.parse(await readFile(importedPath, "utf8")) as unknown;
    return normalizeDelegationCandidates(raw, source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return [];
    }
    if (error instanceof SyntaxError) {
      throw new CLIError(
        "INVALID_DELEGATION_SOURCE",
        `Delegation source "${source}" must be valid JSON.`,
        ExitCode.USAGE_ERROR,
      );
    }
    throw new CLIError(
      "INVALID_DELEGATION_SOURCE",
      `Delegation source "${source}" could not be read.`,
      ExitCode.USAGE_ERROR,
    );
  }
}

function selectDelegationCandidate(
  candidates: DelegationCandidate[],
  source: string,
  secretPath: string,
  space: string = SECRETS_SPACE,
): DelegationCandidate {
  const liveCandidates = candidates.filter((candidate) => candidate.delegation.expiry.getTime() > Date.now());
  if (liveCandidates.length === 0) {
    throw new CLIError(
      "DELEGATION_EXPIRED",
      `Delegation source "${source}" has no live delegations.`,
      ExitCode.PERMISSION_DENIED,
    );
  }

  const secretsSpaceCandidates = liveCandidates.filter((candidate) =>
    candidate.permissions.some((permission) => permissionTargetsSpace(permission, space))
  );
  if (secretsSpaceCandidates.length === 0) {
    throw new CLIError(
      "PERMISSION_DENIED",
      `Delegation source "${source}" does not target secrets space "${space}".`,
      ExitCode.PERMISSION_DENIED,
    );
  }

  const exact = secretsSpaceCandidates.find((candidate) =>
    delegationCoversPath(candidate.permissions, secretPath, space)
  );
  if (exact) {
    return exact;
  }

  throw new CLIError(
    "PERMISSION_DENIED",
    `Delegation source "${source}" does not cover secret "${secretPath}".`,
    ExitCode.PERMISSION_DENIED,
  );
}

async function resolveDelegatedSecretSource(
  source: string,
  secretPath: string,
  space: string = SECRETS_SPACE,
): Promise<ResolvedDelegatedSecretSource> {
  const candidates = await loadDelegationCandidates(source);
  if (candidates.length === 0) {
    throw new CLIError(
      "DELEGATION_NOT_FOUND",
      `Delegation source "${source}" did not resolve to any imported delegations.`,
      ExitCode.PERMISSION_DENIED,
    );
  }

  const selected = selectDelegationCandidate(candidates, source, secretPath, space);
  return { ...selected, source };
}

function mapEncryptionResultError(error: { code: string; message: string }): CLIError {
  const code = error.code || "DECRYPTION_FAILED";
  const exitCode =
    code === "PERMISSION_DENIED" ? ExitCode.PERMISSION_DENIED :
    code === "NOT_FOUND" ? ExitCode.NOT_FOUND :
    code === "NETWORK_ERROR" || code === "TRANSPORT_ERROR" ? ExitCode.NETWORK_ERROR :
    ExitCode.ERROR;

  return new CLIError(code, error.message, exitCode);
}

function parseDecryptedSecretPayload(
  data: Uint8Array,
  secretPath: string,
): string {
  const text = new TextDecoder().decode(data);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CLIError(
      "INVALID_SECRET_PAYLOAD",
      `Delegated secret "${secretPath}" did not decrypt to valid JSON.`,
      ExitCode.ERROR,
    );
  }

  if (parsed === null || typeof parsed !== "object" || typeof (parsed as { value?: unknown }).value !== "string") {
    throw new CLIError(
      "INVALID_SECRET_PAYLOAD",
      `Delegated secret "${secretPath}" did not decrypt to { value: string }.`,
      ExitCode.ERROR,
    );
  }

  return (parsed as { value: string }).value;
}

async function readDelegatedSecretValue(params: {
  node: TinyCloudNode;
  delegation: PortableDelegation;
  delegationCid: string;
  permissions: PermissionEntry[];
  secretPath: string;
  space?: string;
  name: string;
  scope?: string;
  /** D4: computed before the node exists, from the profile and the explicit key. */
  local: boolean;
}): Promise<string> {
  if (!delegationCoversPath(params.permissions, params.secretPath, params.space ?? SECRETS_SPACE)) {
    throw new CLIError(
      "PERMISSION_DENIED",
      `Delegation "${params.delegationCid}" does not cover secret "${params.secretPath}".`,
      ExitCode.PERMISSION_DENIED,
    );
  }

  const access = await params.node.useDelegation(params.delegation);
  if (typeof access?.kv?.get !== "function") {
    throw new CLIError(
      "DELEGATION_INVALID",
      `Delegation "${params.delegationCid}" did not resolve delegated KV access.`,
      ExitCode.ERROR,
    );
  }

  const envelopeResult = await access.kv.get<unknown>(params.secretPath, {
    raw: true,
    prefix: "",
  });

  if (!envelopeResult.ok) {
    if (
      envelopeResult.error.code === "NOT_FOUND" ||
      envelopeResult.error.code === "KEY_NOT_FOUND" ||
      envelopeResult.error.code === "KV_NOT_FOUND"
    ) {
      const recovery = missingSecretRecovery({
        owner: ownerOfSpace(params.space?.startsWith("tinycloud:") ? params.space : params.delegation.spaceId),
        local: params.local,
        names: [params.name],
        ...(params.scope === undefined ? {} : { scope: params.scope }),
      });
      throw new CLIError(
        "NOT_FOUND",
        `Secret "${params.name}" not found`,
        ExitCode.NOT_FOUND,
        recovery.kind === "add_secret"
          ? { hint: `Ask the owner to add it: ${recovery.setup.url}`, setup: recovery.setup }
          : { hint: recovery.hint },
      );
    }
    // A delegation the node refuses (403, or a 401 for a capability or an
    // unauthorized vault read) does not cover the secret: exit 5 with the
    // validated capability meta.
    const classified = cliErrorFromService(envelopeResult.error);
    if (
      envelopeResult.error.code === "AUTH_UNAUTHORIZED" ||
      classified.code === "PERMISSION_DENIED" ||
      classified.code === "AUTH_REQUIRED"
    ) {
      throw new CLIError(
        "PERMISSION_DENIED",
        `Delegation "${params.delegationCid}" does not cover secret "${params.secretPath}".`,
        ExitCode.PERMISSION_DENIED,
        classified.metadata,
      );
    }
    throw new CLIError(
      envelopeResult.error.code,
      envelopeResult.error.message,
      ExitCode.ERROR,
    );
  }

  const rawEnvelope = envelopeResult.data.data;
  if (typeof rawEnvelope !== "string") {
    throw new CLIError(
      "INVALID_ENVELOPE",
      `Secret "${params.secretPath}" did not contain an encrypted envelope.`,
      ExitCode.ERROR,
    );
  }

  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(rawEnvelope) as Record<string, unknown>;
  } catch {
    throw new CLIError(
      "INVALID_ENVELOPE",
      `Secret "${params.secretPath}" did not contain an encrypted envelope.`,
      ExitCode.ERROR,
    );
  }

  const networkId = envelope.networkId;
  if (typeof networkId !== "string") {
    throw new CLIError(
      "INVALID_ENVELOPE",
      `Secret "${params.secretPath}" did not contain an encrypted envelope.`,
      ExitCode.ERROR,
    );
  }

  if (!delegationCoversDecrypt(params.permissions, networkId)) {
    throw new CLIError(
      "PERMISSION_DENIED",
      `Delegation "${params.delegationCid}" does not include ${SECRET_DECRYPT_CAPABILITY} for ${networkId}.`,
      ExitCode.PERMISSION_DENIED,
    );
  }

  const decrypted = await params.node.encryption.decryptEnvelope(
    envelope as never,
    { proofs: [params.delegationCid] },
  );
  if (!decrypted.ok) {
    throw mapEncryptionResultError(decrypted.error);
  }

  return parseDecryptedSecretPayload(decrypted.data, params.secretPath);
}

function isStoredSessionExpired(session: object): boolean {
  const record = session as Record<string, unknown>;
  const direct = parseDate(record.expiresAt ?? record.expiry ?? record.expirationTime);
  if (direct) return direct.getTime() <= Date.now();
  const signedOrSiweExpiry = sessionExpiresAt(record);
  return signedOrSiweExpiry !== null && Date.parse(signedOrSiweExpiry) <= Date.now();
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") {
    const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function secretKvAbility(action: SecretAction): SecretKvAbility {
  return SECRET_KV_ABILITIES[action];
}

function secretPermissionEntries(params: {
  action: SecretAction;
  name?: string;
  options?: SecretScopeOptions;
  space?: string;
  node: TinyCloudNode;
}): PermissionEntry[] {
  const path = params.action === "list"
    ? resolveSecretListPrefix(params.options)
    : resolveSecretPath(params.name ?? "", params.options).permissionPaths.vault;
  const permissions: PermissionEntry[] = [{
    service: "tinycloud.kv",
    space: params.space ?? SECRETS_SPACE,
    path,
    actions: [secretKvAbility(params.action)],
    skipPrefix: true,
  }];

  if (params.action === "get") {
    const networkId = "getEncryptionNetworkIdForSpace" in params.node &&
      typeof params.node.getEncryptionNetworkIdForSpace === "function"
      ? params.node.getEncryptionNetworkIdForSpace(params.space ?? SECRETS_SPACE)
      : params.node.getDefaultEncryptionNetworkId();
    permissions.push({
      service: "tinycloud.encryption",
      path: networkId,
      actions: [SECRET_DECRYPT_CAPABILITY],
      skipPrefix: true,
    });
  }

  return permissions;
}

function formatSecretScopeFlag(options: SecretScopeOptions | undefined): string {
  return options?.scope ? ` --scope ${JSON.stringify(options.scope)}` : "";
}

function outputSecretDoctor(result: SecretDoctorResult): void {
  if (shouldOutputJson()) {
    outputJson(result);
    return;
  }

  process.stderr.write(formatSection("Secrets") + "\n");
  for (const check of result.checks) {
    process.stdout.write(formatCheck(check.ok, check.name, check.detail) + "\n");
    if (check.hint) {
      process.stdout.write(`  ${theme.hint(check.hint)}\n`);
    }
  }
  process.stdout.write("\n");
  if (result.healthy) {
    process.stdout.write(theme.success("Secrets checks passed.") + "\n");
  } else {
    const failed = result.checks.filter((check) => check.ok === false).length;
    process.stdout.write(theme.warn(`${failed} secrets check${failed > 1 ? "s" : ""} need attention.`) + "\n");
  }
}

/** What `secrets get` and `secrets run` take to select and read a secret. */
interface SecretReadOptions {
  scope?: string;
  space?: string;
  delegation?: string;
  privateKey?: string;
}

/** One secret to read, checked before anything is read. */
interface SecretReadTarget {
  name: string;
  scopeOptions?: { scope?: string };
  scope?: string;
  legacySpaceUri?: string;
  secretPath: string;
}

async function resolveSecretReadTarget(
  ctx: CLIContext,
  name: string,
  options: SecretReadOptions,
): Promise<SecretReadTarget> {
  const scopeOptions = resolveSecretScope(options);
  const legacySpaceUri = await resolveSecretSpace(options.space, ctx.profile);
  const resolved = resolveSecretPath(name, scopeOptions);
  return { name, scopeOptions, scope: resolved.scope, legacySpaceUri, secretPath: resolved.permissionPaths.vault };
}

/**
 * Read one secret as `tc secrets get` does. A failure throws the CLI error
 * `get` reports for it; a canonical read returns its warnings with the value.
 */
async function readSecret(params: {
  ctx: CLIContext;
  /** `--host` from the command line; it wins over a delegation's host. */
  host?: string;
  target: SecretReadTarget;
  options: SecretReadOptions;
  openKeyAcquisition?: OpenKeyAcquisition;
}): Promise<{ value: string; warnings?: CanonicalSecretGetResult["warnings"] }> {
  const { ctx, target, options } = params;
  const { name } = target;
  if (options.delegation) {
    const delegated = await resolveDelegatedSecretSource(
      options.delegation,
      target.secretPath,
      target.legacySpaceUri ?? SECRETS_SPACE,
    );
    const effectiveHost = params.host ?? delegated.delegation.host ?? ctx.host;
    const delegatedCtx = { ...ctx, host: effectiveHost };
    // Decide D4 before the node exists: the profile or an explicit key.
    const local = effectiveLocal(await ProfileManager.getProfile(ctx.profile).catch(() => null), options);
    const node = await ensureSecretsNode(delegatedCtx, options);
    const value = await withSpinner(
      `Getting secret ${name}...`,
      () => readDelegatedSecretValue({
        node,
        delegation: delegated.delegation,
        delegationCid: delegated.delegation.cid,
        permissions: delegated.permissions,
        secretPath: target.secretPath,
        space: target.legacySpaceUri ?? SECRETS_SPACE,
        name,
        ...(target.scope === undefined ? {} : { scope: target.scope }),
        local,
      }),
    );
    return { value };
  }

  // An explicit local key changes the authenticated owner. Keep a short
  // CLI space unresolved so the registered operation resolves it against
  // that live owner; full URIs remain explicit cross-owner inputs.
  const privateKey = authOptions(options)?.privateKey;
  const spaceUri = privateKey !== undefined &&
      options.space !== undefined &&
      !options.space.startsWith("tinycloud:")
    ? options.space
    : target.legacySpaceUri;

  const result = await invokeCanonicalSecretGet({
    ctx,
    name,
    ...(target.scopeOptions?.scope === undefined ? {} : { scope: target.scopeOptions.scope }),
    ...(spaceUri === undefined ? {} : { space: spaceUri }),
    options,
    label: `Getting secret ${name}...`,
    openKeyAcquisition: params.openKeyAcquisition,
  });

  if (result.status !== "ok") {
    try {
      throwCanonicalSecretGetError(result, name);
    } catch (error) {
      throw withOperationWarnings(error, result.warnings);
    }
  }
  return { value: result.output.value, warnings: result.warnings };
}

/** Environment variable names `secrets run` sets: the portable POSIX form. */
const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The arguments after the first `--` tc's root command left literal, or none
 * without one. Commander keeps that `--` out of the operands when no unknown
 * option precedes it, so it is found in the argv the root command parsed
 * (Commander keeps it, untyped, as `rawArgs`), skipping the values of tc's
 * global options as Commander does.
 */
function argvAfterSeparator(cmd: Command): string[] | undefined {
  let root = cmd;
  while (root.parent) root = root.parent;
  const raw: unknown = "rawArgs" in root ? root.rawArgs : undefined;
  if (!Array.isArray(raw)) return undefined;
  const args = raw.map(String);
  const withValue = (flag: string): boolean =>
    root.options.some((option) => option.required && (option.long === flag || option.short === flag));
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return args.slice(index + 1);
    if (arg.startsWith("--")) {
      if (withValue(arg)) index += 1;
      continue;
    }
    if (arg.length < 2 || !arg.startsWith("-")) continue;
    // A short cluster (-vp NAME): the first flag that takes a value ends it.
    for (let char = 1; char < arg.length; char += 1) {
      const option = root.options.find((candidate) => candidate.short === `-${arg[char]}`);
      if (option === undefined) break;
      if (option.required) {
        if (char === arg.length - 1) index += 1;
        break;
      }
    }
  }
  return undefined;
}

interface SecretRunPlan {
  command: [string, ...string[]];
  /** Secret `name` is exported as `variable`. */
  exports: { name: string; variable: string }[];
}

/** `secrets run`'s command and exports, or a usage error; nothing is read here. */
function secretRunPlan(cmd: Command, operands: readonly string[], maps: readonly string[]): SecretRunPlan {
  const usage = `${CLI_NAME} secrets run NAME... [--map NAME=ENV_VAR] -- <command> [args...]`;
  const after = argvAfterSeparator(cmd);
  if (after === undefined || after.length > operands.length) {
    throw new CLIError("USAGE_ERROR", `Put the command after \`--\`: ${usage}`, ExitCode.USAGE_ERROR);
  }
  const [program, ...args] = after;
  if (program === undefined) {
    throw new CLIError("USAGE_ERROR", `Add the command to run after \`--\`: ${usage}`, ExitCode.USAGE_ERROR);
  }
  const exports: SecretRunPlan["exports"] = [];
  for (const name of operands.slice(0, operands.length - after.length)) {
    if (!ENV_VAR_RE.test(name)) {
      throw new CLIError(
        "USAGE_ERROR",
        `${JSON.stringify(name)} can't be used as an environment variable name. Use \`--map ${name}=ENV_VAR\` to choose one.`,
        ExitCode.USAGE_ERROR,
      );
    }
    exports.push({ name, variable: name });
  }
  for (const map of maps) {
    const equals = map.indexOf("=");
    const variable = map.slice(equals + 1);
    if (equals <= 0 || !ENV_VAR_RE.test(variable)) {
      throw new CLIError(
        "USAGE_ERROR",
        `Invalid \`--map ${JSON.stringify(map)}\`: use NAME=ENV_VAR, where ENV_VAR starts with a letter or _ and uses only letters, digits and _.`,
        ExitCode.USAGE_ERROR,
      );
    }
    exports.push({ name: map.slice(0, equals), variable });
  }
  if (exports.length === 0) {
    throw new CLIError("USAGE_ERROR", `Name at least one secret: ${usage}`, ExitCode.USAGE_ERROR);
  }
  const variables = new Set<string>();
  for (const { variable } of exports) {
    if (variables.has(variable)) {
      throw new CLIError("USAGE_ERROR", `Two secrets are mapped to ${variable}. Give each its own variable.`, ExitCode.USAGE_ERROR);
    }
    variables.add(variable);
  }
  return { command: [program, ...args], exports };
}

/**
 * End tc as the command ended: with its exit code, by its signal (128 + the
 * signal number if the signal does not end tc), or 127 / 126 when it could
 * not start. Only the program name is printed, never its arguments.
 */
function exitAsCommand(outcome: CommandOutcome, program: string): never {
  if (outcome.kind === "exited") return process.exit(outcome.code);
  if (outcome.kind === "signaled") {
    process.kill(process.pid, outcome.signal);
    return process.exit(128 + (osConstants.signals[outcome.signal] ?? 0));
  }
  const reason = outcome.errno === "ENOENT"
    ? "command not found"
    : outcome.errno === "EACCES" ? "permission denied" : `cannot run (${outcome.errno ?? "unknown error"})`;
  process.stderr.write(`${CLI_NAME} secrets run: ${safeInline(program)}: ${reason}\n`);
  return process.exit(outcome.errno === "ENOENT" ? 127 : 126);
}

export function registerSecretsCommand(
  program: Command,
  openKeyAcquisition?: OpenKeyAcquisition,
): void {
  const secrets = program.command("secrets").description("Encrypted secrets management");

  const network = secrets
    .command("network")
    .description("Manage the default secrets encryption network");

  network
    .command("show [nameOrNetworkId]")
    .description("Show a secrets encryption network")
    .option("--private-key <hex>", "Ethereum private key override (or set TC_PRIVATE_KEY)")
    .action(async (nameOrNetworkId: string | undefined, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx, authOptions(options));
        const requested = nameOrNetworkId ?? "default";
        const networkId = requested.startsWith("urn:tinycloud:encryption:")
          ? requested
          : node.getDefaultEncryptionNetworkId(requested);
        const descriptor = await withSpinner(
          "Fetching encryption network...",
          () => node.getEncryptionNetwork(requested),
        );
        outputJson({
          networkId,
          exists: descriptor !== null,
          ...(descriptor ? { descriptor } : {}),
        });
      } catch (error) {
        return handleError(error);
      }
    });

  network
    .command("init [name]")
    .description("Create a secrets encryption network if needed")
    .option("--private-key <hex>", "Ethereum private key override (or set TC_PRIVATE_KEY)")
    .action(async (name: string | undefined, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx, authOptions(options));
        const descriptor = await withSpinner(
          "Ensuring encryption network...",
          () => node.ensureEncryptionNetwork(name ?? "default"),
        );
        outputJson({
          networkId: descriptor.networkId,
          state: descriptor.state,
          descriptor,
        });
      } catch (error) {
        return handleError(error);
      }
    });

  secrets
    .command("doctor [name]")
    .description("Check secrets setup and optional secret access")
    .option("--scope <scope>", "Logical secret scope")
    .option("--space <name|uri>", "Target a non-default secrets space (short name or full URI)")
    .option("--network <name>", "Encryption network name", "default")
    .option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)")
    .action(async (name: string | undefined, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureSecretsNode(ctx, options);
        const networkName = options.network ?? "default";
        const networkId = networkName.startsWith("urn:tinycloud:encryption:")
          ? networkName
          : node.getDefaultEncryptionNetworkId(networkName);
        const descriptor = await withSpinner(
          "Checking secrets encryption network...",
          () => node.getEncryptionNetwork(networkName),
        );
        const checks: SecretDoctorCheck[] = [
          descriptor
            ? {
                name: "Encryption network",
                ok: descriptor.state === "active" ? true : "warn",
                detail: `${networkName} (${descriptor.state})`,
              }
            : {
                name: "Encryption network",
                ok: false,
                detail: `${networkName} not found`,
                hint: `${CLI_NAME} secrets network init ${networkName}`,
              },
        ];
        let secret: SecretDoctorResult["secret"];

        if (name) {
          const scopeOptions = resolveSecretScope(options);
          const spaceUri = await resolveSecretSpace(options.space, ctx.profile);
          const secrets = secretsServiceForSpace(node, spaceUri);
          const resolved = resolveSecretPath(name, scopeOptions);
          const result = await runSecretOperation({
            ctx,
            node,
            action: "get",
            name,
            scopeOptions,
            space: spaceUri,
            label: `Checking secret ${name}...`,
            operation: () => secrets.get(name, { ...scopeOptions, source: "network" }),
          });

          if (result.ok) {
            secret = {
              name: resolved.name,
              path: resolved.permissionPaths.vault,
              ...(resolved.scope ? { scope: resolved.scope } : {}),
              exists: true,
              readable: true,
            };
            checks.push({
              name: "Secret access",
              ok: true,
              detail: `${resolved.permissionPaths.vault} readable`,
            });
          } else {
            const notFound = result.error.code === "NOT_FOUND" || result.error.code === "KEY_NOT_FOUND";
            const local = notFound &&
              effectiveLocal(await ProfileManager.getProfile(ctx.profile).catch(() => null), options);
            secret = {
              name: resolved.name,
              path: resolved.permissionPaths.vault,
              ...(resolved.scope ? { scope: resolved.scope } : {}),
              exists: !notFound,
              readable: false,
            };
            checks.push({
              name: "Secret access",
              ok: false,
              detail: notFound ? `${resolved.permissionPaths.vault} not found` : result.error.message,
              hint: notFound
                ? local
                  ? `${CLI_NAME} secrets put ${resolved.name}${formatSecretScopeFlag(scopeOptions)} --stdin`
                  : `${CLI_NAME} secrets request ${resolved.name}${formatSecretScopeFlag(scopeOptions)}`
                : `Ask the owner profile to grant ${secretCapabilityAction("get")} and ${SECRET_DECRYPT_CAPABILITY}.`,
            });
          }
        } else {
          checks.push({
            name: "Secret access",
            ok: "warn",
            detail: "skipped; pass a secret name to verify read access",
          });
        }

        outputSecretDoctor({
          healthy: checks.every((check) => check.ok !== false),
          network: {
            name: networkName,
            networkId,
            exists: descriptor !== null,
            ...(descriptor?.state ? { state: descriptor.state } : {}),
          },
          ...(secret ? { secret } : {}),
          checks,
        });
      } catch (error) {
        return handleError(error);
      }
    });

  // tc secrets list
  secrets
    .command("list")
    .description("List secrets")
    .option("--scope <scope>", "Logical secret scope")
    .option("--space <name|uri>", "Target a non-default secrets space (short name or full URI)")
    .option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)")
    .action(async (options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureSecretsNode(ctx, options);
        const scopeOptions = resolveSecretScope(options);
        const spaceUri = await resolveSecretSpace(options.space, ctx.profile);
        const secrets = secretsServiceForSpace(node, spaceUri);
        const result = await runSecretOperation({
          ctx,
          node,
          action: "list",
          scopeOptions,
          space: spaceUri,
          label: "Listing secrets...",
          operation: () => secrets.list({ ...scopeOptions, source: "network" }),
        });

        if (!result.ok) {
          throw cliErrorFromService(result.error);
        }

        const secretNames = Array.isArray(result.data) ? result.data : [];

        outputJson({
          secrets: secretNames,
          count: secretNames.length,
          ...(options.scope ? { scope: options.scope } : {}),
          ...(spaceUri ? { space: spaceUri } : {}),
        });
      } catch (error) {
        return handleError(error);
      }
    });

  // tc secrets get <name>
  secrets
    .command("get <name>")
    .description("Get a secret value")
    .option("--scope <scope>", "Logical secret scope")
    .option("--space <name|uri>", "Target a non-default secrets space (short name or full URI)")
    .option("--raw", "Output raw value (no JSON wrapping)")
    .option("--value-only", "Output only the secret value (alias for --raw)")
    .option("-o, --output <file>", "Write value to file")
    .option("--delegation <source>", "Delegation file path or imported profile name")
    .option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)")
    .action(async (name: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const target = await resolveSecretReadTarget(ctx, name, options);
        if (options.output) await validatePrivateOutput(options.output, "Secret output");
        const secret = await readSecret({ ctx, host: globalOpts.host, target, options, openKeyAcquisition });
        const value = secret.value;

        if (options.delegation) {
          if (options.output) {
            await writePrivateOutput(options.output, value, "Secret output");
            outputJson({ name, written: options.output });
            return;
          }

          if (options.raw) {
            process.stdout.write(value);
            return;
          }

          outputJson({ name, value });
          return;
        }

        // Success warnings go out only once the command's output has; a
        // failed write reports them inside its error instead.
        try {
          if (options.output) {
            await writePrivateOutput(options.output, value, "Secret output");
            outputJson({ name, written: options.output });
          } else if (options.raw || options.valueOnly) {
            process.stdout.write(value);
          } else {
            outputJson({ name, value });
          }
        } catch (error) {
          throw withOperationWarnings(error, secret.warnings);
        }
        outputWarnings(operationWarnings(secret.warnings));
      } catch (error) {
        return handleError(error);
      }
    });

  // tc secrets run [names...] -- <command> [args...]
  secrets
    .command("run [names...]")
    .description("Run a command with secrets in its environment")
    .usage("[options] [names...] -- <command> [args...]")
    .option(
      "--map <NAME=ENV_VAR>",
      "Give secret NAME to the command as environment variable ENV_VAR (repeatable)",
      (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
    )
    .option("--scope <scope>", "Logical secret scope")
    .option("--space <name|uri>", "Target a non-default secrets space (short name or full URI)")
    .option("--delegation <source>", "Delegation file path or imported profile name")
    .option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)")
    .action(async (operands: string[], options, cmd: Command) => {
      try {
        const plan = secretRunPlan(cmd, operands, options.map ?? []);
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        // Every name is checked before any secret is read.
        const targets: SecretReadTarget[] = [];
        for (const name of new Set(plan.exports.map((entry) => entry.name))) {
          targets.push(await resolveSecretReadTarget(ctx, name, options));
        }
        // All secrets are read before the command starts; any failure ends tc as `secrets get` would.
        const values = new Map<string, string>();
        let warnings: CanonicalSecretGetWarning[] = [];
        for (const target of targets) {
          const secret = await readSecret({ ctx, host: globalOpts.host, target, options, openKeyAcquisition });
          // Node refuses such an environment with an error that quotes the value.
          if (secret.value.includes("\u0000")) {
            throw new CLIError(
              "SECRET_NOT_EXPORTABLE",
              `Secret "${target.name}" contains a NUL character, so it can't be put in an environment variable. The command wasn't started.`,
              ExitCode.ERROR,
            );
          }
          values.set(target.name, secret.value);
          warnings = mergeWarnings(warnings, secret.warnings ?? []);
        }
        outputWarnings(operationWarnings(warnings));
        // tc reads nothing more: stop its replication, and that replication's
        // signal handlers, before the command runs.
        await closeReplication();
        const env: NodeJS.ProcessEnv = { ...process.env };
        for (const entry of plan.exports) env[entry.variable] = values.get(entry.name);
        values.clear();
        exitAsCommand(await runCommand(plan.command, env), plan.command[0]);
      } catch (error) {
        return handleError(error);
      }
    });

  // tc secrets put <name> [value]
  secrets
    .command("put <name> [value]")
    .description("Store a secret")
    .option("--scope <scope>", "Logical secret scope")
    .option("--space <name|uri>", "Target a non-default secrets space (short name or full URI)")
    .option("--file <path>", "Read value from file")
    .option("--stdin", "Read value from stdin")
    .option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)")
    .action(async (name: string, value: string | undefined, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureSecretsNode(ctx, options);
        const spaceUri = await resolveSecretSpace(options.space, ctx.profile);
        const secrets = secretsServiceForSpace(node, spaceUri);

        // Determine value source
        let secretValue: string;
        const sources = [value !== undefined, !!options.file, !!options.stdin].filter(Boolean);

        if (sources.length === 0) {
          throw new CLIError("USAGE_ERROR", "Must provide a value, --file, or --stdin", ExitCode.USAGE_ERROR);
        }
        if (sources.length > 1) {
          throw new CLIError("USAGE_ERROR", "Provide only one of: value argument, --file, or --stdin", ExitCode.USAGE_ERROR);
        }

        if (options.file) {
          secretValue = (await readFile(options.file, "utf-8")) as string;
        } else if (options.stdin) {
          secretValue = (await readStdin()).toString("utf-8");
        } else {
          secretValue = value!;
        }

        const scopeOptions = resolveSecretScope(options);
        const result = await runSecretOperation({
          ctx,
          node,
          action: "put",
          name,
          scopeOptions,
          space: spaceUri,
          label: `Storing secret ${name}...`,
          operation: () => secrets.put(name, secretValue, scopeOptions),
        });

        if (!result.ok) {
          throw cliErrorFromService(result.error);
        }

        outputJson({ name, written: true });
      } catch (error) {
        return handleError(error);
      }
    });

  // tc secrets delete <name>
  secrets
    .command("delete <name>")
    .description("Delete a secret")
    .option("--scope <scope>", "Logical secret scope")
    .option("--space <name|uri>", "Target a non-default secrets space (short name or full URI)")
    .option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY)")
    .action(async (name: string, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureSecretsNode(ctx, options);
        const scopeOptions = resolveSecretScope(options);
        const spaceUri = await resolveSecretSpace(options.space, ctx.profile);
        const secrets = secretsServiceForSpace(node, spaceUri);
        const result = await runSecretOperation({
          ctx,
          node,
          action: "del",
          name,
          scopeOptions,
          space: spaceUri,
          label: `Deleting secret ${name}...`,
          operation: () => secrets.delete(name, scopeOptions),
        });

        if (!result.ok) {
          throw cliErrorFromService(result.error);
        }

        outputJson({ name, deleted: true });
      } catch (error) {
        return handleError(error);
      }
    });

  network
    .command("grant <recipientDid> [name]")
    .description("Grant decrypt permission for a secrets encryption network")
    .option("--private-key <hex>", "Ethereum private key override (or set TC_PRIVATE_KEY)")
    .action(async (recipientDid: string, name: string | undefined, options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const node = await ensureAuthenticated(ctx, authOptions(options));
        const networkName = name ?? "default";
        const descriptor = await withSpinner(
          "Ensuring encryption network...",
          () => node.ensureEncryptionNetwork(networkName),
        );
        const permission = {
          service: "tinycloud.encryption",
          path: descriptor.networkId,
          actions: ["decrypt"],
        };
        const result = await withSpinner(
          `Granting decrypt permission to ${recipientDid}...`,
          () => node.delegateTo(recipientDid, [permission]),
        );

        outputJson({
          networkId: descriptor.networkId,
          recipientDid,
          cid: result.delegation.cid,
          prompted: result.prompted,
          path: result.delegation.path,
          actions: result.delegation.actions,
        });
      } catch (error) {
        return handleError(error);
      }
    });

  // tc secrets request <names...>
  secrets
    .command("request <name...>")
    .description("Print a Secret Manager link asking the owner to add secrets (offline)")
    .option("--scope <scope>", "Logical secret scope")
    .option("--app <id>", "Derive the scope from an app id (instead of --scope)")
    .option("--owner <did>", "Owner did:pkh when the profile does not record one")
    .option("--requester <label>", "Who is asking, shown to the owner (default: user@host)")
    .option("--open", "Also open the link in a browser")
    .option("--private-key <hex>", "Ethereum private key (or set TC_PRIVATE_KEY); a local key cannot request")
    .action(async (names: string[], options, cmd) => {
      try {
        const globalOpts = cmd.optsWithGlobals();
        const ctx = await ProfileManager.resolveContext(globalOpts);
        const scope = requestedSecretScope(options);
        const profile = await ProfileManager.getProfile(ctx.profile).catch(() => null);
        if (effectiveLocal(profile, options)) {
          throw new CLIError(
            "LOCAL_OWNER_PROFILE",
            `Profile "${ctx.profile}" uses a local key, which owns its secrets: store them with ${CLI_NAME} secrets put NAME --stdin instead of requesting them.`,
            ExitCode.USAGE_ERROR,
          );
        }
        let link: SecretRequestLink;
        try {
          const requestedOwner = options.owner === undefined ? undefined : canonicalSecretRequestOwner(options.owner);
          const resolution = resolveSecretsOwner({
            local: false,
            posture: resolveProfilePosture(profile ?? {}),
            ...(profile?.ownerDid === undefined ? {} : { ownerDid: profile.ownerDid.split("#")[0] }),
            ...(profile?.did === undefined ? {} : { principalDid: profile.did.split("#")[0] }),
            ...(profile?.spaceId === undefined ? {} : { space: profile.spaceId }),
          }, requestedOwner);
          if (!resolution.ok) {
            throw new CLIError(
              resolution.code,
              resolution.message,
              resolution.code === "OWNER_MISMATCH" ? ExitCode.USAGE_ERROR : ExitCode.AUTH_REQUIRED,
            );
          }
          const requester = options.requester ?? defaultRequester();
          link = buildSecretRequestUrl({
            owner: resolution.owner,
            names,
            ...(scope === undefined ? {} : { scope }),
            ...(requester === undefined ? {} : { requester }),
          });
        } catch (error) {
          throw secretRequestUsageError(error);
        }
        outputJson({ url: link.url, names: link.names, ...(link.scope === undefined ? {} : { scope: link.scope }), owner: link.owner });
        if (options.open && !(await tryOpenBrowser(link.url))) warnBrowserNotOpened();
      } catch (error) {
        return handleError(error);
      }
    });

  // tc secrets manage [names...]
  secrets
    .command("manage [name...]")
    .description("Open the TinyCloud Secrets Manager, optionally at the named secrets")
    .option("--scope <scope>", "Logical secret scope")
    .option("--app <id>", "Derive the scope from an app id (instead of --scope)")
    .option("--no-open", "Print the URL without opening a browser")
    .action(async (names: string[], options) => {
      try {
        const scope = requestedSecretScope(options);
        let url: string;
        try {
          url = buildSecretManagerUrl({ names, ...(scope === undefined ? {} : { scope }) });
        } catch (error) {
          throw secretRequestUsageError(error);
        }
        const opened = options.open === false ? false : await tryOpenBrowser(url);
        outputJson({ url, opened });
        if (options.open !== false && !opened) warnBrowserNotOpened();
      } catch (error) {
        return handleError(error);
      }
    });

  // tc secrets wait <name...>: the parent holds no TinyCloud state and
  // resolves no owner; each attempt is a `secrets probe` child (plan §2.4).
  secrets
    .command("wait <name...>")
    .description("Wait until named secrets exist. Never signs in: needs a stored session, not TC_PRIVATE_KEY")
    .option("--scope <scope>", "Logical secret scope")
    .option("--app <id>", "Derive the scope from an app id (instead of --scope)")
    .option("--owner <did>", "Expected owner did:pkh, checked against the profile's live identity")
    .option("--timeout <duration>", "0 (one attempt), Ns or Nm; at most 9m", DEFAULT_WAIT_TIMEOUT)
    .action(async (names: string[], options, cmd) => {
      const controller = new AbortController();
      const cancel = (): void => controller.abort();
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
      try {
        const timeoutMs = parseWaitTimeout(options.timeout);
        const scope = requestedSecretScope(options);
        let validNames: string[];
        let owner: string | undefined;
        try {
          validNames = validSecretNames(names);
          if (scope !== undefined && !isValidSecretRequestScope(scope)) {
            throw new CLIError("INVALID_SECRET_SCOPE", `Invalid secret scope ${JSON.stringify(scope)}.`, ExitCode.USAGE_ERROR);
          }
          owner = options.owner === undefined ? undefined : canonicalSecretRequestOwner(options.owner);
        } catch (error) {
          throw secretRequestUsageError(error);
        }
        const ctx = await ProfileManager.resolveContext(cmd.optsWithGlobals());
        const probe: ProbeRequest = {
          profile: ctx.profile,
          host: ctx.host,
          names: validNames,
          ...(scope === undefined ? {} : { scope }),
          ...(owner === undefined ? {} : { owner }),
        };
        const result = await runSecretsWait(
          { profile: ctx.profile, timeoutMs, consentHint: scopedSecretLoginHint(ctx.profile) },
          {
            now: Date.now,
            sleep: abortableSleep,
            runProbe: (signal) => runProbeChild(probe, { signal }),
            signal: controller.signal,
          },
        );
        outputJson(result.stdout);
        outputWarnings(operationWarnings(result.warnings));
        process.exitCode = result.exitCode;
      } catch (error) {
        return handleError(error);
      } finally {
        process.off("SIGINT", cancel);
        process.off("SIGTERM", cancel);
      }
    });

  // Internal: one `tinycloud.secrets.status` attempt for `secrets wait`. It
  // prints the canonical envelope as one JSON line and writes no profile state.
  secrets
    .command("probe <name...>", { hidden: true })
    .option("--scope <scope>", "Logical secret scope")
    .option("--owner <did>", "Requested owner did:pkh")
    .action(async (names: string[], options, cmd) => {
      try {
        const ctx = await ProfileManager.resolveContext(cmd.optsWithGlobals());
        const privateKey = process.env.TC_PRIVATE_KEY;
        const result = await invokeOperation("tinycloud.secrets.status", 1, {
          profile: ctx.profile,
          host: ctx.host,
          allowOwnerProfile: true,
          ...(privateKey ? { privateKey } : {}),
        }, {
          names,
          ...(options.scope === undefined ? {} : { scope: options.scope }),
          ...(options.owner === undefined ? {} : { owner: options.owner }),
        });
        process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
      } catch (error) {
        return handleError(error);
      }
    });
}
