import {
  canonicalizeRecapCaveats,
  decodeBase64Url,
  Delegation,
  DelegatedResource,
  PermissionEntry,
  principalDidEquals,
} from "@tinycloud/sdk-core";

/**
 * A portable delegation that can be transported between users.
 * Extends the base Delegation type with fields required for transport.
 *
 * @remarks
 * PortableDelegation adds transport fields to Delegation:
 * - `delegationHeader`: Structured authorization header for API calls
 * - `ownerAddress`: Space owner's address for session creation
 * - `chainId`: Chain ID for session creation
 * - `host`: Optional server URL
 * - `resources`: Multi-resource grant breakdown (present when the
 *   delegation was issued via the multi-resource WASM path, i.e. one
 *   UCAN covering multiple `(service, path, actions)` entries). The
 *   flat `path` + `actions` fields mirror the first entry for
 *   single-resource callers; consumers that need the full picture
 *   read `resources`.
 */
export interface PortableDelegation extends Omit<Delegation, "isRevoked"> {
  /** The authorization header for this delegation (structured format) */
  delegationHeader: { Authorization: string };

  /** The address of the space owner */
  ownerAddress: string;

  /** The chain ID */
  chainId: number;

  /** TinyCloud server URL where this delegation was created */
  host?: string;

  /** Whether the recipient is prevented from creating sub-delegations */
  disableSubDelegation?: boolean;

  /** Companion delegation for the user's public space (auto-created when includePublicSpace is true) */
  publicDelegation?: PortableDelegation;

  /**
   * Full multi-resource grant breakdown. Present when the delegation
   * was issued via the multi-resource WASM path; each entry describes
   * one `(service, space, path, actions)` grant carried by the single
   * underlying UCAN. When absent, only the flat `path` + `actions`
   * fields are authoritative (legacy single-resource shape).
   */
  resources?: DelegatedResource[];

  /**
   * Signed-login proof for a SIWE/ReCap (CACAO) delegation. Present only
   * when `delegationHeader` carries that CACAO instead of a compact UCAN;
   * {@link activateValidatedRuntimeDelegation} re-verifies it in WASM and
   * derives the authority from it.
   */
  siweProof?: SiweDelegationProof;
}

/** The signed SIWE message and wallet signature behind a CACAO delegation. */
export interface SiweDelegationProof {
  readonly siwe: string;
  readonly signature: string;
}

/**
 * The transport shape `tc auth request --emit` produces and that an owner
 * grants to its requester. Only the fields the grant logic needs are declared;
 * the CLI artifact carries more (posture, captured command, ...) and remains a
 * structural superset of this interface.
 */
export interface AuthRequestArtifact {
  kind: "tinycloud.auth.request";
  version: 1;
  requestId: string;
  /** The requester's session DID — the audience the grant is issued to. */
  sessionDid: string;
  /** The capabilities the requester is asking the owner to delegate. */
  requested: PermissionEntry[];
  /** Optional lifetime override carried from the request. */
  requestedExpiry?: string | number;
}

/**
 * The transport shape returned by {@link grantAuthRequest} (and written by
 * `tc auth grant`). `tc auth import` accepts this artifact directly.
 */
export interface AuthDelegationArtifact {
  kind: "tinycloud.auth.delegation";
  version: 1;
  requestId: string;
  delegationCid: string;
  delegation: PortableDelegation;
  permissions: PermissionEntry[];
  expiry: string;
  /** Whether issuing the delegation triggered a wallet prompt. */
  prompted: boolean;
}

/**
 * Minimal owner-side capability {@link grantAuthRequest} needs: the signed
 * `delegateTo` primitive. `TinyCloudNode` satisfies this directly; web/SDK
 * contexts can supply any object that exposes the same method.
 */
export interface DelegationAuthority {
  delegateTo(
    did: string,
    permissions: PermissionEntry[],
    options?: { expiry?: string | number; forceWalletSign?: boolean },
  ): Promise<{ delegation: PortableDelegation; prompted: boolean }>;
}

/**
 * Authority that the validated runtime-delegation activation helper needs.
 * `TinyCloudNode` implements this surface directly; keeping it structural
 * makes the helper usable by a compatible Node wrapper without exposing node
 * internals.
 */
export interface RuntimeDelegationActivator {
  readonly sessionDid: string;
  readonly did?: string;
  readonly isSessionOnly?: boolean;
  computeDelegationCid(authorization: string): string;
  useRuntimeDelegation(delegation: PortableDelegation): Promise<void>;
  useDelegation?(delegation: PortableDelegation): Promise<unknown>;
  getRuntimePermissionDelegations(): PortableDelegation[];
  /**
   * Verify a SIWE/ReCap (CACAO) delegation addressed to this session key.
   * Only delegations that carry {@link PortableDelegation.siweProof} need it.
   */
  verifySiweDelegation?(input: SiweDelegationVerificationInput): VerifiedSiweDelegation;
}

/** The transport fields a SIWE/ReCap (CACAO) delegation is verified against. */
export interface SiweDelegationVerificationInput {
  readonly authorization: string;
  readonly cid: string;
  /** Primary space of the SIWE session; the signed ReCap must include it. */
  readonly spaceId: string;
  readonly address: string;
  readonly chainId: number;
  readonly siwe: string;
  readonly signature: string;
}

/**
 * Authority read from a SIWE/ReCap delegation after WASM verification.
 *
 * Not guaranteed:
 * - `recap` spaces are what the issuer signed, not proof that the issuer owns
 *   or controls them. The TinyCloud node enforces that on activation and
 *   invocation; a caller that needs an owner binding must compare each space
 *   owner to `issuer` itself.
 * - `expiry` is `undefined` when the SIWE has no `Expiration Time`. Callers
 *   must refuse or bound such a delegation;
 *   {@link activateValidatedRuntimeDelegation} refuses it.
 */
export interface VerifiedSiweDelegation {
  /** `did:pkh` of the wallet that signed the SIWE. */
  readonly issuer: string;
  /** The session key the SIWE addresses, which is the verifying node's key. */
  readonly audience: string;
  /** Signed `Expiration Time`; `undefined` when the SIWE has none. */
  readonly expiry?: Date;
  /** One verified ReCap entry per signed action (short service names, full space IDs). */
  readonly recap: readonly VerifiedSiweRecapEntry[];
}

export interface VerifiedSiweRecapEntry {
  readonly service: string;
  readonly space: string;
  readonly path: string;
  readonly actions: readonly string[];
  readonly caveats: readonly Record<string, unknown>[];
}

/** Input for {@link siweRuntimeDelegation}. */
export interface SiweRuntimeDelegationInput {
  readonly authorization: string;
  readonly cid: string;
  readonly spaceId: string;
  readonly ownerAddress: string;
  readonly chainId: number;
  readonly siwe: string;
  readonly signature: string;
  readonly host: string;
}

/** The node surface {@link siweRuntimeDelegation} needs to verify a CACAO. */
export interface SiweDelegationVerifier {
  computeDelegationCid(authorization: string): string;
  verifySiweDelegation(input: SiweDelegationVerificationInput): VerifiedSiweDelegation;
}

/** The installed authority returned by {@link activateValidatedRuntimeDelegation}. */
export interface ValidatedRuntimeDelegation {
  /** CID recomputed from the signed authorization bytes. */
  readonly cid: string;
  /** The authority object installed by the node runtime. */
  readonly delegation: PortableDelegation;
  /** Capabilities read from the signed compact UCAN attenuation or SIWE ReCap. */
  readonly effectivePermissions: readonly PermissionEntry[];
  /** Expiry read from the signed compact UCAN payload or SIWE. */
  readonly expiry: Date;
  /** Audience read from the signed compact UCAN payload or SIWE. */
  readonly audience: string;
  /** Host selected for, and used by, the runtime activation. */
  readonly host: string;
}

export interface CompactRuntimeDelegationInput {
  readonly authorization: string;
  readonly cid: string;
  readonly host: string;
  readonly ownerAddress: string;
  readonly chainId: number;
}

interface SignedRuntimeAuthority {
  readonly issuer: string;
  readonly audience: string;
  readonly expiry: Date;
  readonly proofs: readonly string[];
  readonly remainingRedelegationDepth?: number;
  readonly permissions: readonly PermissionEntry[];
  readonly resources: readonly DelegatedResource[];
}

const SERVICE_BY_SHORT_NAME: Record<string, string> = {
  kv: "tinycloud.kv",
  sql: "tinycloud.sql",
  duckdb: "tinycloud.duckdb",
  hooks: "tinycloud.hooks",
};

function authorizationWithoutBearer(authorization: string): string {
  return authorization.replace(/^Bearer /i, "");
}

function normalizedHost(host: string): string {
  if (typeof host !== "string" || host.length === 0) {
    throw new Error("Validated runtime delegation requires a non-empty host.");
  }
  return host.replace(/\/+$/, "");
}

function didPrincipalsMatch(left: string, right: string): boolean {
  try {
    return principalDidEquals(left, right);
  } catch {
    return left === right;
  }
}

function compactUcanPayload(authorization: string): Record<string, unknown> {
  const compact = authorizationWithoutBearer(authorization);
  const parts = compact.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error(
      "Validated runtime delegation requires a compact UCAN authorization so its signed authority can be derived.",
    );
  }
  try {
    const payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(parts[1]!)),
    ) as unknown;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("payload is not an object");
    }
    return payload as Record<string, unknown>;
  } catch {
    throw new Error(
      "Validated runtime delegation authorization has an invalid compact UCAN payload.",
    );
  }
}

function canonicalPermissionEntries(
  permissions: PermissionEntry[],
): PermissionEntry[] {
  return permissions
    .map((permission) => ({
      ...permission,
      actions: [...permission.actions].sort(),
    }))
    .sort((left, right) =>
      left.service.localeCompare(right.service) ||
      (left.space ?? "").localeCompare(right.space ?? "") ||
      left.path.localeCompare(right.path) ||
      left.actions.join("\u0000").localeCompare(right.actions.join("\u0000")) ||
      canonicalizeRecapCaveats(left.caveats).localeCompare(canonicalizeRecapCaveats(right.caveats)),
    );
}

function signedCaveats(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value) || value.some((caveat) =>
    caveat === null || typeof caveat !== "object" || Array.isArray(caveat)
  )) {
    throw new Error("Validated runtime delegation has malformed signed ReCap caveats.");
  }
  const cloned = JSON.parse(JSON.stringify(value)) as Record<string, unknown>[];
  return canonicalizeRecapCaveats(cloned) === canonicalizeRecapCaveats(undefined)
    ? undefined
    : cloned;
}

function groupedSignedEntries(
  service: string,
  space: string | undefined,
  path: string,
  abilities: Record<string, unknown>,
): PermissionEntry[] {
  const groups = new Map<string, { actions: string[]; caveats?: Record<string, unknown>[] }>();
  for (const [action, rawCaveats] of Object.entries(abilities)) {
    const caveats = signedCaveats(rawCaveats);
    const identity = canonicalizeRecapCaveats(caveats);
    const group = groups.get(identity) ?? { actions: [], caveats };
    group.actions.push(action);
    groups.set(identity, group);
  }
  return [...groups.values()].map((group) => ({
    service,
    ...(space === undefined ? {} : { space }),
    path,
    actions: group.actions.sort(),
    ...(group.caveats === undefined ? {} : { caveats: group.caveats }),
  }));
}

function signedAuthorityFromCompactUcan(
  authorization: string,
): SignedRuntimeAuthority {
  const payload = compactUcanPayload(authorization);
  if (typeof payload.aud !== "string" || payload.aud.length === 0) {
    throw new Error("Validated runtime delegation is missing a signed audience.");
  }
  if (typeof payload.iss !== "string" || payload.iss.length === 0) {
    throw new Error("Validated runtime delegation is missing a signed issuer.");
  }
  if (!Array.isArray(payload.prf) || payload.prf.some((proof) =>
    typeof proof !== "string" || proof.length === 0
  )) {
    throw new Error("Validated runtime delegation has malformed signed proofs.");
  }
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new Error("Validated runtime delegation is missing a signed expiry.");
  }
  const expiry = new Date(payload.exp * 1000);
  if (Number.isNaN(expiry.getTime())) {
    throw new Error("Validated runtime delegation has an invalid signed expiry.");
  }
  if (payload.att === null || typeof payload.att !== "object" || Array.isArray(payload.att)) {
    throw new Error("Validated runtime delegation is missing a signed attenuation.");
  }
  const fact = Array.isArray(payload.fct) && payload.fct.length > 0 &&
      payload.fct[0] !== null && typeof payload.fct[0] === "object" &&
      !Array.isArray(payload.fct[0])
    ? payload.fct[0] as Record<string, unknown>
    : undefined;
  const remainingRedelegationDepth = fact?.remainingRedelegationDepth;
  if (
    remainingRedelegationDepth !== undefined &&
    (!Number.isInteger(remainingRedelegationDepth) ||
      (remainingRedelegationDepth as number) < 0 ||
      (remainingRedelegationDepth as number) > 8)
  ) {
    throw new Error("Validated runtime delegation has invalid signed redelegation depth.");
  }

  const permissions: PermissionEntry[] = [];
  for (const [resource, abilities] of Object.entries(payload.att)) {
    if (abilities === null || typeof abilities !== "object" || Array.isArray(abilities)) {
      throw new Error("Validated runtime delegation has an invalid signed attenuation.");
    }
    const abilityEntries = Object.entries(abilities as Record<string, unknown>);
    if (abilityEntries.length === 0) {
      throw new Error("Validated runtime delegation has an empty signed capability.");
    }

    if (resource.startsWith("urn:tinycloud:encryption:")) {
      permissions.push(...groupedSignedEntries(
        "tinycloud.encryption",
        undefined,
        resource,
        abilities as Record<string, unknown>,
      ));
      continue;
    }

    const nativeMatch = /^(tinycloud:[^/]+)\/(kv|sql|duckdb|hooks)\/(.*)$/.exec(resource);
    const policyMatch = /^tinycloud:\/\/([^/]+)\/(kv|sql|duckdb|hooks)\/(.*)$/.exec(resource);
    const match = nativeMatch ?? policyMatch;
    if (!match) {
      throw new Error(
        `Validated runtime delegation has an unsupported signed resource '${resource}'.`,
      );
    }
    const [, space, shortService, path] = match;
    const service = SERVICE_BY_SHORT_NAME[shortService!];
    if (service === undefined) {
      throw new Error(
        `Validated runtime delegation has an unsupported signed service '${shortService}'.`,
      );
    }
    permissions.push(...groupedSignedEntries(
      service,
      space!,
      path!,
      abilities as Record<string, unknown>,
    ));
  }

  return signedRuntimeAuthority({
    issuer: payload.iss,
    audience: payload.aud,
    expiry,
    proofs: [...payload.prf],
    ...(remainingRedelegationDepth === undefined
      ? {}
      : { remainingRedelegationDepth: remainingRedelegationDepth as number }),
  }, permissions);
}

/**
 * Derive the authority of a SIWE/ReCap (CACAO) delegation. The node verifies
 * the wallet signature, that the SIWE addresses its own session key, its
 * validity window, the ReCap binding, and that the authorization bytes and
 * CID are exactly the CACAO built from that SIWE.
 */
function signedAuthorityFromSiweDelegation(
  node: Pick<RuntimeDelegationActivator, "verifySiweDelegation">,
  input: SiweDelegationVerificationInput,
): SignedRuntimeAuthority {
  if (typeof input.siwe !== "string" || typeof input.signature !== "string") {
    throw new Error("Validated runtime delegation has a malformed SIWE proof.");
  }
  if (typeof node.verifySiweDelegation !== "function") {
    throw new Error("This runtime cannot verify a SIWE delegation.");
  }
  const verified = node.verifySiweDelegation(input);
  if (!(verified.expiry instanceof Date) || Number.isNaN(verified.expiry.getTime())) {
    throw new Error("Validated runtime delegation is missing a signed expiry.");
  }

  // The verifier emits one entry per action; regroup them per resource so
  // actions sharing a caveat set form one entry, as on the compact path.
  const resources = new Map<string, {
    service: string;
    space: string | undefined;
    path: string;
    abilities: Record<string, unknown>;
  }>();
  for (const entry of verified.recap) {
    const service = entry.service === "encryption"
      ? "tinycloud.encryption"
      : Object.prototype.hasOwnProperty.call(SERVICE_BY_SHORT_NAME, entry.service)
      ? SERVICE_BY_SHORT_NAME[entry.service]
      : undefined;
    if (service === undefined) {
      throw new Error(
        `Validated runtime delegation has an unsupported signed service '${entry.service}'.`,
      );
    }
    const space = service === "tinycloud.encryption" ? undefined : entry.space;
    const key = JSON.stringify([service, space ?? null, entry.path]);
    const resource = resources.get(key) ??
      { service, space, path: entry.path, abilities: Object.create(null) as Record<string, unknown> };
    for (const action of entry.actions) {
      if (Object.prototype.hasOwnProperty.call(resource.abilities, action)) {
        throw new Error("Validated runtime delegation repeats a signed capability.");
      }
      resource.abilities[action] = [...entry.caveats];
    }
    resources.set(key, resource);
  }
  const permissions = [...resources.values()].flatMap((resource) =>
    groupedSignedEntries(resource.service, resource.space, resource.path, resource.abilities)
  );
  return signedRuntimeAuthority({
    issuer: verified.issuer,
    audience: verified.audience,
    expiry: verified.expiry,
    proofs: [],
  }, permissions);
}

function signedRuntimeAuthority(
  signed: Omit<SignedRuntimeAuthority, "permissions" | "resources">,
  permissions: PermissionEntry[],
): SignedRuntimeAuthority {
  if (permissions.length === 0) {
    throw new Error("Validated runtime delegation has no signed capabilities.");
  }
  const canonicalPermissions = canonicalPermissionEntries(permissions);
  const canonicalResources = canonicalPermissions.map((permission) => ({
    service:
      permission.service === "tinycloud.encryption"
        ? "encryption"
        : permission.service.slice("tinycloud.".length),
    space:
      permission.service === "tinycloud.encryption"
        ? "encryption"
        : permission.space!,
    path: permission.path,
    actions: [...permission.actions],
    ...(permission.caveats === undefined ? {} : { caveats: permission.caveats }),
  }));
  return { ...signed, permissions: canonicalPermissions, resources: canonicalResources };
}

function canonicalResourcesFromPortableDelegation(
  delegation: PortableDelegation,
): DelegatedResource[] {
  if (delegation.resources !== undefined && delegation.resources.length > 0) {
    return delegation.resources
      .map((resource) => ({ ...resource, actions: [...resource.actions].sort() }))
      .sort((left, right) =>
        left.service.localeCompare(right.service) ||
        left.space.localeCompare(right.space) ||
        left.path.localeCompare(right.path) ||
        left.actions.join("\u0000").localeCompare(right.actions.join("\u0000")) ||
        canonicalizeRecapCaveats(left.caveats).localeCompare(canonicalizeRecapCaveats(right.caveats)),
      );
  }
  const byService = new Map<string, string[]>();
  for (const action of delegation.actions) {
    const [service] = action.split("/", 1);
    const shortService = service!.replace(/^tinycloud\./, "");
    const values = byService.get(shortService) ?? [];
    values.push(action);
    byService.set(shortService, values);
  }
  return [...byService.entries()]
    .map(([service, actions]) => ({
      service,
      space: service === "encryption" ? "encryption" : delegation.spaceId,
      path: delegation.path,
      actions: [...new Set(actions)].sort(),
      ...(delegation.caveats === undefined ? {} : { caveats: delegation.caveats }),
    }))
    .sort((left, right) =>
      left.service.localeCompare(right.service) ||
      left.space.localeCompare(right.space) ||
      left.path.localeCompare(right.path),
    );
}

function resourcesMatch(
  actual: readonly DelegatedResource[],
  expected: readonly DelegatedResource[],
): boolean {
  const comparable = (resource: DelegatedResource) => ({
    ...resource,
    caveats: canonicalizeRecapCaveats(resource.caveats),
  });
  return JSON.stringify(actual.map(comparable)) === JSON.stringify(expected.map(comparable));
}

/**
 * CID-bind and activate one runtime delegation.
 *
 * The helper derives audience, expiry, and effective permissions from signed
 * bytes: the compact UCAN's payload, or, for a delegation carrying a
 * {@link PortableDelegation.siweProof}, the WASM-verified SIWE behind its
 * CACAO. It verifies the transport fields agree, then invokes
 * {@link TinyCloudNode.useRuntimeDelegation}. The node activation call
 * remains the authority and delegation-chain validation boundary.
 *
 * `options.authorize`, when given, sees the signed capabilities before
 * anything is activated or installed; returning `false` refuses the
 * delegation.
 */
export async function activateValidatedRuntimeDelegation(
  node: RuntimeDelegationActivator,
  delegation: PortableDelegation,
  options: {
    host: string;
    authorize?: (effectivePermissions: readonly PermissionEntry[]) => boolean;
  },
): Promise<ValidatedRuntimeDelegation> {
  const host = normalizedHost(options.host);
  if (delegation.host !== undefined && normalizedHost(delegation.host) !== host) {
    throw new Error(
      `Runtime delegation host '${delegation.host}' does not match expected host '${options.host}'.`,
    );
  }
  if (!(delegation.expiry instanceof Date) || Number.isNaN(delegation.expiry.getTime())) {
    throw new Error("Runtime delegation has an invalid expiry.");
  }
  if (delegation.expiry.getTime() <= Date.now()) {
    throw new Error("Runtime delegation is expired.");
  }

  const authorization = delegation.delegationHeader?.Authorization;
  if (typeof authorization !== "string" || authorization.length === 0) {
    throw new Error("Runtime delegation is missing authorization bytes.");
  }
  const cid = node.computeDelegationCid(authorization);
  if (cid !== delegation.cid) {
    throw new Error("Runtime delegation CID does not match authorization bytes.");
  }

  const siweProof = delegation.siweProof;
  const signed = siweProof === undefined
    ? signedAuthorityFromCompactUcan(authorization)
    : signedAuthorityFromSiweDelegation(node, {
      authorization,
      cid,
      spaceId: delegation.spaceId,
      address: delegation.ownerAddress,
      chainId: delegation.chainId,
      siwe: siweProof.siwe,
      signature: siweProof.signature,
    });
  if (signed.expiry.getTime() <= Date.now()) {
    throw new Error("Runtime delegation is expired.");
  }
  if (delegation.expiry.getTime() !== signed.expiry.getTime()) {
    throw new Error("Runtime delegation expiry does not match signed authority.");
  }
  if (!didPrincipalsMatch(signed.audience, node.sessionDid)) {
    throw new Error(
      `Runtime delegation targets ${signed.audience} but this session is ${node.sessionDid}.`,
    );
  }
  if (!didPrincipalsMatch(delegation.delegateDID, signed.audience)) {
    throw new Error("Runtime delegation audience does not match signed authority.");
  }

  const declaredResources = canonicalResourcesFromPortableDelegation(delegation);
  if (!resourcesMatch(declaredResources, signed.resources)) {
    throw new Error("Runtime delegation resources do not match signed authority.");
  }
  if (options.authorize !== undefined && !options.authorize(signed.permissions)) {
    throw new Error("Runtime delegation is not authorized for this runtime.");
  }
  const previouslyInstalled = node
    .getRuntimePermissionDelegations()
    .find((candidate) => candidate.cid === cid);
  if (
    previouslyInstalled !== undefined &&
    previouslyInstalled.delegationHeader.Authorization !== authorization
  ) {
    throw new Error(
      "A different authorization is already installed for this runtime delegation CID.",
    );
  }
  const primary = signed.resources[0]!;
  const signedSpace = signed.permissions.find(
    (permission) => permission.service !== "tinycloud.encryption",
  )?.space;
  const installedCandidate: PortableDelegation = {
    cid,
    delegationHeader: { Authorization: authorization },
    ownerAddress: delegation.ownerAddress,
    chainId: delegation.chainId,
    delegatorDID: signed.issuer,
    ...(signed.proofs.length === 1 ? { parentCid: signed.proofs[0] } : {}),
    ...(signed.remainingRedelegationDepth === undefined
      ? {}
      : {
          allowSubDelegation: signed.remainingRedelegationDepth > 0,
          disableSubDelegation: signed.remainingRedelegationDepth === 0,
        }),
    authHeader: authorization,
    spaceId: signedSpace ?? delegation.spaceId,
    path: primary.path,
    actions: [...primary.actions],
    ...(primary.caveats === undefined ? {} : { caveats: primary.caveats }),
    resources: signed.resources.map((resource) => ({
      ...resource,
      actions: [...resource.actions],
    })),
    expiry: new Date(signed.expiry),
    delegateDID: signed.audience,
    host,
    ...(siweProof === undefined
      ? {}
      : { siweProof: { siwe: siweProof.siwe, signature: siweProof.signature } }),
  };

  if (
    node.isSessionOnly === true &&
    typeof node.did === "string" &&
    principalDidEquals(node.did, node.sessionDid) &&
    typeof node.useDelegation === "function"
  ) {
    await node.useDelegation(installedCandidate);
  } else {
    await node.useRuntimeDelegation(installedCandidate);
  }
  const installed = node
    .getRuntimePermissionDelegations()
    .find((candidate) => candidate.cid === cid);
  if (!installed) {
    throw new Error("Runtime delegation activation did not install the validated authority.");
  }
  if (
    installed.delegationHeader.Authorization !== authorization ||
    !didPrincipalsMatch(installed.delegateDID, signed.audience) ||
    installed.expiry.getTime() !== signed.expiry.getTime() ||
    !resourcesMatch(
      canonicalResourcesFromPortableDelegation(installed),
      signed.resources,
    ) ||
    normalizedHost(installed.host ?? "") !== host
  ) {
    throw new Error(
      "Runtime delegation activation installed authority that differs from the validated authority.",
    );
  }

  return {
    cid,
    delegation: installed,
    effectivePermissions: signed.permissions,
    expiry: new Date(signed.expiry),
    audience: signed.audience,
    host: normalizedHost(installed.host ?? host),
  };
}

/**
 * Import compact UCAN bytes returned by an authority ceremony through the
 * ordinary runtime-delegation activation path. All transport projections are
 * derived from signed bytes before `/delegate` is called.
 */
export async function activateCompactRuntimeDelegation(
  node: RuntimeDelegationActivator,
  input: CompactRuntimeDelegationInput,
): Promise<ValidatedRuntimeDelegation> {
  const authorization = input.authorization;
  const cid = node.computeDelegationCid(authorization);
  if (cid !== input.cid) {
    throw new Error("Compact runtime delegation CID does not match authorization bytes.");
  }
  const signed = signedAuthorityFromCompactUcan(authorization);
  return activateValidatedRuntimeDelegation(
    node,
    portableFromSignedAuthority(cid, authorization, signed, input),
    { host: input.host },
  );
}

/**
 * Project a SIWE/ReCap (CACAO) delegation addressed to this node's session
 * key, such as an OpenKey signed-login approval, into a
 * {@link PortableDelegation}. Every projected field comes from the
 * WASM-verified SIWE, and {@link activateValidatedRuntimeDelegation}
 * verifies it again before installing it.
 */
export function siweRuntimeDelegation(
  node: SiweDelegationVerifier,
  input: SiweRuntimeDelegationInput,
): PortableDelegation {
  const cid = node.computeDelegationCid(input.authorization);
  if (cid !== input.cid) {
    throw new Error("SIWE runtime delegation CID does not match authorization bytes.");
  }
  const proof = { siwe: input.siwe, signature: input.signature };
  const signed = signedAuthorityFromSiweDelegation(node, {
    ...proof,
    authorization: input.authorization,
    cid,
    spaceId: input.spaceId,
    address: input.ownerAddress,
    chainId: input.chainId,
  });
  return {
    ...portableFromSignedAuthority(cid, input.authorization, signed, input),
    siweProof: proof,
  };
}

function portableFromSignedAuthority(
  cid: string,
  authorization: string,
  signed: SignedRuntimeAuthority,
  transport: { readonly ownerAddress: string; readonly chainId: number; readonly host: string },
): PortableDelegation {
  const primary = signed.resources[0]!;
  const signedSpace = signed.permissions.find(
    (permission) => permission.service !== "tinycloud.encryption",
  )?.space;
  return {
    cid,
    delegationHeader: { Authorization: authorization },
    ownerAddress: transport.ownerAddress,
    chainId: transport.chainId,
    delegatorDID: signed.issuer,
    authHeader: authorization,
    spaceId: signedSpace ?? primary.space,
    path: primary.path,
    actions: [...primary.actions],
    ...(primary.caveats === undefined ? {} : { caveats: primary.caveats }),
    resources: signed.resources.map((resource) => ({
      ...resource,
      actions: [...resource.actions],
    })),
    expiry: new Date(signed.expiry),
    delegateDID: signed.audience,
    host: normalizedHost(transport.host),
  };
}

/**
 * Turn a delegation REQUEST into a signed GRANT.
 *
 * Lifts the body of `tc auth grant` into the SDK so the request→grant
 * handshake is callable programmatically (future SDK/web owner tooling and the
 * KV delegation inbox), with the CLI verb reduced to a thin wrapper. The owner
 * `authority` (a `TinyCloudNode`) signs a delegation scoped to exactly the
 * requested caps, audienced to the requester's `sessionDid`, honoring the
 * request's expiry. The returned artifact round-trips through `tc auth import`.
 *
 * Authorization is enforced cryptographically by `delegateTo`: caps that are
 * not derivable from the owner's own session capability chain are rejected
 * (it throws), so this never widens authority the owner doesn't hold.
 */
export async function grantAuthRequest(
  authority: DelegationAuthority,
  request: AuthRequestArtifact,
  options?: { expiry?: string | number },
): Promise<AuthDelegationArtifact> {
  if (request.kind !== "tinycloud.auth.request") {
    throw new Error(
      `grantAuthRequest expects a tinycloud.auth.request artifact, got "${request.kind}".`,
    );
  }
  if (!Array.isArray(request.requested) || request.requested.length === 0) {
    throw new Error("grantAuthRequest request has no requested capabilities.");
  }

  const expiry = options?.expiry ?? request.requestedExpiry;
  const result = await authority.delegateTo(
    request.sessionDid,
    request.requested,
    expiry !== undefined ? { expiry } : undefined,
  );

  return {
    kind: "tinycloud.auth.delegation",
    version: 1,
    requestId: request.requestId,
    delegationCid: result.delegation.cid,
    delegation: result.delegation,
    permissions: request.requested,
    expiry: result.delegation.expiry.toISOString(),
    prompted: result.prompted,
  };
}

/**
 * Serialize a PortableDelegation for transport (e.g., over network).
 */
export function serializeDelegation(delegation: PortableDelegation): string {
  return JSON.stringify({
    ...delegation,
    expiry: delegation.expiry.toISOString(),
  });
}

/**
 * Deserialize a PortableDelegation from transport.
 */
export function deserializeDelegation(data: string): PortableDelegation {
  const parsed = JSON.parse(data);
  return {
    ...parsed,
    cid: parsed.cid,
    expiry: new Date(parsed.expiry),
  };
}
