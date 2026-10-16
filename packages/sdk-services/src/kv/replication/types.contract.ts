import type {
  KVReadThrough,
  KVReplicaHandle,
  LocalReplicaStatus,
  ReplicaInspectedStatus,
  LocalSyncResult,
  PendingWriteStore,
  ReplicaGrantInfo,
  ReplicationReason,
} from "../../index";
import type {
  KVReplicaSpec,
  KVReplicaStorage,
  ReplicaGatedSpec,
  ReplicaGatedHandle,
  ReplicaGatedStorage,
  ReplicationAuthority,
  ReplicationEvent,
  ReplicaStatusEntry,
} from "./types";
import type {
  ReplicaAccountGate,
  ReplicaBrowserGateAccess,
  ReplicaBrowserGateSnapshot,
  ReplicaBrowserGateTx,
  ReplicaClock,
  ReplicaDeliveryDecision,
  ReplicaDenyInput,
  ReplicaDenyOutcome,
  ReplicaEraseReport,
  ReplicaGateAccess,
  ReplicaGateSnapshot,
  ReplicaGateScope,
  ReplicaGateTx,
  ReplicaLifecycleGate,
  ReplicaPartitionIndexEntry,
  ReplicaPrivateGateHash,
  ReplicaSessionStamp,
} from "./lifecycle";
import type { ReplicaAdmitHook, ReplicaBrowserPageAdmission, ReplicaPageAdmission, ReplicaQuotaLedger } from "./quota";
import type { ReplicaConsentAnchor } from "./grantPolicyTypes";
import type { REPLICA_DENY_TOMBSTONE, REPLICA_KV_SCHEMA_VERSION } from "./contractConstants";
import type {
  ProfileReplicaApprovalEntry,
  ProfileReplicaDeferredToken,
  ProfileReplicaLogoutPending,
  ProfileReplicaPreflight,
  ProfileReplicaPurge,
  ProfileReplicaRootIdentity,
  ProfileReplicaUnknownEntry,
} from "./index";

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type HasRequiredKey<T, K extends PropertyKey> = K extends keyof T
  ? {} extends Pick<T, K>
    ? false
    : true
  : false;

type SyncInput = Parameters<KVReplicaHandle["sync"]>[0];
type _SyncStartEpochIsRequired = Assert<HasRequiredKey<SyncInput, "syncStartEpoch">>;
type _SyncStartEpochIsNumber = Assert<Equal<SyncInput["syncStartEpoch"], number>>;
type _SyncResultCarriesEpoch = Assert<
  Equal<Extract<LocalSyncResult, { status: "synced" }>["syncedThroughEpoch"], number>
>;
type _StatusCarriesDurableEpoch = Assert<Equal<LocalReplicaStatus["syncedThroughEpoch"], number>>;
type _GrantStateIsExplicit = Assert<
  Equal<ReplicaGrantInfo["state"], "active" | "pending">
>;
type NetworkObservation = Parameters<KVReadThrough["observeNetworkRequested"]>[0];
type _ObservationReportsReason = Assert<
  Equal<NetworkObservation["reason"], "NETWORK_REQUESTED">
>;
type _ObservationReportsOperation = Assert<Equal<NetworkObservation["op"], "get" | "list">>;
type _ObservationReportsOutcome = Assert<
  Equal<NetworkObservation["outcome"], "found" | "not_found" | "error">
>;
type _ObservationReportsLatency = Assert<Equal<NetworkObservation["latencyMs"], number>>;
type _PendingStoreDeclaresDurability = Assert<HasRequiredKey<PendingWriteStore, "durable">>;
type _PendingStoreDurabilityIsBoolean = Assert<Equal<PendingWriteStore["durable"], boolean>>;
type _UnprovenSinceStartIsAReason = Assert<
  "REPLICA_UNPROVEN_SINCE_START" extends ReplicationReason ? true : false
>;
// Phase 2 contract: fields are optional on the Phase 1 types; the gated types require them.
type _StampIsOptionalOnSpec = Assert<Equal<HasRequiredKey<KVReplicaSpec, "stamp">, false>>;
type _StampFields = Assert<Equal<keyof ReplicaSessionStamp, "incarnation" | "lifecycleEpoch">>;
type _PurgePendingOptional = Assert<Equal<HasRequiredKey<LocalReplicaStatus, "purgePending">, false>>;
type _InspectMayRedact = Assert<
  Equal<
    Awaited<ReturnType<NonNullable<KVReplicaStorage["inspectStatus"]>>>,
    LocalReplicaStatus | ReplicaInspectedStatus | undefined
  >
>;
declare const gatedStorage: ReplicaGatedStorage;
declare const unstampedSpec: KVReplicaSpec;
// @ts-expect-error A Phase 2 adapter cannot accept the unstamped Phase 1 spec.
gatedStorage.open(unstampedSpec);
type _RedactionIsDiscriminated = Assert<Equal<ReplicaInspectedStatus["redacted"], true>>;
type _RedactionOmitsAuthority = Assert<
  Equal<"authority" extends keyof ReplicaInspectedStatus ? true : false, false>
>;
type _RedactionOmitsGrant = Assert<
  Equal<"grant" extends keyof ReplicaInspectedStatus ? true : false, false>
>;
type _RedactionOmitsErrors = Assert<
  Equal<"lastError" extends keyof ReplicaInspectedStatus ? true : false, false>
>;
type _MintExpiryIsDuration = Assert<
  Equal<NonNullable<Parameters<ReplicationAuthority["mint"]>[3]>["expiryMs"], number | undefined>
>;
type _GatedIsAState = Assert<"gated" extends ReplicaStatusEntry["state"] ? true : false>;
type _GatedIsAReason = Assert<"replica_gated" extends ReplicationReason ? true : false>;
// The structural guard: `run` opens the transaction, so `fn` only ever sees a gated `Tx`.
type _GateRunScope = Assert<Equal<Parameters<ReplicaGateTx<"tx">["run"]>[0], ReplicaGateScope>>;
type _GateRunAccess = Assert<Equal<Parameters<ReplicaGateTx<"tx">["run"]>[1], ReplicaGateAccess>>;
type _GateRunFnGetsTx = Assert<
  Equal<Parameters<Parameters<ReplicaGateTx<"tx">["run"]>[2]>[0], "tx">
>;
type _AccessCarriesIncarnation = Assert<HasRequiredKey<ReplicaGateAccess, "incarnation">>;
type _AccessTakesStoredIds = Assert<Equal<ReplicaGateAccess["partitionId"], string | undefined>>;
type _AccessPrehashesPrincipal = Assert<HasRequiredKey<ReplicaGateAccess, "principalHash">>;
type _AccessHasNoRawPrincipal = Assert<
  Equal<"principal" extends keyof ReplicaGateAccess ? true : false, false>
>;
type _BrowserRunRequiresKeyIds = Assert<
  Equal<Parameters<ReplicaGateTx<"tx", ReplicaBrowserGateAccess>["run"]>[1], ReplicaBrowserGateAccess>
>;
type _BrowserAccessRequiresGateKey = Assert<HasRequiredKey<ReplicaBrowserGateAccess, "keyId">>;
type _BrowserAccessRequiresAccountKey = Assert<HasRequiredKey<ReplicaBrowserGateAccess, "accountKeyId">>;
type _BrowserSnapshotCarriesPrivateKey = Assert<
  Equal<ReplicaBrowserGateSnapshot["gateHmac"], CryptoKey>
>;
type _PrivateHashSeparatesLookup = Assert<
  "lookup" extends Parameters<ReplicaPrivateGateHash>[1] ? true : false
>;
type _PartitionIndexHasOpaqueLookup = Assert<HasRequiredKey<ReplicaPartitionIndexEntry, "lookupId">>;
type _PartitionIndexDistinguishesOwner = Assert<
  Equal<ReplicaPartitionIndexEntry["ownerDevice"], boolean>
>;
type _SnapshotShape = Assert<
  Equal<ReplicaGateTx<"tx">["snapshot"], () => Promise<ReplicaGateSnapshot | null>>
>;
type _BrowserSnapshotFromGuard = Assert<
  Equal<
    ReplicaGateTx<"tx", ReplicaBrowserGateAccess, ReplicaBrowserGateSnapshot>["snapshot"],
    () => Promise<ReplicaBrowserGateSnapshot | null>
  >
>;

// sdk-services targets ES2020 without DOM; the browser adapter supplies IDBTransaction.
// This structural surrogate checks snapshot → private HMAC → guarded run without
// importing browser globals into the shared package's type-contract fixture.
type GuardedTransaction = { readonly mode: "readonly" | "readwrite" };
async function browserSnapshotThenRun(
  gateTx: ReplicaBrowserGateTx<GuardedTransaction>,
  stamp: ReplicaSessionStamp,
  privateHash: ReplicaPrivateGateHash,
): Promise<GuardedTransaction["mode"] | undefined> {
  const snapshot = await gateTx.snapshot();
  if (!snapshot) return undefined;
  const principalHash = await privateHash(snapshot.gateHmac, "principal", "did:example:owner");
  return gateTx.run(
    { stores: ["meta"], mode: "readonly" },
    {
      stamp,
      incarnation: snapshot.incarnation,
      principalHash,
      keyId: snapshot.keyId,
      accountKeyId: snapshot.accountKeyId,
    },
    async (tx) => tx.mode,
  );
}
type _NoPublicAssert = Assert<Equal<"assert" extends keyof ReplicaGateTx<"tx"> ? true : false, false>>;
type _AccessStampRequired = Assert<HasRequiredKey<ReplicaGateAccess, "stamp">>;
type _DeliverableStampRequired = Assert<
  Equal<Parameters<ReplicaLifecycleGate["deliverable"]>, [stamp: ReplicaSessionStamp]>
>;
type _PreflightStampRequired = Assert<
  Equal<Parameters<ReplicaLifecycleGate["checkDelivery"]>, [stamp: ReplicaSessionStamp]>
>;
type _PreflightReturnsReason = Assert<
  Equal<ReturnType<ReplicaLifecycleGate["checkDelivery"]>, ReplicaDeliveryDecision>
>;
type _DurableDeadlineMatchesStamp = Assert<
  Equal<ReplicaLifecycleGate["consentDeadline"], (stamp: ReplicaSessionStamp) => number | null>
>;
type _ConsentExpiryDecisionHasCode = Assert<
  Equal<Extract<ReplicaDeliveryDecision, { status: "consent_expired" }>["code"], "CONSENT_EXPIRED">
>;
type _BrowserDeadlineIsPersistent = Assert<Equal<ReplicaAccountGate["consentDeadline"], number | null | undefined>>;
type _RecoveryReportsExpiry = Assert<Equal<ReplicaEraseReport["consentExpired"], boolean | undefined>>;
type _ReplicaClock = Assert<Equal<ReplicaClock, () => number>>;
type _NoCaptureStamp = Assert<
  Equal<"captureSessionStamp" extends keyof ReplicaLifecycleGate ? true : false, false>
>;
type _RestoreTakesPersisted = Assert<
  Equal<Parameters<ReplicaLifecycleGate["restoreSessionStamp"]>[1], ReplicaSessionStamp | undefined>
>;
type _DenyNamesCaller = Assert<HasRequiredKey<ReplicaDenyInput, "principal">>;
type _ExpiryCanDeny = Assert<"consent_expired" extends ReplicaDenyInput["reason"] ? true : false>;
type _EstablishUsesConsentAnchor = Assert<
  Equal<Parameters<ReplicaLifecycleGate["establishSessionStamp"]>[1], { consentAnchor: ReplicaConsentAnchor }>
>;
type _EstablishAnchorIsRequired = Assert<
  HasRequiredKey<Parameters<ReplicaLifecycleGate["establishSessionStamp"]>[1], "consentAnchor">
>;
type _DenyFloorIsStable = Assert<
  Equal<typeof REPLICA_DENY_TOMBSTONE, "tinycloud-replica:deny-tombstone">
>;
type _SealedSchemaVersion = Assert<Equal<typeof REPLICA_KV_SCHEMA_VERSION, 2>>;
type _GatedSpecRequiresStamp = Assert<HasRequiredKey<ReplicaGatedSpec, "stamp">>;
type _GatedSpecRequiresPolicy = Assert<HasRequiredKey<ReplicaGatedSpec, "grantPolicy">>;
type _GatedStorageRequiresLifecycle = Assert<HasRequiredKey<ReplicaGatedStorage, "lifecycle">>;
type _LegacyHandleIdOptional = Assert<Equal<KVReplicaHandle["replicaId"], string | undefined>>;
type _GatedHandleIdRequired = Assert<Equal<ReplicaGatedHandle["replicaId"], string>>;
type _GatedHandleHasStampedSpec = Assert<
  Equal<ReplicaGatedHandle["spec"], ReplicaGatedSpec>
>;
type _GatedOpenReturnsOpaqueId = Assert<
  Equal<Awaited<ReturnType<ReplicaGatedStorage["open"]>>, ReplicaGatedHandle>
>;
type _GrantEventHasNoSpace = Assert<
  Equal<"space" extends keyof Extract<ReplicationEvent, { type: "replication.grant" }> ? true : false, false>
>;
type _LifecycleEventHasNoSpace = Assert<
  Equal<"space" extends keyof Extract<ReplicationEvent, { type: "replication.lifecycle" }> ? true : false, false>
>;
type _LedgerAdmitTakesTx = Assert<Equal<Parameters<ReplicaQuotaLedger<"tx">["admitPage"]>[0], "tx">>;
type _BrowserQuotaAdmitsNetEncodedBytes = Assert<
  Equal<Parameters<ReplicaQuotaLedger<"tx">["admitPage"]>[1], ReplicaBrowserPageAdmission>
>;
type _BrowserQuotaUsesOneDelta = Assert<
  Equal<ReplicaBrowserPageAdmission["deltaBytes"], Parameters<ReplicaQuotaLedger<"tx">["accountCommit"]>[1]["deltaBytes"]>
>;
type _NodeQuotaKeepsExistingShape = Assert<
  Equal<Parameters<ReplicaAdmitHook>[0], ReplicaPageAdmission>
>;
type _PendingStoreTakesStamp = Assert<
  Equal<
    NonNullable<Parameters<NonNullable<KVReplicaStorage["pendingWrites"]>>[1]>["stamp"],
    ReplicaSessionStamp | undefined
  >
>;

// Node/CLI-only deferred revoke: the common browser lifecycle never accepts deferErase.
type _DeferredTokenIsOpaqueFence = Assert<
  Equal<ProfileReplicaDeferredToken, { deniedEpoch: number; principalHash: string }>
>;
type _ProfilePurgeKeepsLifecycleRecovery = Assert<
  ProfileReplicaPurge extends Pick<ReplicaLifecycleGate, "recover" | "erasePending" | "pendingPurge">
    ? true : false
>;
type _ProfileDenyTakesOptionalDeferral = Assert<
  Equal<Parameters<ProfileReplicaPurge["deny"]>[1], { deferErase?: boolean } | undefined>
>;
type _DeferredDenyCarriesToken = Assert<
  Equal<
    ReturnType<ProfileReplicaPurge["deny"]>,
    Promise<ReplicaDenyOutcome & { resumeToken?: ProfileReplicaDeferredToken }>
  >
>;
type _DeferredTokenSurvivesRestart = Assert<
  Equal<ReturnType<ProfileReplicaPurge["deferredErase"]>, Promise<ProfileReplicaDeferredToken | null>>
>;
type _ResumeRequiresSignal = Assert<
  Equal<
    ProfileReplicaPurge["resumeDeferredErase"],
    (token: ProfileReplicaDeferredToken, options: { signal: AbortSignal }) => Promise<ReplicaEraseReport>
  >
>;
type _InventoryEntryIdentity = Assert<
  Equal<ProfileReplicaUnknownEntry, {
    path: string; kind: "file" | "directory" | "symlink"; dev: string; ino: string;
  }>
>;
type _RootIdentity = Assert<
  Equal<ProfileReplicaRootIdentity, { path: string; dev: string; ino: string }>
>;
type _ApprovalEntryDisplaysBoundIdentity = Assert<
  Equal<ProfileReplicaApprovalEntry, {
    path: string; kind: ProfileReplicaUnknownEntry["kind"] | "missing";
    dev: string; ino: string;
  }>
>;
type _PreflightInventoryIsComplete = Assert<
  Equal<ProfileReplicaPreflight, {
    knownLegacyReplicas: number;
    unknownLegacyPaths: string[];
    unknownPaths: string[];
    unknownEntries: ProfileReplicaUnknownEntry[];
    knownRoots: ProfileReplicaRootIdentity[];
    knownEntries: ProfileReplicaUnknownEntry[];
    missingDatabases: string[];
  }>
>;
type ApprovedMarker = {
  principalDigest: string;
  approvalSalt: string;
  discardLocalChanges?: true;
  remotePending?: true;
  remoteAbandoned?: true;
  approvedUnknown: ProfileReplicaUnknownEntry[];
  knownRoots: ProfileReplicaRootIdentity[];
  knownEntries: ProfileReplicaUnknownEntry[];
  missingDatabases: string[];
};
type _LogoutMarkerScopes = Assert<
  Equal<
    ProfileReplicaLogoutPending,
    (
      | { v: 1; incarnation: string; lifecycleEpoch: number; principalHash: string }
      | { v: 2; scope: "orphan_profile"; nonce: string }
      | { v: 3; scope: "inactive_gate"; incarnation: string; lifecycleEpoch: number }
    ) & ApprovedMarker
  >
>;
type _PreflightLogoutIsReadOnly = Assert<
  Equal<
    ProfileReplicaPurge["preflightLogout"],
    (input: { principal: string; discardLocalChanges?: boolean }) => Promise<ProfileReplicaPreflight>
  >
>;
type _PrepareLogoutBindsApproval = Assert<
  Equal<
    ProfileReplicaPurge["prepareLogoutPending"],
    (input: {
      principal: string; approval?: ProfileReplicaPreflight;
      discardLocalChanges?: boolean; remotePending?: true;
    }) => Promise<ProfileReplicaLogoutPending | null>
  >
>;
type _CompleteRequiresPrincipal = Assert<
  Equal<
    ProfileReplicaPurge["completeRemoteLogout"],
    (input: { principal: string }) => Promise<ProfileReplicaLogoutPending>
  >
>;
type _RemoteRetryRequiresPrincipal = Assert<
  Equal<
    ProfileReplicaPurge["remotePendingLogout"],
    (input: { principal: string }) => Promise<boolean>
  >
>;
type _PlainOverrideRequiresFreshApproval = Assert<
  Equal<
    ProfileReplicaPurge["abandonRemoteLogout"],
    (input: {
      principal: string; approval: ProfileReplicaPreflight; discardLocalChanges?: boolean;
    }) => Promise<ProfileReplicaLogoutPending>
  >
>;
type _ChangedPlainRequiresSeparateToken = Assert<
  Equal<
    ProfileReplicaPurge["approveChangedPlainLogout"],
    (input: {
      principal: string; approval: ProfileReplicaPreflight;
      discardLocalChanges: true; inventoryApprovalToken: string;
    }) => Promise<ProfileReplicaLogoutPending>
  >
>;
type _ReapproveRequiresFreshInventory = Assert<
  Equal<
    ProfileReplicaPurge["reapproveLogoutPending"],
    (input: { principal: string; approval: ProfileReplicaPreflight }) => Promise<ProfileReplicaLogoutPending>
  >
>;
type _RecoverReceivesApprovedInventory = Assert<
  Equal<
    ProfileReplicaPurge["recoverLogoutPending"],
    (options: {
      signal: AbortSignal;
      clearCredentials: () => Promise<void>;
      eraseLegacyReplicas: (options: {
        discardLocalChanges: boolean;
        approvedUnknown: readonly ProfileReplicaUnknownEntry[];
        knownRoots: readonly ProfileReplicaRootIdentity[];
        knownEntries: readonly ProfileReplicaUnknownEntry[];
        missingDatabases: readonly string[];
      }) => Promise<void>;
    }) => Promise<ReplicaEraseReport>
  >
>;
type _CommonGateHasNoLogoutMarker = Assert<
  Equal<
    Extract<"prepareLogoutPending" | "recoverLogoutPending", keyof ReplicaLifecycleGate>,
    never
  >
>;
type _CommonGateHasNoDeferredErase = Assert<
  Equal<"deferredErase" extends keyof ReplicaLifecycleGate ? true : false, false>
>;
type _CommonGateHasNoResume = Assert<
  Equal<"resumeDeferredErase" extends keyof ReplicaLifecycleGate ? true : false, false>
>;
declare const commonLifecycle: ReplicaLifecycleGate;
// @ts-expect-error Deferral is confined to the node/CLI profile facade.
commonLifecycle.deny({ reason: "sign_out", principal: "did:example:owner" }, { deferErase: true });
declare const profilePurge: ProfileReplicaPurge;
// @ts-expect-error Names alone cannot authorize destructive cleanup without identity-bound inventory.
profilePurge.prepareLogoutPending({ principal: "did:example:owner", discardLocalChanges: true, approval: { unknownPaths: ["replicas/new"] } });
// @ts-expect-error Changed remote-pending inventory requires a separately displayed token.
profilePurge.approveChangedPlainLogout({ principal: "did:example:owner", approval: {} });
// @ts-expect-error A fresh approval is mandatory to change a persisted inventory after remote completion.
profilePurge.reapproveLogoutPending({ principal: "did:example:owner" });
