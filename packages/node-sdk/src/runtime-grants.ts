/**
 * The signing half of `TinyCloudNode.grantRuntimePermissions`: one SIWE for
 * every requested space, one activation, per-space delegations. Loaded on the
 * first grant that needs a signature. The root passes the session state and
 * helpers it needs through {@link RuntimeGrantPorts}; library values (SIWE,
 * address and space parsing, expiry, signature check, error classes) come from
 * the root too, so this file carries no copy of them and `instanceof` matches
 * what callers import.
 */
import type {
  AbilitiesMap,
  DelegatedResource,
  ISigner,
  IWasmBindings,
  NodeNotFoundError,
  PermissionEntry,
  ServiceSession,
  SpaceHostResult,
  TinyCloudSession,
  assertExpiryWithinTechnicalLimit,
  canonicalizeAddress,
  parseSpaceUri,
  verifyEip191MessageSignature,
} from "@tinycloud/sdk-core";
import type { PartialNodeWriteError, ResourceNotRoutedError } from "@tinycloud/sdk-services";
import type { SiweMessage } from "siwe";
import type { resolveExpiryMs, wholeSecondExpiry } from "./delegateToHelpers";
import type { MissingSpacesError, PortableDelegation } from "./delegation";
import type { RuntimePermissionGrantOptions } from "./TinyCloudNode";

export interface RuntimeGrantPorts<Operation> {
  wasm: Pick<IWasmBindings, "prepareSession" | "ensureEip55" | "completeSessionSetup">;
  domain: string;
  host: string | undefined;
  signer: ISigner | null;
  lib: {
    Siwe: typeof SiweMessage;
    canonicalizeAddress: typeof canonicalizeAddress;
    parseSpaceUri: typeof parseSpaceUri;
    verifySignature: typeof verifyEip191MessageSignature;
    expiryMs: typeof resolveExpiryMs;
    wholeSecond: typeof wholeSecondExpiry;
    assertExpiry: typeof assertExpiryWithinTechnicalLimit;
    describeFailure(result: SpaceHostResult): string;
    MissingSpaces: typeof MissingSpacesError;
    NodeNotFound: typeof NodeNotFoundError;
    PartialNodeWrite: typeof PartialNodeWriteError;
    ResourceNotRouted: typeof ResourceNotRoutedError;
  };
  assertCaveats(entries: PermissionEntry[]): void;
  isEncryption(entry: PermissionEntry): boolean;
  isRawRevocation(entry: PermissionEntry): boolean;
  resolveSpace(space: string | undefined, session: TinyCloudSession): string;
  abilities(entries: PermissionEntry[]): AbilitiesMap;
  resources(entries: PermissionEntry[], spaceId: string): DelegatedResource[];
  activationResources(delegation: PortableDelegation): string[];
  activate(
    delegationHeader: TinyCloudSession["delegationHeader"],
    resources: Iterable<string>,
    signal: AbortSignal,
  ): Promise<SpaceHostResult>;
  spaceIdsEqual(a: string, b: string): boolean;
  operations(entries: PermissionEntry[], spaceId: string): Operation[];
  install(grant: {
    session: ServiceSession;
    delegation: PortableDelegation;
    operations: Operation[];
    expiresAt: Date;
    provenance: "runtime";
  }): void;
}

export interface RuntimeGrantRequest {
  graph: { readonly signal: AbortSignal; assertActive(): void };
  session: TinyCloudSession;
  sessionExpiry: Date | undefined;
  /** The requested entries, expanded, none already covered by the session or an installed grant. */
  expanded: PermissionEntry[];
  options: RuntimePermissionGrantOptions | undefined;
}

export async function issueRuntimeGrants<Operation>(
  ports: RuntimeGrantPorts<Operation>,
  { graph, session, sessionExpiry, expanded, options }: RuntimeGrantRequest,
): Promise<PortableDelegation[]> {
  const { lib } = ports;
  if (!ports.signer && options?.signMessage === undefined) {
    throw new Error(
      "grantRuntimePermissions requires wallet mode with a signer or privateKey.",
    );
  }
  ports.assertCaveats(expanded);

  const rawEntries = expanded.filter((entry) =>
    ports.isEncryption(entry) || ports.isRawRevocation(entry)
  );
  const spaceEntries = expanded.filter((entry) =>
    !ports.isEncryption(entry) && !ports.isRawRevocation(entry)
  );

  const bySpace = new Map<string, PermissionEntry[]>();
  for (const entry of spaceEntries) {
    const spaceId = ports.resolveSpace(entry.space, session);
    const current = bySpace.get(spaceId) ?? [];
    current.push(entry);
    bySpace.set(spaceId, current);
  }
  if (bySpace.size === 0 && rawEntries.length > 0) {
    bySpace.set(session.spaceId, []);
  }
  // The grant is a root SIWE from this account, so it can only authorize
  // the account's own spaces; refuse before asking for a signature.
  const foreignSpaces = [...bySpace.keys()].filter((spaceId) => {
    const parsed = lib.parseSpaceUri(spaceId);
    return parsed?.address === undefined ||
      parsed.chainId !== String(session.chainId) ||
      parsed.address !== lib.canonicalizeAddress(session.address);
  });
  if (foreignSpaces.length > 0) {
    throw Object.assign(
      new Error(`Runtime permissions can only be granted in this account's own spaces, not ${foreignSpaces.join(", ")}.`),
      { code: "SPACE_NOT_OWNED", spaceIds: foreignSpaces },
    );
  }

  const now = new Date();
  const requestedExpiryMs = lib.expiryMs(options?.expiry);
  let expiresAt = new Date(now.getTime() + requestedExpiryMs);
  if (sessionExpiry !== undefined && sessionExpiry < expiresAt) {
    // At the session's expiry, to the whole second: the node compares a child's expiry with its parent's.
    expiresAt = lib.wholeSecond(sessionExpiry);
  }
  lib.assertExpiry(expiresAt, "siwe");

  // One SIWE covers every requested space (per-space abilities in one
  // ReCap) plus the raw resources, so the owner approves once.
  const spaces = [...bySpace.keys()];
  const primarySpaceId = spaces[0]!;
  const spaceAbilities = Object.fromEntries(
    [...bySpace].map(([spaceId, entries]) => [spaceId, ports.abilities(entries)]),
  );
  const prepared = (() => {
    try {
      return ports.wasm.prepareSession({
        abilities: spaceAbilities[primarySpaceId]!,
        ...(spaces.length > 1 ? { spaceAbilities } : {}),
        ...(rawEntries.length > 0
          ? { rawAbilities: rawAbilities(ports, rawEntries) }
          : {}),
        address: ports.wasm.ensureEip55(session.address),
        chainId: session.chainId,
        domain: ports.domain,
        issuedAt: now.toISOString(),
        expirationTime: expiresAt.toISOString(),
        spaceId: primarySpaceId,
        jwk: session.jwk,
      });
    } catch (error) {
      if (
        rawEntries.some((entry) => ports.isRawRevocation(entry)) &&
        /invalid ReCap resource URI/i.test(error instanceof Error ? error.message : String(error))
      ) {
        throw Object.assign(
          new Error("This WASM build cannot encode raw urn:cid ReCap resources."),
          { code: "RAW_RECAP_RESOURCE_UNSUPPORTED", cause: error },
        );
      }
      throw error;
    }
  })();

  if (options?.signMessage !== undefined) {
    assertGrantMessage(lib, prepared.siwe, session);
  }
  const signature = options?.signMessage !== undefined
    ? await options.signMessage(prepared.siwe)
    : await ports.signer!.signMessage(prepared.siwe);
  if (
    options?.signMessage !== undefined &&
    !(await lib.verifySignature(prepared.siwe, signature, session.address))
  ) {
    throw new Error("The signature does not match the account that owns this session.");
  }
  // Nothing is activated for a session that ended while the wallet signed.
  graph.assertActive();
  const delegatedSession = ports.wasm.completeSessionSetup({
    ...prepared,
    signature,
  });
  // One portable delegation per space, all proven by the one signed session
  // (one cid; revoking any revokes all). The raw resources ride with the
  // first space that turns out to exist.
  const delegationFor = (spaceId: string, entries: PermissionEntry[]): PortableDelegation => {
    const resources = ports.resources(entries, spaceId);
    const primary = resources[0]!;
    return {
      cid: delegatedSession.delegationCid,
      delegationHeader: delegatedSession.delegationHeader,
      spaceId,
      path: primary.path,
      actions: primary.actions,
      resources,
      disableSubDelegation: false,
      expiry: expiresAt,
      delegateDID: session.verificationMethod,
      ownerAddress: session.address,
      chainId: session.chainId,
      host: ports.host,
      siweProof: { siwe: prepared.siwe, signature },
    };
  };

  const activateResult = await ports.activate(
    delegatedSession.delegationHeader,
    spaces.flatMap((spaceId, index) =>
      ports.activationResources(delegationFor(spaceId, [...bySpace.get(spaceId)!, ...(index === 0 ? rawEntries : [])]))),
    graph.signal,
  ).catch((error: unknown) => {
    graph.assertActive();
    // A routed space its node skipped, among several nodes: keep the routing fault.
    const routingFault = error instanceof lib.PartialNodeWrite
      ? error.failed.find(({ cause }) => cause instanceof lib.ResourceNotRouted)?.cause
      : undefined;
    if (routingFault !== undefined) throw routingFault;
    // A registered owner whose signed record lists none of the requested
    // spaces: no node serves them because they were never set up.
    const requested = spaces.filter((spaceId) => bySpace.get(spaceId)!.length > 0);
    const listed = error instanceof lib.NodeNotFound && error.verdict.status === "registered"
      ? error.verdict.record?.spaces.map(({ space }) => space)
      : undefined;
    if (
      listed !== undefined &&
      rawEntries.length === 0 &&
      requested.length > 0 &&
      requested.every((spaceId) => !listed.some((space) => ports.spaceIdsEqual(space, spaceId)))
    ) {
      throw new lib.MissingSpaces(requested, []);
    }
    throw error;
  });
  // The node attaches a delegation only to spaces it hosts; it reports the
  // rest as skipped (or refuses with 404 when it hosts none). Activation
  // never creates a space. A skipped space the registry routes to that node
  // already failed above as RESOURCE_NOT_ROUTED (a routing fault); what is
  // left in `skipped` has no location record, i.e. was never set up.
  const missingSpaceIds = activateResult.success
    ? spaces.filter((spaceId) => bySpace.get(spaceId)!.length > 0 &&
      activateResult.skipped?.some((skipped) => ports.spaceIdsEqual(skipped, spaceId)))
    : activateResult.status === 404 ? spaces.filter((spaceId) => bySpace.get(spaceId)!.length > 0) : [];
  if (!activateResult.success && missingSpaceIds.length === 0) {
    if (
      rawEntries.some((entry) => ports.isRawRevocation(entry)) &&
      activateResult.status === 401 &&
      /Cannot find parent delegation/i.test(activateResult.error ?? "")
    ) {
      throw Object.assign(
        new Error("The host cannot activate a root raw-CID revoke authority without a parent delegation."),
        { code: "RAW_RECAP_RESOURCE_UNSUPPORTED", cause: activateResult },
      );
    }
    throw Object.assign(
      new Error(`Failed to activate runtime permission delegation: ${lib.describeFailure(activateResult)}`),
      { cause: activateResult },
    );
  }

  // The session may have been replaced or signed out while signing.
  graph.assertActive();
  // Raw resources ride only on an activated session: a refused (404) one installs nothing.
  const rawCarrier = activateResult.success
    ? spaces.find((spaceId) => !missingSpaceIds.includes(spaceId)) ?? (rawEntries.length > 0 ? spaces[0] : undefined)
    : undefined;
  const delegations: PortableDelegation[] = [];
  for (const spaceId of spaces) {
    const entries = [
      ...(missingSpaceIds.includes(spaceId) ? [] : bySpace.get(spaceId)!),
      ...(spaceId === rawCarrier ? rawEntries : []),
    ];
    if (entries.length === 0) continue;
    const delegation = delegationFor(spaceId, entries);
    ports.install({
      session: {
        delegationHeader: delegatedSession.delegationHeader,
        delegationCid: delegatedSession.delegationCid,
        spaceId,
        verificationMethod: session.verificationMethod,
        jwk: session.jwk,
      },
      delegation,
      operations: ports.operations(entries, spaceId),
      expiresAt,
      provenance: "runtime",
    });
    delegations.push(delegation);
  }
  if (missingSpaceIds.length > 0) {
    throw new lib.MissingSpaces(missingSpaceIds, delegations);
  }

  return delegations;
}

/**
 * Checks the SIWE text a caller-supplied signer is asked to sign: it must be in canonical form (parsing and
 * re-serializing it gives the same bytes) and name the session's account and chain. The caller then checks the
 * signature against these exact bytes.
 */
function assertGrantMessage(
  lib: RuntimeGrantPorts<unknown>["lib"],
  siwe: string,
  session: TinyCloudSession,
): void {
  let parsed: SiweMessage;
  try {
    parsed = new lib.Siwe(siwe);
  } catch {
    throw new Error("The prepared sign-in message is not a valid SIWE message.");
  }
  if (parsed.prepareMessage() !== siwe) {
    throw new Error("The prepared sign-in message is not in canonical form.");
  }
  if (
    parsed.chainId !== session.chainId ||
    lib.canonicalizeAddress(parsed.address) !== lib.canonicalizeAddress(session.address)
  ) {
    throw new Error("The prepared sign-in message is for a different account or chain than this session.");
  }
}

/** The raw (non-space) abilities of the grant: revoke authority per raw CID, decrypt per encryption network. */
function rawAbilities(
  ports: Pick<RuntimeGrantPorts<unknown>, "isEncryption" | "isRawRevocation">,
  entries: PermissionEntry[],
): Record<string, string[]> {
  const abilities: Record<string, string[]> = {};
  for (const entry of entries) {
    if (ports.isRawRevocation(entry)) {
      abilities[entry.space!] = [...new Set(entry.actions)];
      continue;
    }
    if (!ports.isEncryption(entry)) {
      continue;
    }
    const existing = abilities[entry.path] ?? [];
    const seen = new Set(existing);
    for (const action of entry.actions) {
      if (!seen.has(action)) {
        existing.push(action);
        seen.add(action);
      }
    }
    abilities[entry.path] = existing;
  }
  return abilities;
}
