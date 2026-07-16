import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  type PermissionEntry,
  type PortableDelegation,
  type TinyCloudNode,
} from "@tinycloud/node-sdk";
import { invokeOperation } from "@tinycloud/operations";
import { invokeSecretsGetWithLocalAuthorityRetry } from "@tinycloud/operations/cli-runtime";
import { ProfileManager } from "../config/profiles.js";
import { formatCheck, formatSection, outputJson, shouldOutputJson, withSpinner } from "../output/formatter.js";
import { theme } from "../output/theme.js";
import { handleError, CLIError } from "../output/errors.js";
import { ExitCode } from "../config/constants.js";
import { ensureAuthenticated } from "../lib/sdk.js";
import { resolveSpaceUri } from "../lib/space.js";
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
  | "tinycloud.kv/get"
  | "tinycloud.kv/put"
  | "tinycloud.kv/del"
  | "tinycloud.kv/list";
const SECRET_KV_ABILITIES: Record<SecretAction, SecretKvAbility> = {
  get: "tinycloud.kv/get",
  put: "tinycloud.kv/put",
  del: "tinycloud.kv/del",
  list: "tinycloud.kv/list",
};
type SecretResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; service?: string } };

type CanonicalSecretGetResult = Awaited<ReturnType<typeof invokeOperation>>;

interface SecretScopeOptions {
  scope?: string;
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
): Promise<TinyCloudNode> {
  const auth = authOptions(options);
  if (auth?.privateKey) {
    return ensureAuthenticated(ctx, auth);
  }

  const profile = await ProfileManager.getProfile(ctx.profile).catch(() => null);
  if (profile?.authMethod === "openkey" && canRequestOwnerPermissions(profile)) {
    const session = await ProfileManager.getSession(ctx.profile);
    if (!session || isStoredSessionExpired(session)) {
      await withSpinner(
        session ? "Refreshing TinyCloud session..." : "Creating TinyCloud session...",
        () => refreshOpenKeySession(ctx.profile, ctx.host),
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
      openKeyAcquisition: params.openKeyAcquisition,
    }),
  );

  return runSecretOperationAttempt(params.label, params.operation);
}

function secretPermissionReason(action: SecretAction, name?: string): string {
  const target = name ? ` secret "${name}"` : " secrets";
  return `Allow \`tc secrets ${action}${name ? ` ${name}` : ""}\` to access${target} with the required TinyCloud permissions.`;
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

async function invokeCanonicalSecretGet(params: {
  ctx: CLIContext;
  node?: TinyCloudNode;
  name: string;
  scope?: string;
  space?: string;
  options: { privateKey?: string };
  label: string;
  openKeyAcquisition?: OpenKeyAcquisition;
}): Promise<CanonicalSecretGetResult> {
  const auth = authOptions(params.options);
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

  const invoke = () => withSpinner(
    params.label,
    () => auth?.privateKey
      ? invokeSecretsGetWithLocalAuthorityRetry(target, input)
      : invokeOperation("tinycloud.secrets.get", 1, target, input),
  );
  const first = await invoke();
  if (first.status !== "authority_required") return first;
  // Explicit keys use the operations-owned local acquisition/retry path. If
  // its exact request is cross-owner, preserve the authority result rather
  // than falling back to the persisted profile's OpenKey posture.
  if (auth?.privateKey !== undefined) return first;

  const profile = await ProfileManager.getProfile(params.ctx.profile);
  if (!canRequestOwnerPermissions(profile)) return first;
  const node = params.node ?? await ensureSecretsNode(params.ctx, params.options);

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
      openKeyAcquisition: params.openKeyAcquisition,
    }),
  );

  return invoke();
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
        ExitCode.ERROR,
      );
    case "setup_required":
      throw new CLIError("NOT_FOUND", `Secret "${name}" not found`, ExitCode.NOT_FOUND);
    case "error":
      throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
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

function isMissingFileError(error: unknown): boolean {
  const typed = error as NodeJS.ErrnoException | null;
  return typed?.code === "ENOENT";
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
    if (!hasPermissionAction(permission.actions, "tinycloud.kv/get")) return false;
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
    if (!hasPermissionAction(permission.actions, "tinycloud.encryption/decrypt")) return false;
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
    if (!isMissingFileError(error)) {
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
    if (isMissingFileError(error)) {
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
      throw new CLIError(
        "NOT_FOUND",
        `Secret "${params.name}" not found`,
        ExitCode.NOT_FOUND,
      );
    }
    if (envelopeResult.error.code === "PERMISSION_DENIED") {
      throw new CLIError(
        "PERMISSION_DENIED",
        `Delegation "${params.delegationCid}" does not cover secret "${params.secretPath}".`,
        ExitCode.PERMISSION_DENIED,
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
      `Delegation "${params.delegationCid}" does not include tinycloud.encryption/decrypt for ${networkId}.`,
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
  if (typeof record.siwe !== "string") return false;
  const match = record.siwe.match(/^Expiration Time:\s*(.+)$/im);
  const expiry = match ? parseDate(match[1].trim()) : null;
  return expiry !== null && expiry.getTime() <= Date.now();
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
      actions: ["tinycloud.encryption/decrypt"],
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
        handleError(error);
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
        handleError(error);
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
                hint: `tc secrets network init ${networkName}`,
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
            operation: () => secrets.get(name, scopeOptions),
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
                ? `tc secrets put ${resolved.name}${formatSecretScopeFlag(scopeOptions)} <value>`
                : "Ask the owner profile to grant tinycloud.kv/get and tinycloud.encryption/decrypt.",
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
        handleError(error);
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
          operation: () => secrets.list(scopeOptions),
        });

        if (!result.ok) {
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
        }

        const secretNames = Array.isArray(result.data) ? result.data : [];

        outputJson({
          secrets: secretNames,
          count: secretNames.length,
          ...(options.scope ? { scope: options.scope } : {}),
          ...(spaceUri ? { space: spaceUri } : {}),
        });
      } catch (error) {
        handleError(error);
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
        const scopeOptions = resolveSecretScope(options);
        const legacySpaceUri = await resolveSecretSpace(options.space, ctx.profile);
        const secretPath = resolveSecretPath(name, scopeOptions).permissionPaths.vault;

        if (options.delegation) {
          const delegated = await resolveDelegatedSecretSource(
            options.delegation,
            secretPath,
            legacySpaceUri ?? SECRETS_SPACE,
          );
          const effectiveHost = globalOpts.host ?? delegated.delegation.host ?? ctx.host;
          const delegatedCtx = { ...ctx, host: effectiveHost };
          const node = await ensureSecretsNode(delegatedCtx, options);
          const value = await withSpinner(
            `Getting secret ${name}...`,
            () => readDelegatedSecretValue({
              node,
              delegation: delegated.delegation,
              delegationCid: delegated.delegation.cid,
              permissions: delegated.permissions,
              secretPath,
              space: legacySpaceUri ?? SECRETS_SPACE,
              name,
            }),
          );

          if (options.output) {
            await writeFile(options.output, value);
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

        // An explicit local key changes the authenticated owner. Keep a short
        // CLI space unresolved so the registered operation resolves it against
        // that live owner; full URIs remain explicit cross-owner inputs.
        const privateKey = authOptions(options)?.privateKey;
        const spaceUri = privateKey !== undefined &&
            options.space !== undefined &&
            !options.space.startsWith("tinycloud:")
          ? options.space
          : legacySpaceUri;

        const result = await invokeCanonicalSecretGet({
          ctx,
          name,
          ...(scopeOptions?.scope === undefined ? {} : { scope: scopeOptions.scope }),
          ...(spaceUri === undefined ? {} : { space: spaceUri }),
          options,
          label: `Getting secret ${name}...`,
          openKeyAcquisition,
        });

        if (result.status !== "ok") {
          throwCanonicalSecretGetError(result, name);
        }

        const value = result.output.value;

        if (options.output) {
          await writeFile(options.output, value);
          outputJson({ name, written: options.output });
          return;
        }

        if (options.raw || options.valueOnly) {
          process.stdout.write(value);
          return;
        }

        outputJson({ name, value });
      } catch (error) {
        handleError(error);
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
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
        }

        outputJson({ name, written: true });
      } catch (error) {
        handleError(error);
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
          throw new CLIError(result.error.code, result.error.message, ExitCode.ERROR);
        }

        outputJson({ name, deleted: true });
      } catch (error) {
        handleError(error);
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
        handleError(error);
      }
    });

  // tc secrets manage
  secrets
    .command("manage")
    .description("Open the TinyCloud Secrets Manager in your browser")
    .action(async () => {
      try {
        const open = (await import("open")).default;
        await open("https://secrets.tinycloud.xyz");
        outputJson({ opened: "https://secrets.tinycloud.xyz" });
      } catch (error) {
        handleError(error);
      }
    });
}
