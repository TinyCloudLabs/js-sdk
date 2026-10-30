import { execFileSync, spawnSync } from "node:child_process";
import type { MeasuredInputGraph } from "./replica-size-inputs";

export type GzipSizes = { "index.mjs": number; "index.cjs": number };
export type LedgerEntry = { pr: string; ticket: string; "index.mjs": number; "index.cjs": number; note: string };
export type Phase2Ratchet = {
  label: string;
  base: string;
  toolchain: string;
  baseline: GzipSizes;
  delta: GzipSizes;
  ceiling: GzipSizes;
  rationale: { module: string; controlledMarginalBeforeSafeCuts: GzipSizes; requiredAtLoad: string }[];
  safeCuts: string;
};
export type FirstImportSizes = { "replica.mjs": number; "replica.cjs": number };
export type FixRequiredRatchet = {
  label: string;
  measuredAt: string;
  toolchain: string;
  priorRoot: GzipSizes;
  rootCeiling: GzipSizes;
  priorFirstImport: FirstImportSizes;
  firstImportCeiling: FirstImportSizes;
  groupedMarginals: {
    from: string;
    to: string;
    root: GzipSizes;
    firstImport: FirstImportSizes;
    reason: string;
  }[];
  s4Marginal: string;
};
export type CiToolchainCorrection = {
  label: string;
  approvedSource: string;
  policyOnlyThrough: string;
  ciRun: string;
  ciJob: string;
  ciSecondJob: string;
  ciRunUrl: string;
  ciJobUrls: readonly [string, string];
  toolchain: { bun: string; rustc: string };
  historical: {
    master: GzipSizes;
    approvedDelta: GzipSizes;
    rootCeiling: GzipSizes;
    firstImportCeiling: FirstImportSizes;
    activation: { "activation.mjs": number; "activation.cjs": number };
  };
  priorNoncanonical: {
    master: GzipSizes;
    rootCeiling: GzipSizes;
    firstImportCeiling: FirstImportSizes;
    activationCeiling: { "activation.mjs": number; "activation.cjs": number };
  };
  measured: {
    master: GzipSizes;
    delta: GzipSizes;
    rootCeiling: GzipSizes;
    firstImportCeiling: FirstImportSizes;
    activationCeiling: { "activation.mjs": number; "activation.cjs": number };
  };
  reason: string;
};
export type MasterMergeResolution = {
  label: string;
  mergedHead: string;
  masterBase: string;
  rulings: [string, string, string];
  regeneration: string;
  measuredPaths: Record<string, string>;
  attribution: Record<string, string>;
};
export type ActivationSizes = { "activation.mjs": number; "activation.cjs": number };
/** One reviewed exact-delta admission for the TC-858 fix-before-stable hardening (#565). */
export type HardeningRatchet = {
  label: string;
  ruling: string;
  base: string;
  sourceCommits: string[];
  canonicalCI: { run: string; jobs: string[] };
  root: { delta: GzipSizes; ceiling: GzipSizes };
  firstImport: { delta: FirstImportSizes; ceiling: FirstImportSizes };
  activation: { delta: ActivationSizes; ceiling: ActivationSizes };
  worker: { delta: number; ceiling: number };
  reason: string;
};
/**
 * One reviewed exact-delta admission of #571's sign-out contract (TC-841): the TC-721 owner revoke
 * and the prepared-login retry. Only the root bundle grows; first-import, activation and worker
 * ceilings stay those of the #565 hardening ratchet.
 */
export type LogoutRatchet = {
  label: string;
  ruling: string;
  base: string;
  sourceCommits: string[];
  canonicalCI: { run: string; jobs: string[] };
  root: { delta: GzipSizes; ceiling: GzipSizes };
  reason: string;
};
/**
 * One reviewed exact-delta admission of TC-1413 (js-sdk #574): typed node retry errors in sdk-services.
 * Same shape as the #565 hardening row, because the change moves the root, first-import, activation and
 * worker buckets.
 */
export type Tc1413Ratchet = HardeningRatchet;
/**
 * One reviewed exact-delta admission of js-sdk #578 (TC-1436): the terminal marker for
 * `disableSubDelegation`. Only the root bundle grows, so the shape is the #571 root-only row.
 */
export type Tc1436Ratchet = LogoutRatchet;
/**
 * One reviewed exact-delta admission of TC-1432 (js-sdk #580): vault etag, ifMatch and expectAad in
 * sdk-services. Same shape as the #565 hardening row, because the change moves the root, first-import,
 * activation and worker buckets.
 */
export type Tc1432Ratchet = HardeningRatchet;
/**
 * One reviewed exact-delta admission of js-sdk #583 (TC-1424): the share receiver's non-extractable
 * signing key. Only the root bundle grows, so the shape is the #571 root-only row.
 */
export type Tc1424Ratchet = LogoutRatchet;
/**
 * One reviewed exact-delta admission of TC-1448 (js-sdk #591): the did:pkh recipient guard for terminal
 * grants. Only the root bundle grows, so the shape is the #571 root-only row.
 */
export type Tc1448Ratchet = LogoutRatchet;
/**
 * One reviewed exact-delta admission of js-sdk #586 (TC-1443): the sdk-core registry verdict
 * classifier. Only the root bundle grows, so the shape is the #571 root-only row.
 */
export type Tc1443Ratchet = LogoutRatchet;

/**
 * One reviewed exact-delta admission of TC-1466 (js-sdk #595): the receiver-key clock race fix. Only the root
 * bundle grows, so the shape is the #571 root-only row.
 */
export type Tc1466Ratchet = LogoutRatchet;
/**
 * One exact-delta admission of TC-1443 slice b (js-sdk #589): the opt-in fail-closed registry policy and
 * its space-creation guard. Only the root bundle grows, so the shape is the #571 root-only row.
 */
export type Tc1443bRatchet = LogoutRatchet;
/**
 * One reviewed exact-delta admission of js-sdk #582 (TC-1428): the owner-signed artifact pin the viewer
 * verifies. Only the root bundle grows, so the shape is the #571 root-only row.
 */
export type Tc1428Ratchet = LogoutRatchet;
/**
 * One reviewed exact-delta admission of js-sdk #600 (TC-1476): the registry-sync skip debug event. Only the
 * root bundle grows, so the shape is the #571 root-only row.
 */
export type Tc1476Ratchet = LogoutRatchet;

/**
 * One reviewed exact-delta admission of js-sdk #599 (TC-1475): automatic retry of node busy and
 * request-timeout responses in ServiceContext.fetch. Same shape as the #565 hardening row, because the
 * change moves the root, first-import, activation and worker buckets.
 */
export type Tc1475Ratchet = HardeningRatchet;
/**
 * One reviewed worker-only ceiling raise: js-sdk #606 (security dependency updates) grew the kv-storage
 * worker by 86 B, which turned the TC-858 gzip ratchet red on master.
 */
export type WorkerRatchet = {
  label: string;
  ruling: string;
  base: string;
  sourceCommits: string[];
  canonicalCI: { run: string; jobs: string[] };
  worker: { delta: number; ceiling: number };
  reason: string;
};
/**
 * One cumulative reviewed exact-delta admission of the master drift since 75eb5304 (the last green
 * Replica Node run, #557). Same shape as the #565 hardening row: root and activation.cjs grew without a
 * ledger row because the kv-storage worker step aborted first and hid the Phase 1 dist step.
 */
export type MasterDriftRatchet = HardeningRatchet;
/**
 * One reviewed exact-delta admission of the sdk-services 3.3.1 pin (js-sdk #667): the PR-side CI build
 * measured replica.cjs first-import +1 B with no code change. Same shape as the #565 hardening row.
 */
export type Tc1789Ratchet = HardeningRatchet;
/**
 * One reviewed exact-delta admission of js-sdk #678 (TC-1757): web-sdk imports share-sdk's narrow web-recipient
 * entry, so the root bundle shrinks. The root ceilings are lowered to the bytes canonical CI measured on the #678
 * head; every other ceiling stays that of the sdk-services pin row. Same shape as the #565 hardening row.
 */
export type Tc1757Ratchet = HardeningRatchet;
/**
 * One reviewed exact-delta admission of js-sdk #686 (TC-1777): the replication wiring moved into its own module, which
 * costs a few bytes at the module boundary. The root ceilings rise to the bytes canonical CI measured on the #686
 * code head; every other ceiling stays that of the web-recipient row. Same shape as the #565 hardening row.
 */
export type Tc1777Ratchet = HardeningRatchet;
/**
 * One reviewed exact-delta admission of js-sdk #668 (TC-1777): requestPermissions carries expiryMs, TinyCloudWeb gains
 * hasPermissions, and the decrypt expiry check runs before the modal. #668 is not a replica-owned PR, so this is a plain
 * root row; the root ceilings rise to the bytes canonical CI measured on the #668 code head, every other ceiling stays
 * that of the replication-wiring row. Same shape as the #565 hardening row.
 */
export type Tc1777ExpiryRatchet = HardeningRatchet;
/**
 * One reviewed exact-delta admission of js-sdk #656 (TC-848): the developer request log panel. #656 is not a
 * replica-owned PR, so this is a plain root row; the root ceilings rise to the bytes canonical CI measured on the #656
 * code head, every other ceiling stays that of the expiryMs / hasPermissions row. Same shape as the #565 hardening row.
 */
export type Tc848PanelRatchet = HardeningRatchet;
/**
 * One reviewed exact-delta admission of js-sdk #681 (TC-1781): the one-hour decrypt default and secret-read coverage.
 * #681 is not a replica-owned PR, so this is a plain root row; the root ceilings rise to the bytes canonical CI measured
 * on the #681 code head, every other ceiling stays that of the developer request log panel row. Same shape as the #565
 * hardening row.
 */
export type Tc1781DecryptExpiryRatchet = HardeningRatchet;
/**
 * One reviewed exact-delta admission of js-sdk #687 (TC-1801): the non-transferable share option.
 * #687 is not a replica-owned PR, so this is a plain root row; the root ceilings rise to the bytes canonical CI measured
 * on the #687 code head, every other ceiling stays that of the one-hour decrypt default row. Same shape as the #565
 * hardening row.
 */
export type Tc1801NonTransferableShareRatchet = HardeningRatchet;
/**
 * One reviewed exact-delta admission of js-sdk #690 (TC-1807): the credential discovery default and typed error.
 * #690 is not a replica-owned PR, so this is a plain root row; the root ceilings rise to the bytes canonical CI measured
 * on the #690 code head, every other ceiling stays that of the non-transferable share option row. Same shape as the #565
 * hardening row.
 */
export type Tc1807CredentialDiscoveryRatchet = HardeningRatchet;
/**
 * One reviewed exact-delta admission of js-sdk #694 (TC-1827): the replica workers import only the KV service and its
 * ServiceContext, so the hashed kv-storage worker shrinks. The worker ceiling is lowered to the bytes canonical CI
 * measured on the #694 code head; every other ceiling stays that of the credential discovery row. Same shape as the #565
 * hardening row.
 */
export type Tc1827WorkerRatchet = HardeningRatchet;
/**
 * The first reviewed ceiling for `replica.worker.js`, the @tinycloud/replica/browser worker (TC-1827 follow-up): the
 * bytes canonical CI measured on the PR's code head, zero headroom. Same shape as the #606 worker row; here `worker`
 * is the replica worker (`MAX_REPLICA_WORKER_GZIP_BYTES`), not the kv-storage worker.
 */
export type Tc1827ReplicaWorkerRatchet = WorkerRatchet;
/**
 * One reviewed exact-delta admission of js-sdk #693 (TC-1823): SQL and DuckDB request-size error codes.
 * #693 is not a replica-owned PR, so this is a plain root row; the root ceilings rise to the bytes canonical CI measured
 * on the #693 code head, every other ceiling stays that of the replica worker narrow-imports row. Same shape as the #565
 * hardening row.
 */
export type Tc1823SizeCodeRatchet = HardeningRatchet;
/**
 * One reviewed exact-delta admission of js-sdk #679 (TC-712, PR-A): credential consumer core.
 * #679 is not a replica-owned PR, so this is a plain root row; the root ceilings rise to the bytes canonical CI measured
 * on the #679 code head, every other ceiling stays that of the request-size error code row. Same shape as the #565
 * hardening row.
 */
export type Tc712CredentialCoreRatchet = HardeningRatchet;
/**
 * One reviewed exact-delta LOWERING of the root ceilings (js-sdk #707, TC-1781): decrypt grants use the standard grant
 * expiry again, in node and web. #707 is not a replica-owned PR, so this is a plain root row; the root ceilings fall to
 * the bytes canonical CI measured on the #707 code head, every other ceiling stays that of the credential consumer core
 * row. Same shape as the #565 hardening row, with negative root deltas.
 */
export type Tc1781DecryptStandardExpiryRatchet = HardeningRatchet;
/**
 * One reviewed exact-delta RAISE of the root ceilings (js-sdk #702, TC-1855): manifest permissions that carry a limit are
 * refused on both runtime-permission paths. #702 is not a replica-owned PR, so this is a plain root row; the root ceilings
 * rise to the bytes canonical CI measured on the #702 merged head, every other ceiling stays that of the decrypt standard
 * expiry row. Same shape as the #565 hardening row.
 */
export type Tc1855ManifestLimitGuardRatchet = HardeningRatchet;
/**
 * One reviewed exact-delta RAISE of the root ceilings (js-sdk #604, TC-1488): the browser SIWE domain and URI follow the
 * page origin. #604 is not a replica-owned PR, so this is a plain root row; the root ceilings rise to the bytes canonical
 * CI measured on the #604 head, every other ceiling stays that of the manifest limit guard row. Same shape as the #565
 * hardening row.
 */
export type Tc1488SiweDomainUriRatchet = HardeningRatchet;
/**
 * One reviewed exact-byte row (js-sdk #708, TC-1737): short-link code raised the root index.cjs bytes. Same shape as the
 * #565 hardening row; the worker ceilings are carried unchanged.
 */
export type Tc1737ShortLinkLazyChunkRatchet = HardeningRatchet;
/**
 * One reviewed exact-byte row (js-sdk #721, TC-1910): the invocation signing-consistency change raised the root
 * index.cjs bytes. Same shape as the #565 hardening row; the other ceilings are carried unchanged.
 */
export type Tc1910SigningConsistencyRatchet = HardeningRatchet;
/**
 * One reviewed exact-byte row (js-sdk #731, TC-848): the settings panel launcher, host and toasts raised the root
 * bytes. Same shape as the #565 hardening row; the worker, first-import and activation ceilings are carried unchanged.
 */
export type Tc848SettingsPanelRatchet = HardeningRatchet;
/**
 * One reviewed exact-byte row (js-sdk #739, TC-2034): the named-keys CLI sign-in report raised the root
 * bytes. Same shape as the #565 hardening row; worker, first-import and activation ceilings are carried unchanged.
 */
export type Tc2034NamedKeysCliRatchet = HardeningRatchet;
/** One reviewed exact-byte row for replication syncScope (TC-2043, #742). */
export type Tc2043SyncScopeRatchet = HardeningRatchet;
/** One reviewed exact-byte row for sign-out local-copy erase (TC-1888, #728). */
export type Tc1888PurgeLocalCopyRatchet = HardeningRatchet;
/** One reviewed exact-byte row for manifest named keys (js-sdk #748, TC-1977). */
export type Tc1977ManifestKeysRatchet = HardeningRatchet;
/** One reviewed exact-byte row for panel background-read ability gating (js-sdk TC-2038). */
export type Tc2038PanelPrefetchRatchet = HardeningRatchet;
/** One reviewed exact-byte row for the owner revocation window (TC-2005, #745). */
export type Tc2005RevokeWindowRatchet = HardeningRatchet;
/** One reviewed exact-byte row for the capped replica repair backoff (TC-2096, #759); replicaWorker is the replica.worker.js ceiling. */
export type Tc2096RepairBackoffRatchet = HardeningRatchet & { replicaWorker: { delta: number; ceiling: number } };
/** One reviewed exact-byte row for the TinyCloudWeb location guard (TC-2072, #754); replicaWorker is carried at TC-2096's replica.worker.js ceiling. */
export type Tc2072LocationGuardRatchet = HardeningRatchet & { replicaWorker: { delta: number; ceiling: number } };
/** One reviewed exact-byte row for lazy replica content fetch (TC-2096, #761); replicaWorker is the replica.worker.js ceiling. */
export type Tc2096LazyContentRatchet = HardeningRatchet & { replicaWorker: { delta: number; ceiling: number } };
/** One reviewed exact-byte row for the panel delegation-list permission ask (TC-2113, #763); replicaWorker is carried at TC-2096's lazy-content replica.worker.js ceiling. */
export type Tc2113PanelGrantRatchet = HardeningRatchet & { replicaWorker: { delta: number; ceiling: number } };
/** One reviewed exact-byte row for TinyCloudWeb reading the SIWE domain without a window location (TC-2127, #764); replicaWorker is carried at TC-2113's replica.worker.js ceiling. */
export type Tc2127WindowLocationRatchet = HardeningRatchet & { replicaWorker: { delta: number; ceiling: number } };
/** One reviewed exact-byte row for signInWithOpenKey (TC-1977, #747); replicaWorker is carried at TC-2127's replica.worker.js ceiling. */
export type Tc1977OpenKeySigninRatchet = HardeningRatchet & { replicaWorker: { delta: number; ceiling: number } };
/** One reviewed exact-byte row for the iPhone panel safe-area and ui.setButtonVisible (TC-2130, #765); replicaWorker is carried at TC-1977's replica.worker.js ceiling. */
export type Tc2130PanelIphoneRatchet = HardeningRatchet & { replicaWorker: { delta: number; ceiling: number } };
/** One reviewed exact-byte row for the isAppKeyHostBound export (TC-1977, #767); replicaWorker is carried at TC-2130's replica.worker.js ceiling. */
export type Tc1977HostBindingRatchet = HardeningRatchet & { replicaWorker: { delta: number; ceiling: number } };
/** One reviewed exact-byte row for the delegations the delegate key issued (TC-2132, #766); replicaWorker is carried at TC-1977's replica.worker.js ceiling. */
export type Tc2132IssuedDelegationsRatchet = HardeningRatchet & { replicaWorker: { delta: number; ceiling: number } };
/** One reviewed exact-byte row for the exact named-key decrypt child (TC-2140, #769); replicaWorker is carried at TC-2132's replica.worker.js ceiling. */
export type Tc2140ExactKeyDelegationRatchet = HardeningRatchet & { replicaWorker: { delta: number; ceiling: number } };
/** One reviewed exact-byte row for TC-2202 recipient-agent share receive; replicaWorker is carried at TC-2140's ceiling. */
export type Tc2202AgentShareReceiveRatchet = HardeningRatchet & { replicaWorker: { delta: number; ceiling: number } };
/** Exact current-base Home root admission; additive caps are not controlled feature attribution. */
export type Tc2205HomeFeedRatchet = HardeningRatchet & { replicaWorker: { delta: number; ceiling: number } };
/** Exact TC-2230 root admission for signed recipients SIWE resource insertion; all other buckets are carried unchanged. */
export type Tc2230SiweRecipientsRatchet = HardeningRatchet & { replicaWorker: { delta: number; ceiling: number } };
/** Exact TC-2192 root admission for exact Share-key runtime consent; all other buckets carry TC-2230. */
export type Tc2192ExactKeyRuntimeConsentRatchet = HardeningRatchet & { replicaWorker: { delta: number; ceiling: number } };
/** Exact TC-2242 root admission for the wrapped-key digest helper; non-root buckets carry TC-2192. */
export type Tc2242WrappedKeyDigestRatchet = HardeningRatchet & { replicaWorker: { delta: number; ceiling: number } };
/** Exact TC-2113 Allow ability root admission; non-root buckets carry TC-2242. */
export type Tc2113AllowAbilityRatchet = HardeningRatchet & { replicaWorker: { delta: number; ceiling: number } };
export type Ledger = {
  allowance: GzipSizes;
  entries: LedgerEntry[];
  phase2Ratchet?: Phase2Ratchet;
  fixRequiredRatchet?: FixRequiredRatchet;
  canonicalToolchainCorrection?: CiToolchainCorrection;
  masterMergeResolution?: MasterMergeResolution;
  hardeningRatchet?: HardeningRatchet;
  logoutRatchet?: LogoutRatchet;
  tc1413Ratchet?: Tc1413Ratchet;
  tc1436Ratchet?: Tc1436Ratchet;
  tc1432Ratchet?: Tc1432Ratchet;
  tc1424Ratchet?: Tc1424Ratchet;
  tc1448Ratchet?: Tc1448Ratchet;
  tc1443Ratchet?: Tc1443Ratchet;
  tc1466Ratchet?: Tc1466Ratchet;
  tc1443bRatchet?: Tc1443bRatchet;
  tc1428Ratchet?: Tc1428Ratchet;
  tc1476Ratchet?: Tc1476Ratchet;
  tc1475Ratchet?: Tc1475Ratchet;
  tc606WorkerRatchet?: WorkerRatchet;
  masterDriftRatchet?: MasterDriftRatchet;
  tc1789Ratchet?: Tc1789Ratchet;
  tc1757Ratchet?: Tc1757Ratchet;
  tc1777Ratchet?: Tc1777Ratchet;
  tc1777ExpiryRatchet?: Tc1777ExpiryRatchet;
  tc848PanelRatchet?: Tc848PanelRatchet;
  tc1781DecryptExpiryRatchet?: Tc1781DecryptExpiryRatchet;
  tc1801NonTransferableShareRatchet?: Tc1801NonTransferableShareRatchet;
  tc1807CredentialDiscoveryRatchet?: Tc1807CredentialDiscoveryRatchet;
  tc1827WorkerRatchet?: Tc1827WorkerRatchet;
  tc1827ReplicaWorkerRatchet?: Tc1827ReplicaWorkerRatchet;
  tc1823SizeCodeRatchet?: Tc1823SizeCodeRatchet;
  tc712CredentialCoreRatchet?: Tc712CredentialCoreRatchet;
  tc1781DecryptStandardExpiryRatchet?: Tc1781DecryptStandardExpiryRatchet;
  tc1855ManifestLimitGuardRatchet?: Tc1855ManifestLimitGuardRatchet;
  tc1488SiweDomainUriRatchet?: Tc1488SiweDomainUriRatchet;
  tc1737ShortLinkLazyChunkRatchet?: Tc1737ShortLinkLazyChunkRatchet;
  tc1910SigningConsistencyRatchet?: Tc1910SigningConsistencyRatchet;
  tc848SettingsPanelRatchet?: Tc848SettingsPanelRatchet;
  tc2034NamedKeysCliRatchet?: Tc2034NamedKeysCliRatchet;
  tc2043SyncScopeRatchet?: Tc2043SyncScopeRatchet;
  tc1888PurgeLocalCopyRatchet?: Tc1888PurgeLocalCopyRatchet;
  tc1977ManifestKeysRatchet?: Tc1977ManifestKeysRatchet;
  tc2038PanelPrefetchRatchet?: Tc2038PanelPrefetchRatchet;
  tc2005RevokeWindowRatchet?: Tc2005RevokeWindowRatchet;
  tc2096RepairBackoffRatchet?: Tc2096RepairBackoffRatchet;
  tc2072LocationGuardRatchet?: Tc2072LocationGuardRatchet;
  tc2096LazyContentRatchet?: Tc2096LazyContentRatchet;
  tc2113PanelGrantRatchet?: Tc2113PanelGrantRatchet;
  tc2127WindowLocationRatchet?: Tc2127WindowLocationRatchet;
  tc1977OpenKeySigninRatchet?: Tc1977OpenKeySigninRatchet;
  tc2130PanelIphoneRatchet?: Tc2130PanelIphoneRatchet;
  tc1977HostBindingRatchet?: Tc1977HostBindingRatchet;
  tc2132IssuedDelegationsRatchet?: Tc2132IssuedDelegationsRatchet;
  tc2140ExactKeyDelegationRatchet?: Tc2140ExactKeyDelegationRatchet;
  tc2202AgentShareReceiveRatchet?: Tc2202AgentShareReceiveRatchet;
  tc2205HomeFeedRatchet?: Tc2205HomeFeedRatchet;
  tc2230SiweRecipientsRatchet?: Tc2230SiweRecipientsRatchet;
  tc2192ExactKeyRuntimeConsentRatchet?: Tc2192ExactKeyRuntimeConsentRatchet;
  tc2242WrappedKeyDigestRatchet?: Tc2242WrappedKeyDigestRatchet;
  tc2113AllowAbilityRatchet?: Tc2113AllowAbilityRatchet;
};

const formats = ["index.mjs", "index.cjs"] as const;
export const approvedPhase2 = {
  label: "TC-858 Phase 2 (#548 stack): security fences + required sync paths, approved by Naomi 2026-10-16",
  base: "9891ed9dddc19a57198ed156804948e04d8ea025",
  toolchain: "Bun 1.3.14; replica-e2e Node size job Rust 1.99.0; production webpack; gzip -9 -c",
  baseline: { "index.mjs": 1460603, "index.cjs": 1390460 },
  delta: { "index.mjs": 1322, "index.cjs": 1205 },
  ceiling: { "index.mjs": 1461925, "index.cjs": 1391665 },
} as const;

export const approvedFixRequiredRatchet: FixRequiredRatchet = {
  label: "TC-858 Phase 2 reviewed correctness fixes: copied-proof restore, gated observation, durable denial event, GRANT_REVOKED",
  measuredAt: "ddc032caef81a2177e7f9c30a6a28a8f593a4580",
  toolchain: approvedPhase2.toolchain,
  priorRoot: { "index.mjs": 1461925, "index.cjs": 1391665 },
  rootCeiling: { "index.mjs": 1462034, "index.cjs": 1391799 },
  priorFirstImport: { "replica.mjs": 51201, "replica.cjs": 66132 },
  firstImportCeiling: { "replica.mjs": 51785, "replica.cjs": 66995 },
  groupedMarginals: [
    {
      from: "ce52494d0cb1ea236578bc6b709e9e6e016f8c78",
      to: "18e9f58983727c63c8ad1bab0378e6c3248bbfa3",
      root: { "index.mjs": 180, "index.cjs": 157 },
      firstImport: { "replica.mjs": 1155, "replica.cjs": 1197 },
      reason: "Copied-proof restore refusal, scoped gated network-read events, S3 durable-denial event; TC-1208 synchronous sign-out and session-attempt fences preserved.",
    },
    {
      from: "18e9f58983727c63c8ad1bab0378e6c3248bbfa3",
      to: "ddc032caef81a2177e7f9c30a6a28a8f593a4580",
      root: { "index.mjs": -71, "index.cjs": -23 },
      firstImport: { "replica.mjs": -571, "replica.cjs": -334 },
      reason: "Refused-admission observer physically deferred, existing runtime unbind reused, S3 sign-out event kept in loaded authority; no security or network semantics removed.",
    },
  ],
  s4Marginal: "S4 GRANT_REVOKED network-read projection from 28addd98 integrated as d3930dee; standalone gzip marginal was not isolated and grouped measurements are nonadditive.",
};
/** Approved shipped code is unchanged; only GitHub size-job bytes set ceilings. */
export const approvedCiToolchainCorrection: CiToolchainCorrection = {
  label: "TC-858 #548 canonical CI toolchain measurement correction, zero headroom",
  approvedSource: "ddc032caef81a2177e7f9c30a6a28a8f593a4580",
  policyOnlyThrough: "2acd4ac57697333ebe780bc69a54e9586e164998",
  ciRun: "38971529166",
  ciJob: "117210798521",
  ciSecondJob: "117210798348",
  ciRunUrl: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/38971529166",
  ciJobUrls: [
    "https://github.com/TinyCloudLabs/js-sdk/actions/runs/38971529166/job/117210798521",
    "https://github.com/TinyCloudLabs/js-sdk/actions/runs/38971529166/job/117210798348",
  ],
  toolchain: { bun: "1.3.14", rustc: "1.99.0" },
  historical: {
    master: { "index.mjs": 1460603, "index.cjs": 1390460 },
    approvedDelta: { "index.mjs": 1431, "index.cjs": 1339 },
    rootCeiling: { "index.mjs": 1462034, "index.cjs": 1391799 },
    firstImportCeiling: { "replica.mjs": 51785, "replica.cjs": 66995 },
    activation: { "activation.mjs": 23071, "activation.cjs": 24650 },
  },
  priorNoncanonical: {
    master: { "index.mjs": 1462685, "index.cjs": 1393687 },
    rootCeiling: { "index.mjs": 1464189, "index.cjs": 1395035 },
    firstImportCeiling: { "replica.mjs": 51786, "replica.cjs": 66995 },
    activationCeiling: { "activation.mjs": 23073, "activation.cjs": 24653 },
  },
  measured: {
    master: { "index.mjs": 1462590, "index.cjs": 1393500 },
    delta: { "index.mjs": 1512, "index.cjs": 1369 },
    rootCeiling: { "index.mjs": 1464102, "index.cjs": 1394869 },
    firstImportCeiling: { "replica.mjs": 51785, "replica.cjs": 66995 },
    activationCeiling: { "activation.mjs": 23071, "activation.cjs": 24650 },
  },
  reason: "GitHub replica-e2e Node size jobs 117210798521 and 117210798348 in run 38971529166 independently measured the same master9891 and #548 e5b080d5 build under CI Bun 1.3.14 and rustc 1.99.0. Local rebuilds, including the previous 1462685/1393687 master baseline, are non-canonical smoke tests. The GitHub candidate sets stricter zero-headroom root and first-import ceilings without changing shipped source or historical rows.",
};

/** Only these five reviewed blobs may differ from the trusted master artifact inputs. */
export const approvedMasterMergeResolution: MasterMergeResolution = {
  label: "TC-858 #548 merged #564 shared SQLite handle and stamped replica inputs",
  mergedHead: "57b4a0d6a417cd3fbd439675ffbdf3f427545606",
  masterBase: "6e42699b0b269eb45b7f022c0ecb1b2db3bcf882",
  rulings: [
    "Naomi TC-858: store.ts union of #564 shared verified SQLite handle and #548 stamped store with the S1 typed read-section guard from 8f123f98",
    "Naomi TC-858: derived lockfile for the #548 replica dependency over master 6e42699b",
    "Naomi TC-858: approved #548 Node/replica manifests with master beta release versions",
  ],
  regeneration: "Bun 1.3.14: start with master 6e42699b bun.lock, add @tinycloud/replica 0.2.4-beta.3 to the web-sdk manifest, run bun install and bun install --frozen-lockfile; the lock differs from master only by that dependency.",
  measuredPaths: {
    "packages/replica/src/sqlite/store.ts": "cb52d5b6db9ae2beaa15eb8e4977c7d7f8ff4791",
    "packages/web-sdk/package.json": "fc1a715e656d12f6684a6548ba7bba65157173cb",
    "bun.lock": "f8458c1b94b27b851c85c4169df337bd7ff4c3a2",
    "packages/node-sdk/package.json": "25f43cee5185b08b1454bc059a352e194f40edf7",
    "packages/replica/package.json": "88c7e5ea075fc358214e5803831056cc58749a31",
  },
  attribution: {
    "packages/node-sdk/package.json": "approved #548 content (ddc032ca) plus master release version strings only: Node 3.2.6-beta.4 to 3.2.6-beta.6 and @tinycloud/replica 0.2.4-beta.1 to 0.2.4-beta.3.",
    "packages/replica/package.json": "approved #548 content (ddc032ca) plus master release version strings only: replica 0.2.4-beta.1 to 0.2.4-beta.3.",
  },
};

/**
 * Naomi's TC-858 ruling: the fix-before-stable hardening (#565) is admitted at exactly the bytes
 * GitHub measured, after cuts, with no headroom. Every ceiling equals the canonical current value.
 */
export const approvedHardeningRatchet: HardeningRatchet = {
  label: "TC-858 #565 fix-before-stable hardening (L1, L2, I1 and correctness P2s), exact canonical delta",
  ruling: "Naomi TC-858 size ruling for skgbafa/tc-858-l1-l2-i1-hardening: cuts first, remainder by one reviewed exact-delta row at canonical CI bytes",
  base: "31428720ce89be09cda7504f62709f6710e231b7",
  sourceCommits: [
    "afea5442a5d7bf99a447d44d027a5598795b5b4c",
    "6a384842ffa00c05d4c735272946394687d00396",
    "f5bbd4b905dc3984d5bb1075389976ddabdd541b",
    "89b82fc2d016bd50e48c3a809258ee827f76788d",
    "907e519acacdf4d2f263d50a69c8f8e0e8ff921d",
    "ad08b6252847ef047cbe542d3e33108f55ad26dc",
    "3bf25d63f11e75f243255c8c9c13f5df8a8a5a6d",
    "c9e79f2fd8009ea1b71efdbe7cbb9706af5268cc",
    "afa47f2102d1250c82f71b2df9155d601bc03a5b",
    "3b0b360cd114ded742b890b7b111695fe7a81b0b",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39023273615",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39023273615/job/117369172858",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39023273615/job/117369172785",
    ],
  },
  root: {
    delta: { "index.mjs": 20, "index.cjs": 11 },
    ceiling: { "index.mjs": 1464122, "index.cjs": 1394880 },
  },
  firstImport: {
    delta: { "replica.mjs": 134, "replica.cjs": 129 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67138 },
  },
  activation: {
    delta: { "activation.mjs": 4, "activation.cjs": 5 },
    ceiling: { "activation.mjs": 23075, "activation.cjs": 24655 },
  },
  worker: { delta: 7, ceiling: 820108 },
  reason: "Security L1/L2/I1 and correctness P2 fixes required before stable, plus the round-2 correctness fix for a startup recovery that finishes after its bound. Cuts applied first: the worker start-up report uses reportError (local worker +34 to +7, no client or protocol change); the startup wait reuses the shared bounded helper (local -25/-24); the recovery re-check has no safe smaller bound. Root +20/+11 carries L2's frozen registration copy; first-import +134/+129 carries L2's frozen plugin, the bounded recovery re-check and the single-flight late-startup re-admission; activation +4/+5 is measured with no activation-source change after the cut and is not attributed to one commit. Both jobs of run 39023273615 measured identical absolute bytes in every bucket; the gated artifact is unchanged.",
};

/**
 * Naomi's TC-858 ruling for #571 (TC-841): the sign-out contract is admitted at exactly the bytes GitHub
 * measured, after cuts, with no headroom. Only the root bundle grows; the other ceilings stay #565's.
 */
export const approvedLogoutRatchet: LogoutRatchet = {
  label: "TC-858 #571 sign-out contract (TC-721 owner revoke, prepared-login retry), exact canonical delta",
  ruling: "Naomi TC-858 size ruling for #571: cuts first, remainder by one reviewed exact-delta row at canonical CI bytes",
  base: "d2b54705ae644bb461231feaf46af74bda4b9206",
  sourceCommits: [
    "4c4e3f202ec292d580c9591941feb300e446fdb0",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39054822172",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39054822172/job/117460537751",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39054822172/job/117460537489",
    ],
  },
  root: {
    delta: { "index.mjs": 268, "index.cjs": 193 },
    ceiling: { "index.mjs": 1464390, "index.cjs": 1395073 },
  },
  reason: "Owner-signed direct revoke in DelegationManager (TC-721; +119/+100 locally) and the prepared-login retry in signInWithOpenKey (+115/+89 locally) are the feature. Cuts applied first: the retry loop is one loop and the signOwnerRevocation schema entry is z.custom, together -12/-28 against the first CI measurement of +280/+221; a shared revoke tail would change what the entry carries when authorityCid is undefined and was not taken. The registry-coverage guard and session-field resets are +23/+12 locally. Run 39054822172 measured identical absolute bytes in both jobs against merge base d2b54705. First-import, activation and worker are unchanged (replica.mjs -1 is a measured reduction, not a new allowance).",
};

/**
 * Naomi's ruling for TC-1413 (js-sdk #574): the typed node retry errors in sdk-services are admitted at
 * exactly the bytes GitHub measured, after cuts, with no headroom. sdk-services reaches the root bundle,
 * the kv-storage worker and the optional first-import and activation buckets, so each moves by its
 * measured delta from the #571 / #565 ceilings. Her scope: "no unrelated loosening", not a refusal of the
 * bytes this change causes.
 */
export const approvedTc1413Ratchet: Tc1413Ratchet = {
  label: "TC-1413 typed node retry errors (NODE_BUSY, REQUEST_TIMEOUT, OUTCOME_UNKNOWN), exact canonical delta",
  ruling: "Naomi TC-1413 size ruling: one reviewed exact-delta row at canonical CI bytes; worker, root, first-import and activation only, no unrelated loosening",
  base: "3ae17bfcd5ce61742ad120bcca906c63e10dff73",
  sourceCommits: [
    "20c29611404d3b9fdc90efcd18b0f1f40764d51d",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39099093175",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39099093175/job/117591478490",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39099093175/job/117591478566",
    ],
  },
  root: {
    delta: { "index.mjs": 278, "index.cjs": 302 },
    ceiling: { "index.mjs": 1464668, "index.cjs": 1395375 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 1 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67139 },
  },
  activation: {
    delta: { "activation.mjs": 30, "activation.cjs": 28 },
    ceiling: { "activation.mjs": 23105, "activation.cjs": 24683 },
  },
  worker: { delta: 827, ceiling: 820935 },
  reason: "One shared classifier (nodeRetryError in sdk-services/src/errors.ts) maps the node's 503 sql_busy / unavailable_retryable / request_timeout and 500 outcome_unknown to NODE_BUSY, REQUEST_TIMEOUT and OUTCOME_UNKNOWN for SQL, DuckDB and KV get/head/list/put/delete, replacing the 503-as-KV_CONFLICT mapping. Cuts applied first: Retry-After is read as whole seconds only (no HTTP-date parsing), one message string per error site is shared with the classifier, and the CLI messages live in the CLI only. The first CI measurement on 90bc0ae7 was worker +946, and the two cuts took it to +827. The review then required mapping the new codes in their consumers (ShareRecipientClient.redactedCode and the operations KV and personal-record failure mappers, which also dropped the dead KV_CONFLICT paths); that moved only the root, by +27/+28, so the final source is 20c29611 with root +278/+302. Run 39099093175 measured identical absolute bytes in both jobs against merge base 3ae17bfc; the worker's 820,935 and the optional deltas are unchanged from run 39095938793. No replica-owned file changed; the growth is sdk-services and sdk-core code bundled into each artifact.",
};

/**
 * Naomi's ruling for TC-1436 (js-sdk #578): after a real shrink, the terminal marker is admitted at
 * exactly the bytes GitHub measured, root only, with no headroom. If #580 lands first, #578
 * re-measures against the new base and replaces this row before it merges.
 */
export const approvedTc1436Ratchet: Tc1436Ratchet = {
  label: "TC-1436 #578 terminal marker for disableSubDelegation, exact canonical delta",
  ruling: "Naomi TC-1436 size ruling for #578: a real shrink first, remainder by the PR's own exact-delta row at canonical CI bytes; whichever of #578 and #580 lands second re-measures against the new base and updates its own row",
  base: "7e10709c280596db0118a8fb04e7ffcd9bbe7212",
  sourceCommits: [
    "d8e72fb90f2b8fd645fdcb24ac9249a9cb95f42d",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39134326448",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39134326448/job/117695648893",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39134326448/job/117695649068",
    ],
  },
  root: {
    delta: { "index.mjs": 1327, "index.cjs": 344 },
    ceiling: { "index.mjs": 1465995, "index.cjs": 1395719 },
  },
  reason: "disableSubDelegation now emits the node's terminal UCAN fact: markDelegationTerminal in sdk-core re-signs the WASM-built session-key token with the fact after checking the key is its issuer, and TinyCloudNode wires it through the WASM wrapper and refuses the flag on wallet-signed paths. TinyCloudNode is part of the web bundle, so the feature cannot leave the root. Cuts applied first: one marker call inside createDelegationWrapper instead of one per path, a 54-character error string instead of 176, and the issuer check replacing a separate public-key check; CI went from +1349/+363 on f97d73d9 to +1327/+344 on d8e72fb9. Not taken: a lazy import, because the web build pins LimitChunkCountPlugin({ maxChunks: 1 }) and would inline it; a browser stub, because web-sdk callers would lose the marker. Local ablation (Bun 1.3.14, gzip -9): helper +225/+298, wiring +183/+114. Both jobs of run 39134326448 measured identical absolute bytes against merge base 7e10709c. First import, activation, gated and the worker are unchanged.",
};

/**
 * TC-1432 (js-sdk #580): the vault's `VaultEntry.etag`, `VaultPutOptions.ifMatch` and opt-in
 * `VaultGetOptions.expectAad` are admitted at exactly the bytes GitHub measured, after a real shrink
 * attempt, with no headroom. sdk-services is bundled into the root, the kv-storage worker and the
 * optional first-import and activation buckets, so each moves by its measured delta. The row sits on
 * top of the TC-1436 root ceilings (#578 landed first) and the TC-1413 caps for the other buckets.
 */
export const approvedTc1432Ratchet: Tc1432Ratchet = {
  label: "TC-1432 vault etag, ifMatch and opt-in expectAad, exact canonical delta",
  ruling: "Naomi size ruling: after a real shrink attempt, one PR-owned exact-delta row at canonical CI bytes; worker, root, first-import and activation only, no unrelated loosening",
  base: "129c793544b69b3b956c1c3258e64d1e6efd45fa",
  sourceCommits: [
    "83c9d75abbd8910a9920fb3162872a78e5d3cbc8",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39144311690",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39144311690/job/117724927147",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39144311690/job/117724927262",
    ],
  },
  root: {
    delta: { "index.mjs": 913, "index.cjs": 872 },
    ceiling: { "index.mjs": 1466908, "index.cjs": 1396591 },
  },
  firstImport: {
    delta: { "replica.mjs": 1, "replica.cjs": -1 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67138 },
  },
  activation: {
    delta: { "activation.mjs": 1, "activation.cjs": 2 },
    ceiling: { "activation.mjs": 23106, "activation.cjs": 24685 },
  },
  worker: { delta: 1109, ceiling: 822044 },
  reason: "Vault compare-and-swap and opt-in address binding in sdk-services (DataVaultService, vault types; one node-sdk mapping line): VaultEntry.etag, VaultPutOptions.ifMatch with distinct ETAG_MISMATCH / INVALID_ETAG / OUTCOME_UNKNOWN / NODE_BUSY codes, and VaultGetOptions.expectAad. sdk-services is bundled whole into the root, the kv-storage worker and the optional buckets, and the worker keeps DataVaultService through the sdk-services barrel, so any vault code is charged there. Real shrink attempts first, same-toolchain local worker gzip (Bun 1.4.3), master 819,007: the first candidate was +870 (CI +851); the review fixes (shape check before the AAD check, explicit expectAad refusals, gateway statuses as OUTCOME_UNKNOWN, the weak-etag message) took it to +1,209; folding the new default messages into the existing message-required case changed nothing (+1,249, strings gzip away); merging the shape check and the AAD check into one helper with the decrypt's own base64 decoder cut it to +1,119 (CI +1,109); importing the worker's KVService through the /kv subpath instead measured 837,823 B against the 820,256 B candidate (+17,567, it duplicates KVService) and still contains DataVaultService, so it was reverted; the vault methods are synchronous parts of one service class, so a lazy import is not possible. #578 (TC-1436) landed first, so this row was re-measured against master 129c7935 and sits on top of the TC-1436 root ceilings. Canonical CI run 39144311690 (head 83c9d75a, the merge of that master into source 490cd947 plus a policy placeholder) measured identical absolute bytes in both jobs against merge base 129c7935: root 1,466,908 / 1,396,591 B (+913 / +872 over the TC-1436 ceilings), first import 51,925 / 67,138 B (+1 / -1), activation 23,106 / 24,685 B (+1 / +2) and the worker 822,044 B (+1,109 over the TC-1413 ceiling). Whichever PR lands after this one re-measures against the new base and updates its own row.",
};

/**
 * Naomi's standing size rule applied to TC-1424 (js-sdk #583): after a real shrink, the receiver key
 * custody is admitted at exactly the bytes GitHub measured, root only, with no headroom. #578 and #580
 * landed first, so this row is measured against the base that includes the TC-1432 row.
 */
export const approvedTc1424Ratchet: Tc1424Ratchet = {
  label: "TC-1424 #583 non-extractable share receiver key, exact canonical delta",
  ruling: "Naomi's standing size rule for TC-1424 #583: a real shrink first, remainder by the PR's own exact-delta row at canonical CI bytes; whichever of #578, #580 and #583 lands later re-measures against the new base and updates its own row",
  base: "1d7b78fd03b0634cba823babf6e5ac2a0fec1866",
  sourceCommits: [
    "d1e4c3d32112a0f49a005597be65a73f2694c5f6",
    "7672d834cdd67722bf82aa7b48a0c4f6ddce1418",
    "55145dbb4583995fa8bc837a8bf1793b44751abb",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39150995159",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39150995159/job/117744439615",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39150995159/job/117744439649",
    ],
  },
  root: {
    delta: { "index.mjs": 1673, "index.cjs": 1286 },
    ceiling: { "index.mjs": 1468581, "index.cjs": 1397877 },
  },
  reason: "Accountless share receivers sign with a non-extractable WebCrypto Ed25519 key whose handle is kept in IndexedDB: record validation, a multi-tab add race, compare-and-delete of stale records, removal of the earlier session-storage record, memory-only fallbacks with page-memory credentials, a page-memory fallback where session storage is blocked, sessions that stop signing at expiry or forget, and forget. The receiver is part of the web bundle, so it cannot leave the root. Ed25519 is not new bytes: @noble/curves/ed25519 was already bundled once through sdk-core and share-envelope and still is. Cuts applied first: no transaction timeout wrapper and no per-request promise helper (one transaction-completion promise instead); the local measurement went from +1499/+1265 to +1383/+1171, and CI measured +1382/+1225 on d1e4c3d3. The review fixes on 7672d834 (expiry and forget in sign, compare-and-delete, the blocked-storage fallback, credential storage chosen by the session) took CI to +1677/+1456 against 7e10709c, and +1677/+1444 against 129c7935 after #578. After #580 landed, the merge 55145dbb measured +1673/+1286 against 1d7b78fd in both Replica jobs, which this row admits; first import, activation, gated and the worker are unchanged. Not taken: a lazy import, because the web build pins LimitChunkCountPlugin({ maxChunks: 1 }) and would inline it; dropping forget, multi-tab handling, stored-record validation or the review fixes.",
};

/**
 * TC-1448 (js-sdk #591): the guard that refuses `disableSubDelegation: true` for a `did:pkh` recipient is
 * admitted at exactly the bytes GitHub measured, root only, after a real shrink attempt, with no headroom.
 * The row sits on top of the TC-1424 root ceilings (#583 landed first).
 */
export const approvedTc1448Ratchet: Tc1448Ratchet = {
  label: "TC-1448 #591 terminal-grant did:pkh recipient guard, exact canonical delta",
  ruling: "Naomi size ruling: a real shrink first, remainder by the PR's own exact-delta row at canonical CI bytes; rows chain after the latest on master",
  base: "1c89b697bb37fdf5e318e533cfc96fe927b22997",
  sourceCommits: [
    "18b6c9fa8c64beef0580f26d35443c29ba476d33",
    "b8d133791ab508f9471e1510abc3055116cd933a",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39159867318",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39159867318/job/117770714269",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39159867318/job/117770714211",
    ],
  },
  root: {
    delta: { "index.mjs": 44, "index.cjs": 33 },
    ceiling: { "index.mjs": 1468625, "index.cjs": 1397910 },
  },
  reason: "delegateTo, and so createDelegation and space.delegations.create, throw for disableSubDelegation: true with a did:pkh recipient, because the node refuses a wallet-mode useDelegation of a terminal parent. Shrink attempts first (same-toolchain local gzip, Bun 1.4.3, master 1d7b78fd): the first candidate added a separate 100-character error string, +74 / +55; reusing the existing TERMINAL_DELEGATION_REQUIRES_SESSION_KEY constant for the new refusal (its text now also names the did:key rule and keeps its old prefix) and one shared throw took it to +49 / +58 locally, +41 / +31 on canonical CI against the TC-1432 base. What remains is the did:pkh prefix check and the longer shared message. A lazy import would be inlined by the single-chunk root build, and the check has to run in the web root because TinyCloudWeb.createDelegation forwards to delegateTo. Re-measured after #583 (TC-1424) landed: canonical CI run 39159867318 (head b8d13379, the merge of master 1c89b697 into the PR branch; source unchanged since 18b6c9fa) measured identical absolute bytes in both jobs: root 1,468,625 / 1,397,910 B (+44 / +33 over the TC-1424 ceilings). Whichever PR lands after this one re-measures against the new base and updates its own row.",
};

/**
 * TC-1443 (js-sdk #586), following #578's pattern: after a real shrink, the registry verdict
 * classifier is admitted with no headroom. Naomi approved the row as a delta over whatever base it
 * merges onto (+2,368 / +61 gzip, +/-50 B). The ceilings are the CI-measured bytes of the PR on its
 * base, recorded once the measured delta is inside that band. The row chains after the latest row
 * on master (TC-1448, #591). If another root-growing PR lands first, #586 re-measures against the
 * new base and replaces this row.
 */
export const approvedTc1443Ratchet: Tc1443Ratchet = {
  label: "TC-1443 #586 sdk-core registry verdict classifier, exact canonical delta",
  ruling: "TC-1443 size row for #586, approved by Naomi as a delta (+2,368/+61 gzip, ±50 B), 2026-10-18; re-measured on 70304c3d, following the TC-1436 (#578) size ruling pattern: a real shrink first, remainder by the PR's own exact-delta row at canonical CI bytes",
  base: "70304c3de12a8a3db323cf1271fc58698a9096b3",
  sourceCommits: [
    "72ba295cc0760e88a035f4d8fef488d8fb5c0556",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39166751086",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39166751086/job/117791176669",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39166751086/job/117791176820",
    ],
  },
  root: {
    delta: { "index.mjs": 2370, "index.cjs": 71 },
    ceiling: { "index.mjs": 1470995, "index.cjs": 1397981 },
  },
  reason: "sdk-core adds classifyRegistryLookup (registry-verdict.ts): a pure three-state classifier of one location registry response with its own strict JSON parser, RFC 3339 check, signature encoding rules and host-origin mapping. web-sdk does not export it; the index.mjs build still keeps the whole module, while index.cjs tree-shakes all but its module-level constants. Cut applied first: the module took secp256k1's group order from sdk-core's @noble/curves 1.9.7 while viem bundles its own 1.9.1, so the root carried a second secp256k1; a pinned literal replaced it, and CI went from +12398/+6881 on 8776001a (against 7e10709c) to +2423/+49 on 4a8ccb1a (against 129c7935). Not taken: a lazy import, because the web build pins LimitChunkCountPlugin({ maxChunks: 1 }) and would inline it; changing how the mjs build tree-shakes sdk-core, which is a web-sdk build change outside this PR. #583 (TC-1424), #584, #588, #592, #593 and #591 (TC-1448) landed first; this row was re-measured against master 70304c3d (CI-measured at 7539b854, run 39165869299: index.mjs 1,468,625 and index.cjs 1,397,910 B, equal to the TC-1448 ceilings) and chains after the TC-1448 row. Canonical CI run 39166751086 (head 72ba295c, the merge of that master into source 4a8ccb1a plus a policy row carrying placeholder numbers) measured identical absolute bytes in both Node jobs: index.mjs 1,470,995 and index.cjs 1,397,981 B, i.e. +2,370 / +71 over master's measured bytes, within the approved delta of +2,368 / +61 gzip (+/-50 B). The ceilings are these measured bytes, zero headroom. Whichever PR lands after this one re-measures against the new base and updates its own row.",
};

/**
 * TC-1466 (js-sdk #595): keeping a stored receiver key that a peer tab wrote after this tab read its clock is
 * admitted at exactly the bytes GitHub measured, root only, after shrink attempts, with no headroom. The row
 * sits on top of the TC-1443 root ceilings. Naomi approved the delta over the new base as +12 / +6 gzip bytes, +/- 10 B.
 */
export const approvedTc1466Ratchet: Tc1466Ratchet = {
  label: "TC-1466 #595 receiver key kept across a clock race between tabs, exact canonical delta",
  ruling: "Naomi size ruling: a real shrink attempt first, remainder by the PR's own exact-delta row at canonical CI bytes (approved as +12 / +6 gzip, +/- 10 B); rows chain after the latest on master",
  base: "28ca77a0ce019d53aa61a6c5c3b39c52889e420d",
  sourceCommits: [
    "b2725dd6129940bd78f0e2b2f3622a4017a7f8c3",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39172186671",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39172186671/job/117807385025",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39172186671/job/117807385026",
    ],
  },
  root: {
    delta: { "index.mjs": 12, "index.cjs": 6 },
    ceiling: { "index.mjs": 1471007, "index.cjs": 1397987 },
  },
  reason: "restorePersisted refused a stored receiver key whose createdAt was later than the caller's now, which was read when the tab started. A peer tab that started a moment later stores a record stamped with its own later clock, so this tab judged it future-dated, deleted it and generated a second key (flaky 'tabs opening at once share one stored key', master run 39162127319). Both restores now read the clock when they run. The fix cannot be free: it adds one clock read at each restore. Shrink attempts first (same-toolchain local gzip, Bun 1.4.3, master 1d7b78fd, base +0 / +0): reading the clock inside restorePersisted and compacting its comparison +15 / +13; additionally deduplicating the lifetime fields shared by the memory and persisted sessions +13 / +12 (gzip already shares them); a 2 s tolerance on the future-dated comparison using the existing storage timeout constant +8 / +5, rejected because it loosens the guard against future-dated records for 3 bytes; the chosen two inline fresh clock reads +11 / +5 locally and +12 / +6 on canonical CI, identical in both jobs of run 39172186671 on b2725dd6 (master 28ca77a0 merged into the PR branch), over TC-1443's ceilings.",
};

/**
 * TC-1443 slice b (js-sdk #589): the opt-in fail-closed registry policy and space-creation guard,
 * admitted as an exact-delta row with no headroom. The ceilings are the CI-measured bytes of the PR
 * on its base; Naomi approved the delta over master's measured bytes (2026-10-18). The row chains
 * after the latest row on master (TC-1466, #595). If another root-growing PR lands first, #589
 * re-measures against the new base and replaces this row.
 */
export const approvedTc1443bRatchet: Tc1443bRatchet = {
  label: "TC-1443 slice b #589 opt-in fail-closed registry policy, exact canonical delta",
  ruling: "TC-1443 slice b size row; approved by Naomi (2026-10-18), delta +2,913/+4,510 ±50 B gzip over master 4a717372457fa1deac30c7dca65ab0ed1e1787ab",
  base: "4a717372457fa1deac30c7dca65ab0ed1e1787ab",
  sourceCommits: [
    "f65c2a0f2493a10adbe028f5f95f3372528bb017",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39176947473",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39176947473/job/117821449012",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39176947473/job/117821449071",
    ],
  },
  root: {
    delta: { "index.mjs": 2913, "index.cjs": 4510 },
    ceiling: { "index.mjs": 1473920, "index.cjs": 1402497 },
  },
  reason: "sdk-core adds the opt-in fail-closed registry policy (registry-policy.ts: resolveOwnerHosts and the space-creation guard, plus location.ts hooks and the legacy-fallback deprecation warning); web-sdk sign-in (tcw.ts) threads registryPolicy, newUserHost, registryChainId, registrySequenceStore and onNodeNotFound through. Both root bundles grow. No shrink was attempted for this row. Base: master CI run 39176239864 at f819c542 (4a717372 is a version commit on top) measured index.mjs 1,471,007 / index.cjs 1,397,987 in both Node jobs, equal to the TC-1466 ceilings. PR: run 39176947473 on merge commit f65c2a0f measured 1,473,920 / 1,402,497 in both Node jobs, i.e. +2,913 / +4,510, the same delta as on the earlier base 28ca77a0 (run 39172113588 on 87310cad: 1,473,908 / 1,402,491 over 1,470,995 / 1,397,981). Delta approved by Naomi (2026-10-18): +2,913/+4,510 ±50 B, zero headroom.",
};

/**
 * Naomi's standing size rule applied to TC-1428 (js-sdk #582): after a real shrink, the artifact pin check is
 * admitted at exactly the bytes GitHub measured, root only, with no headroom. The row sits on top of the
 * TC-1443b root ceilings (#589 landed first).
 */
export const approvedTc1428Ratchet: Tc1428Ratchet = {
  label: "TC-1428 #582 owner-signed artifact pin for addressed shares, exact canonical delta",
  ruling: "Naomi's standing size rule for TC-1428 #582: a real shrink first, remainder by the PR's own exact-delta row at canonical CI bytes; rows chain after the latest row on master, so whichever PR lands later re-measures against the new base and updates its own row",
  base: "42b089099ba989f4a2986a7aa5cb6127d3d97d0f",
  sourceCommits: [
    "90f21ae6a137c3c4a44d2b2a2c0310ba8be28808",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39181586326",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39181586326/job/117835278702",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39181586326/job/117835278999",
    ],
  },
  root: {
    delta: { "index.mjs": 915, "index.cjs": 812 },
    ceiling: { "index.mjs": 1474835, "index.cjs": 1403309 },
  },
  reason: "The viewer now checks the owner-signed artifactPin: assertArtifactBinding and verifyArtifactShare in share-sdk/src/artifact-pin.ts, the strict artifactPin field in the Policy/v3 envelope schema, and their call sites in resolvePolicyShare and ShareRecipientClient.decryptV3Content. Root only: the worker, first-import, activation and gated artifacts are unchanged. Cuts applied first: the layout helpers and the owner-side helpers (buildArtifactPin, verifyArtifactManifestBytes, verifyArtifactFileBytes) live in the separate @tinycloud/share-sdk/artifact entry and are not in the web bundle; pin errors use their code as the message (-159 gzip bytes in a share-sdk proxy build); the recipient no longer re-hashes the fetched bytes, because the binding already makes the pinned digest equal contentSource.initialCiphertextDigestHex, which decryptV3Content checks (-56). Reused: verifyEnvelopeV3SignatureOnly for the signature, the noble sha256 already bundled, and the existing ciphertext digest check; sdk-core and share-envelope hold no equivalent. Not taken: a lazy import, because the web build pins LimitChunkCountPlugin({ maxChunks: 1 }) and would inline it; a subpath for the verifier, because the viewer must run it; dropping the expected-artifact check or the edit refusal, each worth about 35 bytes. Local builds measured +1127/+993 before these cuts. Review changes then showed two canonical-CI surprises that local builds do not reproduce: a zod .max() on the pinned size moved the ESM root by +911..+924, so the bound lives in assertArtifactBinding instead (+17), and folding the two receive-path signature checks into one saved nothing. Re-measured after #579, #580, #583, #584, #585, #586, #587, #588, #589, #591, #592, #593 and #595 landed: run 39181586326 on source 90f21ae6 (a merge of master 42b08909) measured identical absolute bytes in both jobs, +915 / +812 over TC-1443b's ceilings. The earlier run on ae2b05bc (master 28ca77a0) measured +911 / +767 over TC-1443's, so the moves in between add +4 / +45 to this PR's own cost.",
};

/**
 * Naomi's size ruling applied to TC-1476 (js-sdk #600): the registry-sync skip debug event is admitted at
 * exactly the bytes GitHub measured, root only, with no headroom. The row sits on top of the TC-1428 root
 * ceilings.
 */
export const approvedTc1476Ratchet: Tc1476Ratchet = {
  label: "TC-1476 #600 registry-sync skip debug event, exact canonical delta",
  ruling: "Naomi's size ruling for TC-1476 #600 (2026-10-19): root +62 B +/-20 gzip, exact row at canonical CI bytes; rows chain after the latest row on master, so whichever PR lands later re-measures against the new base and updates its own row",
  base: "c7a379c5f78450e93bc5bcca3d262eebb1130aff",
  sourceCommits: [
    "bf9349ed5230a4f3c899f80073156ef6046128e8",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39266856585",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39266856585/job/118108567663",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39266856585/job/118108568002",
    ],
  },
  root: {
    delta: { "index.mjs": -27, "index.cjs": -118 },
    ceiling: { "index.mjs": 1474808, "index.cjs": 1403191 },
  },
  reason: "node-sdk's TinyCloudNode (bundled into web-sdk) records one debug event, `registry.skip`, the first time an account registry sync is skipped for want of account access. Both root bundles grow. Shrink applied first: the first version carried a descriptive message and event name and measured +83 B locally (over the root ceiling by 7 B on CI); it is now one short event name with no message (+62 B local, same-toolchain gzip -9). Canonical CI: master c7a379c5 (probe run 39271316078, branch naomi/tc-1476-baseline-probe) measured index.mjs 1,474,761 / index.cjs 1,403,138 in both Node jobs; this PR's run 39266856585 on source bf9349ed measured 1,474,808 / 1,403,191 in both, i.e. +47 / +53 over master, inside the approved +62 +/-20. `delta` is relative to the TC-1428 ceilings this row chains after (1,474,835 / 1,403,309), which sat above master's measured bytes; the ceiling is exactly the measured bytes.",
};

/**
 * Naomi's standing size rule applied to TC-1475 (js-sdk #599): the retry is admitted at exactly the bytes
 * GitHub measured, with no headroom. The root ceilings sit on top of TC-1476's; the first-import,
 * activation and worker ceilings are the measured values on top of TC-1432's (every row since is root only).
 */
export const approvedTc1475Ratchet: Tc1475Ratchet = {
  label: "TC-1475 #599 automatic retry of node busy and request-timeout responses, exact canonical delta",
  ruling: "Naomi's standing size rule for TC-1475 #599: a real shrink first, remainder by the PR's own exact-delta row at canonical CI bytes; rows chain after the latest row on master",
  base: "5317cc7846a4d8c1701c506f3dffc909b030be2f",
  sourceCommits: [
    "092144080cb5f8e1c59286d603991f42121a6801",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39292038037",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39292038037/job/118194900821",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39292038037/job/118194901026",
    ],
  },
  root: {
    delta: { "index.mjs": 358, "index.cjs": 404 },
    ceiling: { "index.mjs": 1475166, "index.cjs": 1403595 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 2 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67140 },
  },
  activation: {
    delta: { "activation.mjs": 11, "activation.cjs": 14 },
    ceiling: { "activation.mjs": 23117, "activation.cjs": 24699 },
  },
  worker: { delta: 623, ceiling: 822667 },
  reason: "ServiceContext.invokeWithRetry(url, build) retries node 503 busy and request_timeout responses and calls build once per attempt, so every attempt carries a freshly signed invocation: the node records each invocation before its handler runs and answers a repeat with 409, so the first version, which re-sent the identical request, could never succeed. KV, SQL, DuckDB and the hooks webhook calls go through one BaseService.invokeWithRetry helper; the RetryPolicy defaults, the RetryStats on responses and KVResponse.retry, and the retryPolicy plumbing in web-sdk and node-sdk are unchanged. sdk-services is bundled into the root, the kv-storage worker and the optional first-import and activation buckets, so each moves by its measured delta. Real shrink first: the abortable sleep is shared with HooksService instead of a second copy, one helper builds every signed request, the debug timing reuses one meta object, and the new doc comments are single lines because the unminified worker bundle keeps JSDoc. The first fix of the re-mint (run 39257200762, source e8cd279a) measured the worker at 822,915 (+871 over TC-1432's); the shrink brought it to 822,620 (+576). Base: master 5317cc78 (it includes #598 and TC-1476, whose root ceilings are 1,474,808 / 1,403,191); PR: GitHub run 39292038037 on source 092144080 measured the same bytes in both Node jobs: root index.mjs 1,475,166 (+358 over the merge base's 1,474,808) and index.cjs 1,403,595 (+404 over the merge base's 1,403,191), first import replica.cjs 67,140 (+2; replica.mjs 51,925, +0), activation 23,117 / 24,699 (+11 / +14) and the kv-storage worker 822,667 (+623 over TC-1432's). Every ceiling is exactly the measured value. The PR's review round added the ref'd retry backoff, the once-per-call backoff signal and read_audit_busy as NODE_BUSY.",
};

/** The reviewed #553 S3 entry's source commit, as master's checker pinned it. */
export const preexistingS3EntryCommit = "0241ba9b";

/** True when `commit` is an ancestor of `ref`. Introduction checks use this on the PR head. */
export function hasAncestor(root: string, commit: string, ref = "HEAD"): boolean {
  return spawnSync("git", ["merge-base", "--is-ancestor", commit, ref], { cwd: root }).status === 0;
}

/**
 * Ancestry pins and squash merges. A row pins the PR-branch commit it was reviewed at, and its
 * introduction check requires that commit in the PR head. js-sdk squash-merges, so the commit is
 * unreachable from master afterwards; a row's ancestry is therefore checked against HEAD only when
 * a PR introduces it. This returns the commit that landed a pin on `ref`: the earliest
 * (`--reverse`) commit on `ref`'s first-parent line (`--first-parent`, so a squash or merge commit,
 * not a merged branch's own commit) whose change under packages/web-sdk/scripts/ alters how often
 * the pin string occurs.
 */
export function landingCommit(root: string, pin: string, ref: string): string | undefined {
  const log = execFileSync("git", [
    "log", "--first-parent", "--reverse", "--format=%H", `-S${pin}`, ref, "--", "packages/web-sdk/scripts/",
  ], { cwd: root, encoding: "utf8" });
  return log.split("\n")[0] || undefined;
}

/**
 * True when `ref` contains `pin` or landed it (landingCommit). This is a consistency check that a
 * merged row reached `ref` through its first-parent history; it does not prove `ref` contains the
 * pinned code. Any scripts/ file that mentions the pin string, or a shallow clone whose graft
 * commit adds every file, satisfies it. It never relaxes a size ceiling or row check.
 */
export function pinLandedOn(root: string, pin: string, ref: string): boolean {
  return hasAncestor(root, pin, ref) || landingCommit(root, pin, ref) !== undefined;
}

/** The ancestry pin of each root row present in `root`, plus the gated-only artifact's when present. */
export function ancestryPins(root: Ledger, hasGatedOnly: boolean): Array<{ row: string; pin: string }> {
  const pins: Array<{ row: string; pin: string }> = [];
  if (root.phase2Ratchet !== undefined) {
    pins.push({ row: "phase2Ratchet", pin: approvedPhase2.base }, { row: "phase2Ratchet (#553 entry)", pin: preexistingS3EntryCommit });
  }
  if (root.fixRequiredRatchet !== undefined) pins.push({ row: "fixRequiredRatchet", pin: approvedFixRequiredRatchet.measuredAt });
  if (root.canonicalToolchainCorrection !== undefined) {
    pins.push({ row: "canonicalToolchainCorrection", pin: approvedCiToolchainCorrection.approvedSource });
  }
  if (root.masterMergeResolution !== undefined) pins.push({ row: "masterMergeResolution", pin: root.masterMergeResolution.mergedHead });
  if (root.hardeningRatchet !== undefined) pins.push({ row: "hardeningRatchet", pin: root.hardeningRatchet.sourceCommits.at(-1)! });
  if (root.logoutRatchet !== undefined) pins.push({ row: "logoutRatchet", pin: root.logoutRatchet.sourceCommits.at(-1)! });
  if (root.tc1413Ratchet !== undefined) pins.push({ row: "tc1413Ratchet", pin: root.tc1413Ratchet.sourceCommits.at(-1)! });
  if (root.tc1436Ratchet !== undefined) pins.push({ row: "tc1436Ratchet", pin: root.tc1436Ratchet.sourceCommits.at(-1)! });
  if (root.tc1432Ratchet !== undefined) pins.push({ row: "tc1432Ratchet", pin: root.tc1432Ratchet.sourceCommits.at(-1)! });
  if (root.tc1424Ratchet !== undefined) pins.push({ row: "tc1424Ratchet", pin: root.tc1424Ratchet.sourceCommits.at(-1)! });
  if (root.tc1448Ratchet !== undefined) pins.push({ row: "tc1448Ratchet", pin: root.tc1448Ratchet.sourceCommits.at(-1)! });
  if (root.tc1443Ratchet !== undefined) pins.push({ row: "tc1443Ratchet", pin: root.tc1443Ratchet.sourceCommits.at(-1)! });
  if (root.tc1466Ratchet !== undefined) pins.push({ row: "tc1466Ratchet", pin: root.tc1466Ratchet.sourceCommits.at(-1)! });
  if (root.tc1443bRatchet !== undefined) pins.push({ row: "tc1443bRatchet", pin: root.tc1443bRatchet.sourceCommits.at(-1)! });
  if (root.tc1428Ratchet !== undefined) pins.push({ row: "tc1428Ratchet", pin: root.tc1428Ratchet.sourceCommits.at(-1)! });
  if (root.tc1476Ratchet !== undefined) pins.push({ row: "tc1476Ratchet", pin: root.tc1476Ratchet.sourceCommits.at(-1)! });
  if (root.tc1475Ratchet !== undefined) pins.push({ row: "tc1475Ratchet", pin: root.tc1475Ratchet.sourceCommits.at(-1)! });
  if (root.tc606WorkerRatchet !== undefined) pins.push({ row: "tc606WorkerRatchet", pin: root.tc606WorkerRatchet.sourceCommits.at(-1)! });
  if (root.masterDriftRatchet !== undefined) pins.push({ row: "masterDriftRatchet", pin: root.masterDriftRatchet.sourceCommits.at(-1)! });
  if (root.tc1789Ratchet !== undefined) pins.push({ row: "tc1789Ratchet", pin: root.tc1789Ratchet.sourceCommits.at(-1)! });
  if (root.tc1757Ratchet !== undefined) pins.push({ row: "tc1757Ratchet", pin: root.tc1757Ratchet.sourceCommits.at(-1)! });
  if (root.tc1777Ratchet !== undefined) pins.push({ row: "tc1777Ratchet", pin: root.tc1777Ratchet.sourceCommits.at(-1)! });
  if (root.tc1777ExpiryRatchet !== undefined) pins.push({ row: "tc1777ExpiryRatchet", pin: root.tc1777ExpiryRatchet.sourceCommits.at(-1)! });
  if (root.tc848PanelRatchet !== undefined) pins.push({ row: "tc848PanelRatchet", pin: root.tc848PanelRatchet.sourceCommits.at(-1)! });
  if (root.tc1781DecryptExpiryRatchet !== undefined) pins.push({ row: "tc1781DecryptExpiryRatchet", pin: root.tc1781DecryptExpiryRatchet.sourceCommits.at(-1)! });
  if (root.tc1801NonTransferableShareRatchet !== undefined) pins.push({ row: "tc1801NonTransferableShareRatchet", pin: root.tc1801NonTransferableShareRatchet.sourceCommits.at(-1)! });
  if (root.tc1807CredentialDiscoveryRatchet !== undefined) pins.push({ row: "tc1807CredentialDiscoveryRatchet", pin: root.tc1807CredentialDiscoveryRatchet.sourceCommits.at(-1)! });
  if (root.tc1827WorkerRatchet !== undefined) pins.push({ row: "tc1827WorkerRatchet", pin: root.tc1827WorkerRatchet.sourceCommits.at(-1)! });
  if (root.tc1827ReplicaWorkerRatchet !== undefined) pins.push({ row: "tc1827ReplicaWorkerRatchet", pin: root.tc1827ReplicaWorkerRatchet.sourceCommits.at(-1)! });
  if (root.tc1823SizeCodeRatchet !== undefined) pins.push({ row: "tc1823SizeCodeRatchet", pin: root.tc1823SizeCodeRatchet.sourceCommits.at(-1)! });
  if (root.tc712CredentialCoreRatchet !== undefined) pins.push({ row: "tc712CredentialCoreRatchet", pin: root.tc712CredentialCoreRatchet.sourceCommits.at(-1)! });
  if (root.tc1781DecryptStandardExpiryRatchet !== undefined) pins.push({ row: "tc1781DecryptStandardExpiryRatchet", pin: root.tc1781DecryptStandardExpiryRatchet.sourceCommits.at(-1)! });
  if (root.tc1855ManifestLimitGuardRatchet !== undefined) pins.push({ row: "tc1855ManifestLimitGuardRatchet", pin: root.tc1855ManifestLimitGuardRatchet.sourceCommits.at(-1)! });
  if (root.tc1488SiweDomainUriRatchet !== undefined) pins.push({ row: "tc1488SiweDomainUriRatchet", pin: root.tc1488SiweDomainUriRatchet.sourceCommits.at(-1)! });
  if (root.tc1737ShortLinkLazyChunkRatchet !== undefined) pins.push({ row: "tc1737ShortLinkLazyChunkRatchet", pin: root.tc1737ShortLinkLazyChunkRatchet.sourceCommits.at(-1)! });
  if (root.tc1910SigningConsistencyRatchet !== undefined) pins.push({ row: "tc1910SigningConsistencyRatchet", pin: root.tc1910SigningConsistencyRatchet.sourceCommits.at(-1)! });
  if (root.tc848SettingsPanelRatchet !== undefined) pins.push({ row: "tc848SettingsPanelRatchet", pin: root.tc848SettingsPanelRatchet.sourceCommits.at(-1)! });
  if (root.tc2034NamedKeysCliRatchet !== undefined) pins.push({ row: "tc2034NamedKeysCliRatchet", pin: root.tc2034NamedKeysCliRatchet.sourceCommits.at(-1)! });
  if (root.tc2043SyncScopeRatchet !== undefined) pins.push({ row: "tc2043SyncScopeRatchet", pin: root.tc2043SyncScopeRatchet.sourceCommits.at(-1)! });
  if (root.tc1888PurgeLocalCopyRatchet !== undefined) pins.push({ row: "tc1888PurgeLocalCopyRatchet", pin: root.tc1888PurgeLocalCopyRatchet.sourceCommits.at(-1)! });
  if (root.tc1977ManifestKeysRatchet !== undefined) pins.push({ row: "tc1977ManifestKeysRatchet", pin: root.tc1977ManifestKeysRatchet.sourceCommits.at(-1)! });
  if (root.tc2038PanelPrefetchRatchet !== undefined) pins.push({ row: "tc2038PanelPrefetchRatchet", pin: root.tc2038PanelPrefetchRatchet.sourceCommits.at(-1)! });
  if (root.tc2005RevokeWindowRatchet !== undefined) pins.push({ row: "tc2005RevokeWindowRatchet", pin: root.tc2005RevokeWindowRatchet.sourceCommits.at(-1)! });
  if (root.tc2096RepairBackoffRatchet !== undefined) pins.push({ row: "tc2096RepairBackoffRatchet", pin: root.tc2096RepairBackoffRatchet.sourceCommits.at(-1)! });
  if (root.tc2072LocationGuardRatchet !== undefined) pins.push({ row: "tc2072LocationGuardRatchet", pin: root.tc2072LocationGuardRatchet.sourceCommits.at(-1)! });
  if (root.tc2096LazyContentRatchet !== undefined) pins.push({ row: "tc2096LazyContentRatchet", pin: root.tc2096LazyContentRatchet.sourceCommits.at(-1)! });
  if (root.tc2113PanelGrantRatchet !== undefined) pins.push({ row: "tc2113PanelGrantRatchet", pin: root.tc2113PanelGrantRatchet.sourceCommits.at(-1)! });
  if (root.tc2127WindowLocationRatchet !== undefined) pins.push({ row: "tc2127WindowLocationRatchet", pin: root.tc2127WindowLocationRatchet.sourceCommits.at(-1)! });
  if (root.tc1977OpenKeySigninRatchet !== undefined) pins.push({ row: "tc1977OpenKeySigninRatchet", pin: root.tc1977OpenKeySigninRatchet.sourceCommits.at(-1)! });
  if (root.tc2130PanelIphoneRatchet !== undefined) pins.push({ row: "tc2130PanelIphoneRatchet", pin: root.tc2130PanelIphoneRatchet.sourceCommits.at(-1)! });
  if (root.tc1977HostBindingRatchet !== undefined) pins.push({ row: "tc1977HostBindingRatchet", pin: root.tc1977HostBindingRatchet.sourceCommits.at(-1)! });
  if (root.tc2132IssuedDelegationsRatchet !== undefined) pins.push({ row: "tc2132IssuedDelegationsRatchet", pin: root.tc2132IssuedDelegationsRatchet.sourceCommits.at(-1)! });
  if (root.tc2140ExactKeyDelegationRatchet !== undefined) pins.push({ row: "tc2140ExactKeyDelegationRatchet", pin: root.tc2140ExactKeyDelegationRatchet.sourceCommits.at(-1)! });
  if (root.tc2202AgentShareReceiveRatchet !== undefined) pins.push({ row: "tc2202AgentShareReceiveRatchet", pin: root.tc2202AgentShareReceiveRatchet.sourceCommits.at(-1)! });
  if (root.tc2205HomeFeedRatchet !== undefined) pins.push({ row: "tc2205HomeFeedRatchet", pin: root.tc2205HomeFeedRatchet.sourceCommits.at(-1)! });
  if (root.tc2230SiweRecipientsRatchet !== undefined) pins.push({ row: "tc2230SiweRecipientsRatchet", pin: root.tc2230SiweRecipientsRatchet.sourceCommits.at(-1)! });
  if (root.tc2192ExactKeyRuntimeConsentRatchet !== undefined) pins.push({ row: "tc2192ExactKeyRuntimeConsentRatchet", pin: root.tc2192ExactKeyRuntimeConsentRatchet.sourceCommits.at(-1)! });
  if (root.tc2242WrappedKeyDigestRatchet !== undefined) pins.push({ row: "tc2242WrappedKeyDigestRatchet", pin: root.tc2242WrappedKeyDigestRatchet.sourceCommits.at(-1)! });
  if (root.tc2113AllowAbilityRatchet !== undefined) pins.push({ row: "tc2113AllowAbilityRatchet", pin: root.tc2113AllowAbilityRatchet.sourceCommits.at(-1)! });
  if (hasGatedOnly) pins.push({ row: "gatedOnlyRatchet", pin: approvedGatedOnlyRatchet.sourceCommit });
  return pins;
}

/**
 * The absolute root ceiling of each root row present in `root`, oldest first. The order is the one the ledger
 * introduces rows in: validateLedger's prerequisite chain, ancestryPins, and the key order of
 * replica-size-ledger.json. A new root row goes last here, and in those three places. masterMergeResolution and
 * tc606WorkerRatchet set no root ceiling and are absent.
 */
export function rootCeilings(root: Ledger): Array<{ row: string; ceiling: GzipSizes }> {
  const rows: Array<[string, GzipSizes | undefined]> = [
    ["phase2Ratchet", root.phase2Ratchet?.ceiling],
    ["fixRequiredRatchet", root.fixRequiredRatchet?.rootCeiling],
    ["canonicalToolchainCorrection", root.canonicalToolchainCorrection?.measured.rootCeiling],
    ["hardeningRatchet", root.hardeningRatchet?.root.ceiling],
    ["logoutRatchet", root.logoutRatchet?.root.ceiling],
    ["tc1413Ratchet", root.tc1413Ratchet?.root.ceiling],
    ["tc1436Ratchet", root.tc1436Ratchet?.root.ceiling],
    ["tc1432Ratchet", root.tc1432Ratchet?.root.ceiling],
    ["tc1424Ratchet", root.tc1424Ratchet?.root.ceiling],
    ["tc1448Ratchet", root.tc1448Ratchet?.root.ceiling],
    ["tc1443Ratchet", root.tc1443Ratchet?.root.ceiling],
    ["tc1466Ratchet", root.tc1466Ratchet?.root.ceiling],
    ["tc1443bRatchet", root.tc1443bRatchet?.root.ceiling],
    ["tc1428Ratchet", root.tc1428Ratchet?.root.ceiling],
    ["tc1476Ratchet", root.tc1476Ratchet?.root.ceiling],
    ["tc1475Ratchet", root.tc1475Ratchet?.root.ceiling],
    ["masterDriftRatchet", root.masterDriftRatchet?.root.ceiling],
    ["tc1789Ratchet", root.tc1789Ratchet?.root.ceiling],
    ["tc1757Ratchet", root.tc1757Ratchet?.root.ceiling],
    ["tc1777Ratchet", root.tc1777Ratchet?.root.ceiling],
    ["tc1777ExpiryRatchet", root.tc1777ExpiryRatchet?.root.ceiling],
    ["tc848PanelRatchet", root.tc848PanelRatchet?.root.ceiling],
    ["tc1781DecryptExpiryRatchet", root.tc1781DecryptExpiryRatchet?.root.ceiling],
    ["tc1801NonTransferableShareRatchet", root.tc1801NonTransferableShareRatchet?.root.ceiling],
    ["tc1807CredentialDiscoveryRatchet", root.tc1807CredentialDiscoveryRatchet?.root.ceiling],
    ["tc1827WorkerRatchet", root.tc1827WorkerRatchet?.root.ceiling],
    ["tc1823SizeCodeRatchet", root.tc1823SizeCodeRatchet?.root.ceiling],
    ["tc712CredentialCoreRatchet", root.tc712CredentialCoreRatchet?.root.ceiling],
    ["tc1781DecryptStandardExpiryRatchet", root.tc1781DecryptStandardExpiryRatchet?.root.ceiling],
    ["tc1855ManifestLimitGuardRatchet", root.tc1855ManifestLimitGuardRatchet?.root.ceiling],
    ["tc1488SiweDomainUriRatchet", root.tc1488SiweDomainUriRatchet?.root.ceiling],
    ["tc1737ShortLinkLazyChunkRatchet", root.tc1737ShortLinkLazyChunkRatchet?.root.ceiling],
    ["tc1910SigningConsistencyRatchet", root.tc1910SigningConsistencyRatchet?.root.ceiling],
    ["tc848SettingsPanelRatchet", root.tc848SettingsPanelRatchet?.root.ceiling],
    ["tc2034NamedKeysCliRatchet", root.tc2034NamedKeysCliRatchet?.root.ceiling],
    ["tc2043SyncScopeRatchet", root.tc2043SyncScopeRatchet?.root.ceiling],
    ["tc1888PurgeLocalCopyRatchet", root.tc1888PurgeLocalCopyRatchet?.root.ceiling],
    ["tc1977ManifestKeysRatchet", root.tc1977ManifestKeysRatchet?.root.ceiling],
    ["tc2038PanelPrefetchRatchet", root.tc2038PanelPrefetchRatchet?.root.ceiling],
    ["tc2005RevokeWindowRatchet", root.tc2005RevokeWindowRatchet?.root.ceiling],
    ["tc2096RepairBackoffRatchet", root.tc2096RepairBackoffRatchet?.root.ceiling],
    ["tc2072LocationGuardRatchet", root.tc2072LocationGuardRatchet?.root.ceiling],
    ["tc2096LazyContentRatchet", root.tc2096LazyContentRatchet?.root.ceiling],
    ["tc2113PanelGrantRatchet", root.tc2113PanelGrantRatchet?.root.ceiling],
    ["tc2127WindowLocationRatchet", root.tc2127WindowLocationRatchet?.root.ceiling],
    ["tc1977OpenKeySigninRatchet", root.tc1977OpenKeySigninRatchet?.root.ceiling],
    ["tc2130PanelIphoneRatchet", root.tc2130PanelIphoneRatchet?.root.ceiling],
    ["tc1977HostBindingRatchet", root.tc1977HostBindingRatchet?.root.ceiling],
    ["tc2132IssuedDelegationsRatchet", root.tc2132IssuedDelegationsRatchet?.root.ceiling],
    ["tc2140ExactKeyDelegationRatchet", root.tc2140ExactKeyDelegationRatchet?.root.ceiling],
    ["tc2202AgentShareReceiveRatchet", root.tc2202AgentShareReceiveRatchet?.root.ceiling],
    ["tc2205HomeFeedRatchet", root.tc2205HomeFeedRatchet?.root.ceiling],
    ["tc2230SiweRecipientsRatchet", root.tc2230SiweRecipientsRatchet?.root.ceiling],
    ["tc2192ExactKeyRuntimeConsentRatchet", root.tc2192ExactKeyRuntimeConsentRatchet?.root.ceiling],
    ["tc2242WrappedKeyDigestRatchet", root.tc2242WrappedKeyDigestRatchet?.root.ceiling],
    ["tc2113AllowAbilityRatchet", root.tc2113AllowAbilityRatchet?.root.ceiling],
  ];
  return rows.flatMap(([row, ceiling]) => ceiling === undefined ? [] : [{ row, ceiling }]);
}

/**
 * The newest root row's ceiling is the only active one. Older rows stay in the ledger as history and still
 * validate, but an older, higher row can never shadow a newer, lowered one (#678 lowered the root ceiling).
 */
export function activeRootCeiling(root: Ledger): { row: string; ceiling: GzipSizes } | undefined {
  return rootCeilings(root).at(-1);
}

/**
 * The active root ceiling for one format, or an error when there is none. A ledger with no root row, or an active
 * row without a number for `format`, must fail the gate rather than silently skip it.
 */
export function rootCeilingFor(root: Ledger, format: keyof GzipSizes): { row: string; ceiling: number } | { error: string } {
  const active = activeRootCeiling(root);
  if (active === undefined) return { error: `${format}: no active root ceiling in the ledger; the absolute root gate cannot be skipped.` };
  const ceiling = active.ceiling[format];
  if (typeof ceiling !== "number") return { error: `${format}: active root row ${active.row} has no ceiling for this format; the absolute root gate cannot be skipped.` };
  return { row: active.row, ceiling };
}

/**
 * #606 (security dependency updates), approved by Naomi, 2026-10-19: the kv-storage worker is admitted at exactly the 822,753 B
 * GitHub measured on master 54a2408d (+86 over TC-1475's 822,667). Worker only; nothing else moves.
 */
export const approvedTc606WorkerRatchet: WorkerRatchet = {
  label: "#606 security dependency updates, kv-storage worker exact canonical delta",
  ruling: "#606 (security dependency updates), approved by Naomi, 2026-10-19: raise the kv-storage worker gzip ceiling by exactly 86 B to the canonical CI measurement; no other allowance changes",
  base: "75eb5304",
  sourceCommits: [
    "78aec0e0996a24ff1a06cbcd719728e2342ba5f9",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39326132925",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39326132925/job/118312339066",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39326132925/job/118312339183",
    ],
  },
  worker: { delta: 86, ceiling: 822753 },
  reason: "#606 (security dependency updates, merge 78aec0e0) grew the kv-storage worker by 86 B; #605, #552 and #549 inherited the failure. Its Cargo.lock bumps (serde_with/darling, bs58, tinyvec, rustls, openssl) are the likely cause [inferred from the lockfile diff, not bisected]. The Enforce hashed kv-storage worker gzip ratchet step measured 822,753 gzip -9 bytes against the 822,667 ceiling (headroom -86). Last green master: 75eb5304 (#557).",
};

/**
 * Master drift since 75eb5304, approved by Naomi, 2026-10-19: root index.mjs +405, index.cjs +329 and
 * activation.cjs +1 at the bytes canonical CI printed on the #608 head, on top of TC-1475's ceilings (the
 * +86 worker is the separate tc606WorkerRatchet). Candidates: #606, #605, #552; attribution not bisected.
 */
export const approvedMasterDriftRatchet: MasterDriftRatchet = {
  label: "master drift since 75eb5304 (candidates #606 / #605 / #552, attribution not bisected), exact canonical delta",
  ruling: "Naomi, 2026-10-19 (option A on #608): one cumulative reviewed row for the master drift since 75eb5304, at the bytes canonical CI prints; approved by Naomi, 2026-10-19",
  base: "75eb5304",
  sourceCommits: [
    "78aec0e0996a24ff1a06cbcd719728e2342ba5f9",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39327730885",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39327730885/job/118317792683",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39327730885/job/118317792664",
    ],
  },
  root: {
    delta: { "index.mjs": 405, "index.cjs": 329 },
    ceiling: { "index.mjs": 1475571, "index.cjs": 1403924 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67140 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 1 },
    ceiling: { "activation.mjs": 23117, "activation.cjs": 24700 },
  },
  worker: { delta: 0, ceiling: 822753 },
  reason: "The Phase 1 dist step had not run on master since the kv-storage worker step began aborting first at #606 (78aec0e0); when it ran on #608 it measured root index.mjs 1,475,571 and index.cjs 1,403,924 against the TC-1475 ceilings 1,475,166 and 1,403,595 (+405/+329) and activation.cjs 24,700 against 24,699 (+1). Candidates #606 (security dependency updates), #605, #552; attribution not bisected. The worker is already admitted by tc606WorkerRatchet.",
};

/**
 * sdk-services 3.3.1 pin, approved by Naomi, 2026-10-22: replica.cjs first-import +1 B (the 51,925 / 67,140 /
 * 23,117 / 24,700 optional allowance becomes 51,925 / 67,141 / 23,117 / 24,700) at the bytes canonical CI printed
 * on the #667 head 6bdf2064. Root and worker stay at the master-drift ceilings: both measured with zero delta.
 */
export const approvedTc1789Ratchet: Tc1789Ratchet = {
  label: "sdk-services 3.3.1 pin (#667): replica.cjs first-import +1 B, exact canonical delta",
  ruling: "Approved by Naomi (2026-10-22, policy review relayed by Amos)",
  base: "772940d8",
  sourceCommits: [
    "193b594eee3f0f9c3f0fe9157f74267f8c03f3bf",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39775125638",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39775125638/job/119812005984",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39775125638/job/119812005960",
    ],
  },
  root: {
    delta: { "index.mjs": 0, "index.cjs": 0 },
    ceiling: { "index.mjs": 1475571, "index.cjs": 1403924 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 1 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67141 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23117, "activation.cjs": 24700 },
  },
  worker: { delta: 0, ceiling: 822753 },
  reason: "CI PR-side build +1 B with no code change (sdk-services 3.3.1 pin; TC-1789 investigation)",
};

/**
 * web-recipient entry, approved by Naomi, 2026-10-22: the root index.mjs / index.cjs ceilings drop from
 * 1,475,571 / 1,403,924 to 1,458,843 / 1,401,918, the bytes canonical CI printed on the #678 code head e244be2c.
 * Master measured 1,475,555 / 1,403,914 (runs 39817162813, 39813052331, 39789112412), so the measured growth
 * against master is -16,712 / -1,996. First-import, activation and worker ceilings are unchanged.
 */
export const approvedTc1757Ratchet: Tc1757Ratchet = {
  label: "web-recipient entry (#678): root ceiling lowered to the measured CI bytes",
  ruling: "Approved by Naomi (2026-10-22, policy review relayed by Amos)",
  base: "368a3d3e7075c0538f0ced9b26d3870c590c81f0",
  sourceCommits: [
    "e244be2c5d83d94b1c1a505b4ea85301f393b4a3",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39817449009",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39817449009/job/119959550450",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39817449009/job/119959550040",
    ],
  },
  root: {
    delta: { "index.mjs": -16712, "index.cjs": -1996 },
    ceiling: { "index.mjs": 1458843, "index.cjs": 1401918 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67141 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23117, "activation.cjs": 24700 },
  },
  worker: { delta: 0, ceiling: 822753 },
  reason: "web-sdk imports share-sdk's narrow web-recipient entry; root ceiling lowered to measured CI bytes (TC-1757)",
};

/**
 * Replication wiring in its own module (#686, TC-1777), approved by Naomi, 2026-10-22: the root index.mjs /
 * index.cjs ceilings rise from 1,458,843 / 1,401,918 to 1,458,858 / 1,401,947, the bytes canonical CI printed on the
 * #686 code head 187b8a43. Master bc49820c measured 1,458,843 / 1,401,918 (run 39844729108), so the measured
 * growth against master is +15 / +29, the cost of the module boundary. First-import, activation and worker
 * ceilings are unchanged.
 */
export const approvedTc1777Ratchet: Tc1777Ratchet = {
  label: "replication wiring in its own module (#686): root ceiling raised to the measured CI bytes",
  ruling: "Approved by Naomi (2026-10-22, policy review relayed by Amos)",
  base: "bc49820c1417a449041e9801b60c86a63485b55d",
  sourceCommits: [
    "187b8a433a1c02008f066a00e41d36819acbc007",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39855300327",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39855300327/job/120091843728",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39855300327/job/120091844294",
    ],
  },
  root: {
    delta: { "index.mjs": 15, "index.cjs": 29 },
    ceiling: { "index.mjs": 1458858, "index.cjs": 1401947 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67141 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23117, "activation.cjs": 24700 },
  },
  worker: { delta: 0, ceiling: 822753 },
  reason: "replication wiring moved into its own module; +15 B (mjs) / +29 B (cjs) gzip from the module boundary (TC-1777)",
};

/**
 * expiryMs / hasPermissions / pre-modal decrypt check (#668, TC-1777), approved by Naomi, 2026-10-22: the root
 * index.mjs / index.cjs ceilings rise from 1,458,858 / 1,401,947 to 1,459,030 / 1,402,121, the bytes canonical CI
 * printed on the #668 code head 28585593 merged into master 80d38744, which itself measured 1,458,858 / 1,401,947
 * (run 39859312541). Measured growth against master is +172 / +174. First-import, activation and worker ceilings
 * are unchanged.
 */
export const approvedTc1777ExpiryRatchet: Tc1777ExpiryRatchet = {
  label: "expiryMs, hasPermissions and pre-modal decrypt check (#668): root ceiling raised to the measured CI bytes",
  ruling: "Approved by Naomi (2026-10-22, policy review relayed by Amos)",
  base: "80d387441dbe87e2309a849c653e2d0adecd400b",
  sourceCommits: [
    "28585593a756f65b47f2aa60be240c5fce3dbd9d",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39861366041",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39861366041/job/120112619622",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39861366041/job/120112619857",
    ],
  },
  root: {
    delta: { "index.mjs": 172, "index.cjs": 174 },
    ceiling: { "index.mjs": 1459030, "index.cjs": 1402121 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67141 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23117, "activation.cjs": 24700 },
  },
  worker: { delta: 0, ceiling: 822753 },
  reason: "expiryMs, hasPermissions and the pre-modal decrypt check add 172 B (mjs) / 174 B (cjs) gzip to each web-sdk root bundle (TC-1777)",
};

/**
 * Developer request log panel (js-sdk #656, TC-848), approved by Naomi, 2026-10-22: the root index.mjs / index.cjs
 * ceilings rise from 1,459,030 / 1,402,121 to 1,462,046 / 1,404,345, the bytes canonical CI printed on the #656 code
 * head aae48af0 merged into master bf510d9f, which itself measured 1,459,030 / 1,402,121. Measured growth against
 * master is +3,016 / +2,224. First-import, activation and worker ceilings are unchanged.
 */
export const approvedTc848PanelRatchet: Tc848PanelRatchet = {
  label: "developer request log panel (#656): root ceiling raised to the measured CI bytes",
  ruling: "Approved by Naomi (2026-10-22, policy review relayed by Amos)",
  base: "bf510d9f226c84bd6fd8d9d018c82e84b1fd2cc8",
  sourceCommits: [
    "aae48af0237b05f8673321b332d533aac7fd1a9b",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39869142170",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39869142170/job/120138846942",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39869142170/job/120138847243",
    ],
  },
  root: {
    delta: { "index.mjs": 3016, "index.cjs": 2224 },
    ceiling: { "index.mjs": 1462046, "index.cjs": 1404345 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67141 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23117, "activation.cjs": 24700 },
  },
  worker: { delta: 0, ceiling: 822753 },
  reason: "developer request log (TC-848 panel): +3016 B (mjs) / +2224 B (cjs) gzip to each web-sdk root bundle",
};

/**
 * One-hour decrypt default and secret-read coverage (js-sdk #681, TC-1781), approved by Naomi, 2026-10-23: the root
 * index.mjs / index.cjs ceilings rise from 1,462,046 / 1,404,345 to 1,462,349 / 1,404,562, the bytes canonical CI
 * printed on the #681 code head 0e56796c merged into master e88e40e0. Master measured 1,462,046 / 1,404,345 (run
 * 39876022752 on d60f81df, the last code commit under e88e40e0, a [skip ci] release commit). Measured growth against
 * master is +303 / +217. First-import, activation and worker ceilings are unchanged.
 */
export const approvedTc1781DecryptExpiryRatchet: Tc1781DecryptExpiryRatchet = {
  label: "one-hour decrypt default and secret-read coverage (#681): root ceiling raised to the measured CI bytes",
  ruling: "Approved by Naomi (2026-10-23, policy review relayed by Amos)",
  base: "e88e40e003cd2570e80b1a3cd53d0a5531838e42",
  sourceCommits: [
    "0e56796c881a9a294b3c08cb69c5e351dac5855c",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39890426909",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39890426909/job/120208584548",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39890426909/job/120208584544",
    ],
  },
  root: {
    delta: { "index.mjs": 303, "index.cjs": 217 },
    ceiling: { "index.mjs": 1462349, "index.cjs": 1404562 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67141 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23117, "activation.cjs": 24700 },
  },
  worker: { delta: 0, ceiling: 822753 },
  reason: "one-hour decrypt default and secret-read coverage: +303 B (mjs) / +217 B (cjs) gzip to each web-sdk root bundle (TC-1781)",
};

/**
 * Non-transferable share option (js-sdk #687, TC-1801), approved by Naomi, 2026-10-23: the root index.mjs / index.cjs
 * ceilings rise from 1,462,349 / 1,404,562 to 1,462,375 / 1,404,597, the bytes canonical CI printed on the #687 code
 * head 8109b636 merged into master 51ee7f0e (the merge base). Master measured 1,462,349 / 1,404,562 (run 39893524824
 * on 7b92156e). Measured growth against master is +26 / +35. First-import, activation and worker ceilings are unchanged.
 */
export const approvedTc1801NonTransferableShareRatchet: Tc1801NonTransferableShareRatchet = {
  label: "non-transferable share option (#687): root ceiling raised to the measured CI bytes",
  ruling: "Approved by Naomi (2026-10-23, policy review relayed by Amos)",
  base: "51ee7f0e9aa7a382d5150a7f1c20e9b64b36409b",
  sourceCommits: [
    "8109b636fbc6b21a56d11a17ea8d97d860a8435b",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39896378690",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39896378690/job/120227697556",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39896378690/job/120227697563",
    ],
  },
  root: {
    delta: { "index.mjs": 26, "index.cjs": 35 },
    ceiling: { "index.mjs": 1462375, "index.cjs": 1404597 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67141 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23117, "activation.cjs": 24700 },
  },
  worker: { delta: 0, ceiling: 822753 },
  reason: "non-transferable share option: +26 B (mjs) / +35 B (cjs) gzip to each web-sdk root bundle (TC-1801)",
};

/**
 * Credential discovery default and typed error (js-sdk #690, TC-1807), approved by Naomi, 2026-10-23: the root index.mjs /
 * index.cjs ceilings rise from 1,462,375 / 1,404,597 to 1,462,456 / 1,404,685, the bytes canonical CI printed on the #690
 * code head 3ca75b89 (master 437ca159 merged in; 437ca159 is the merge base). Master measured 1,462,375 / 1,404,597 (runs
 * 39900520931 on 0c09d7be and 39902544500 on 437ca159). Measured growth against master is +81 / +88. First-import,
 * activation and worker ceilings are unchanged.
 */
export const approvedTc1807CredentialDiscoveryRatchet: Tc1807CredentialDiscoveryRatchet = {
  label: "credential discovery default and typed error (#690): root ceiling raised to the measured CI bytes",
  ruling: "Approved by Naomi (2026-10-23, policy review relayed by Amos)",
  base: "437ca1593cb9b41029409d154b724a64753625bc",
  sourceCommits: [
    "3ca75b89172289ef1fa3d780d42ae57181e25e67",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39904276924",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39904276924/job/120252519592",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39904276924/job/120252519405",
    ],
  },
  root: {
    delta: { "index.mjs": 81, "index.cjs": 88 },
    ceiling: { "index.mjs": 1462456, "index.cjs": 1404685 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67141 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23117, "activation.cjs": 24700 },
  },
  worker: { delta: 0, ceiling: 822753 },
  reason: "credential discovery default and typed error: +81 B (mjs) / +88 B (cjs) gzip to each web-sdk root bundle (TC-1807)",
};

/**
 * Replica worker narrow imports (js-sdk #694, TC-1827), approved by Naomi, 2026-10-23: the hashed kv-storage worker
 * ceiling (`MAX_WORKER_GZIP_BYTES`) drops from 822,753 to 776,128, the bytes canonical CI printed on the #694 code head
 * 7a7303a8 (merge base 6076581d). Master measured 822,753 (run 39908208344 on d867b7ac), so the measured growth against
 * master is -46,625. Root, first-import and activation ceilings are unchanged; their deltas are the measured ones.
 */
export const approvedTc1827WorkerRatchet: Tc1827WorkerRatchet = {
  label: "replica worker narrow imports (#694): kv-storage worker ceiling lowered to the measured CI bytes",
  ruling: "Approved by Naomi (2026-10-23, policy review relayed by Amos)",
  base: "6076581dcf13a6a0395b0f8798c6b6bf22928088",
  sourceCommits: [
    "7a7303a8afdc81910adbfa7b6485d2acc07617cd",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39943720009",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39943720009/job/120381124294",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39943720009/job/120381124041",
    ],
  },
  root: {
    delta: { "index.mjs": 0, "index.cjs": 0 },
    ceiling: { "index.mjs": 1462456, "index.cjs": 1404685 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": -1 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67141 },
  },
  activation: {
    delta: { "activation.mjs": -1, "activation.cjs": -2 },
    ceiling: { "activation.mjs": 23117, "activation.cjs": 24700 },
  },
  worker: { delta: -46625, ceiling: 776128 },
  reason: "replica workers import only the KV service: -46625 B gzip to the kv-storage worker (TC-1827)",
};

/**
 * Replica worker ratchet (TC-1827 follow-up), requested by Naomi, 2026-10-23: `replica.worker.js` had no size ceiling;
 * `MAX_REPLICA_WORKER_GZIP_BYTES` is the 770,093 gzip bytes canonical CI printed on the code head f2e2f9fc (merge base
 * dc615834, after #694). That head changes no worker input, so the delta against the merge base is 0.
 */
export const approvedTc1827ReplicaWorkerRatchet: Tc1827ReplicaWorkerRatchet = {
  label: "replica worker size ratchet (TC-1827 follow-up): first replica.worker.js ceiling at the measured CI bytes",
  ruling: "Requested by Naomi (2026-10-23, relayed by Amos): the exact canonical CI bytes, zero headroom",
  base: "dc61583428a04aa87eb0c0d6aebb656a698a5b0f",
  sourceCommits: [
    "f2e2f9fcc16842bfa3e30c71eae9de271405fdae",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39949887460",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39949887460/job/120401498637",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39949887460/job/120401498914",
    ],
  },
  worker: { delta: 0, ceiling: 770093 },
  reason: "replica.worker.js had no size ratchet; its ceiling is the 770093 B gzip canonical CI measured (TC-1827)",
};

/**
 * SQL and DuckDB request-size error codes (js-sdk #693, TC-1823), approved by Naomi, 2026-10-23: the root index.mjs /
 * index.cjs ceilings rise from 1,462,456 / 1,404,685 to 1,462,556 / 1,404,793, the bytes canonical CI printed on the #693
 * code head c35e2688 (merge base d3da8654, master's tip). Measured growth against master is +100 / +108, shrunk from
 * +1,273 / +331 at 198771bb. First-import, activation and worker ceilings are unchanged.
 */
export const approvedTc1823SizeCodeRatchet: Tc1823SizeCodeRatchet = {
  label: "SQL and DuckDB request-size error codes (#693): root ceiling raised to the measured CI bytes; master 1462456/1404685 → 1462556/1404793; shrunk from +1273/+331 (198771bb) to +100/+108",
  ruling: "Approved by Naomi (2026-10-23, policy review relayed by Amos)",
  base: "d3da865460ad4b0b51bad753bddd8f89518db238",
  sourceCommits: [
    "c35e268879bf5e30447f9335229dda4d64361bdb",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39978157827",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39978157827/job/120498120597",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39978157827/job/120498121108",
    ],
  },
  root: {
    delta: { "index.mjs": 100, "index.cjs": 108 },
    ceiling: { "index.mjs": 1462556, "index.cjs": 1404793 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67141 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23117, "activation.cjs": 24700 },
  },
  worker: { delta: 0, ceiling: 776128 },
  reason: "SQL and DuckDB request-size error codes: +100 B (mjs) / +108 B (cjs) gzip to each web-sdk root bundle (TC-1823)",
};

/**
 * Credential consumer core (js-sdk #679, TC-712 PR-A), approved by Naomi, 2026-10-23: the root index.mjs / index.cjs
 * ceilings rise from 1,462,556 / 1,404,793 to 1,462,632 / 1,404,864, the bytes canonical CI printed on the #679 code
 * head 20a35591 (merge base 43c5bea9, master's tip). Measured growth against the previous newest row is +76 / +71.
 * First-import, activation and worker ceilings are unchanged.
 */
export const approvedTc712CredentialCoreRatchet: Tc712CredentialCoreRatchet = {
  label: "credential consumer core (#679, TC-712 PR-A): root ceiling raised to the measured CI bytes; newest row 1462556/1404793 → 1462632/1404864 (+76/+71)",
  ruling: "Approved by Naomi (2026-10-23, policy review relayed by Amos)",
  base: "43c5bea9cd6e9409e2e8094de30d302de9aa94a5",
  sourceCommits: [
    "20a35591ac263358270ae28fd8ad7013af74d861",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40002503111",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40002503111/job/120581943143",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40002503111/job/120581942872",
    ],
  },
  root: {
    delta: { "index.mjs": 76, "index.cjs": 71 },
    ceiling: { "index.mjs": 1462632, "index.cjs": 1404864 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67141 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23117, "activation.cjs": 24700 },
  },
  worker: { delta: 0, ceiling: 776128 },
  reason: "credential consumer core: +76 B (mjs) / +71 B (cjs) gzip to each web-sdk root bundle (TC-712)",
};

/**
 * Decrypt grants on the standard grant expiry (js-sdk #707, TC-1781), approved by Naomi, 2026-10-23: the root index.mjs /
 * index.cjs ceilings fall from 1,462,632 / 1,404,864 to 1,462,319 / 1,404,635, the bytes canonical CI printed on the
 * #707 code head 218d4a83 (Replica run 40030915569). Measured change against the previous newest row is -313 / -229.
 * First-import, activation and worker ceilings are unchanged.
 */
export const approvedTc1781DecryptStandardExpiryRatchet: Tc1781DecryptStandardExpiryRatchet = {
  label: "decrypt grants use the standard grant expiry again (node and web): root -313/-229; ceilings set to the exact CI bytes at 218d4a83 (run 40030915569)",
  ruling: "Approved by Naomi (2026-10-23, policy review relayed by Amos)",
  base: "f543b70ccd18bfde7324b3323af07d36450f5300",
  sourceCommits: [
    "218d4a83fc7771818d1f7d1f674b81e7163d6d07",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40030915569",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40030915569/job/120678658559",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40030915569/job/120678658540",
    ],
  },
  root: {
    delta: { "index.mjs": -313, "index.cjs": -229 },
    ceiling: { "index.mjs": 1462319, "index.cjs": 1404635 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67141 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23117, "activation.cjs": 24700 },
  },
  worker: { delta: 0, ceiling: 776128 },
  reason: "decrypt grants use the standard grant expiry again (node and web): root -313/-229; ceilings set to the exact CI bytes at 218d4a83 (run 40030915569)",
};

/**
 * Manifest limit guards (js-sdk #702, TC-1855), approved by Naomi, 2026-10-24 (accepted ~+168 B CJS to keep every guard):
 * the root index.mjs / index.cjs ceilings rise from 1,462,319 / 1,404,635 to 1,462,474 / 1,404,741, the bytes canonical CI
 * printed on the #702 merged head 657abe77 (Replica run 40058867098). Measured change against the previous newest row is
 * +155 / +106. First-import, activation and worker ceilings are unchanged.
 */
export const approvedTc1855ManifestLimitGuardRatchet: Tc1855ManifestLimitGuardRatchet = {
  label: "refuse manifest permissions that carry a limit (TC-1855, #702): guards on both runtime-permission paths, +155 B mjs / +106 B cjs gzip",
  ruling: "Approved by Naomi (2026-10-24; accepted ~+168 B CJS to keep every guard; judge by the CJS delta)",
  base: "9a5eed8fee222c091d823e3f1c49127011408693",
  sourceCommits: [
    "657abe77d520e8174e1394daf5911847bd2ff57d",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40058867098",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40058867098/job/120767792065",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40058867098/job/120767792128",
    ],
  },
  root: {
    delta: { "index.mjs": 155, "index.cjs": 106 },
    ceiling: { "index.mjs": 1462474, "index.cjs": 1404741 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67141 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23117, "activation.cjs": 24700 },
  },
  worker: { delta: 0, ceiling: 776128 },
  reason: "refuse manifest permissions that carry a limit (TC-1855, #702): guards on both runtime-permission paths, +155 B mjs / +106 B cjs gzip",
};

/**
 * Browser SIWE domain and URI (js-sdk #604, TC-1488), approved by Naomi, 2026-10-24: the root index.mjs / index.cjs
 * ceilings rise from 1,462,474 / 1,404,741 to 1,462,509 / 1,404,776, the bytes canonical CI printed on the #604 head
 * aaa4ce3e (Replica run 40089434307). Measured change against the previous newest row is +35 / +35. First-import,
 * activation and worker ceilings are unchanged.
 */
export const approvedTc1488SiweDomainUriRatchet: Tc1488SiweDomainUriRatchet = {
  label: "the browser SIWE domain and URI follow the page origin (TC-1488, #604): +35 B mjs / +35 B cjs gzip",
  ruling: "Approved by Naomi (2026-10-24; exact canonical CI bytes, no headroom)",
  base: "8e431447f23a164da75faed067d4b16af5c77ef0",
  sourceCommits: [
    "aaa4ce3e6c9182c8022aaff3511c9f2144a5b756",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40089434307",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40089434307/job/120858912359",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40089434307/job/120858912529",
    ],
  },
  root: {
    delta: { "index.mjs": 35, "index.cjs": 35 },
    ceiling: { "index.mjs": 1462509, "index.cjs": 1404776 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67141 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23117, "activation.cjs": 24700 },
  },
  worker: { delta: 0, ceiling: 776128 },
  reason: "the browser SIWE domain and URI follow the page origin (TC-1488, #604): +35 B mjs / +35 B cjs gzip",
};

/**
 * Short links v=4 (js-sdk #708, TC-1737), approved by Naomi: the root index.cjs ceiling goes from 1,404,776 to 1,404,942
 * (+166), the bytes canonical CI printed on the #708 head 8d15cd61 (Replica run 40136320965). The index.mjs ceiling stays
 * 1,462,509: CI measured 1,461,950 there, within the TC-1985 gzip-alignment swing. The worker ceilings are unchanged
 * (776,128 and 770,093): the kv-storage and replica workers measured those bytes on the #708 head 8df0083d after the
 * replica's sdk-services pin moved to 3.6.1 (Replica run 40141627657). First-import and activation ceilings are unchanged.
 */
export const approvedTc1737ShortLinkLazyChunkRatchet: Tc1737ShortLinkLazyChunkRatchet = {
  label: "short links v=4 (TC-1737, #708): root index.cjs +166 B gzip, index.mjs ceiling carried, worker ceilings unchanged",
  ruling: "Approved by Naomi (index.cjs at the exact CI bytes of run 40136320965, no headroom; index.mjs ceiling kept; worker ceilings unchanged, measured in run 40141627657)",
  base: "e6aad66159e81b47c937da584a4c7f019be54100",
  sourceCommits: [
    "8d15cd6123fd37924db59065e1317682dbff2772",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40136320965",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40136320965/job/120998491772",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40136320965/job/120998491418",
    ],
  },
  root: {
    delta: { "index.mjs": 0, "index.cjs": 166 },
    ceiling: { "index.mjs": 1462509, "index.cjs": 1404942 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67141 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23117, "activation.cjs": 24700 },
  },
  worker: { delta: 0, ceiling: 776128 },
  reason: "index.cjs grew by 166 B from the short-link code in sdk-core/share-envelope; index.mjs measured 1461950 in CI run 40136320965 and its ceiling is not lowered (within the TC-1985 gzip-alignment swing); the worker bundles are unchanged after the replica's sdk-services pin moved to 3.6.1 (TC-2014)",
};

/**
 * Invocation signing consistency (js-sdk #721, TC-1910), approved by Naomi: the root index.cjs ceiling goes from 1,404,942
 * to 1,405,179 (+237), the bytes canonical CI printed on the #721 head f5f76a58 (Replica run 40176697796). The index.mjs
 * ceiling stays 1,462,509: CI measured 1,462,173 there. The worker, first-import and activation ceilings are unchanged.
 */
export const approvedTc1910SigningConsistencyRatchet: Tc1910SigningConsistencyRatchet = {
  label: "invocation signing consistency (TC-1910, #721): root index.cjs +237 B gzip, index.mjs ceiling carried",
  ruling: "Approved by Naomi (index.cjs at the exact CI bytes of run 40176697796, no headroom; index.mjs ceiling carried; worker ceilings unchanged)",
  base: "be28faab7608bf12ef4308666c3163b5ccceda93",
  sourceCommits: [
    "f5f76a58f87afda5054969847c716bfac63fbbf3",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40176697796",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40176697796/job/121118801100",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40176697796/job/121118801300",
    ],
  },
  root: {
    delta: { "index.mjs": 0, "index.cjs": 237 },
    ceiling: { "index.mjs": 1462509, "index.cjs": 1405179 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67141 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23117, "activation.cjs": 24700 },
  },
  worker: { delta: 0, ceiling: 776128 },
  reason: "signing-consistency fix plus the approved recovery hint; smallest version that keeps every existing test; index.mjs measured 1,462,173 (ceiling carried)",
};

/**
 * Settings panel launcher, host and toasts (js-sdk #731, TC-848), approved by Naomi: the root index.mjs ceiling goes from
 * 1,462,509 to 1,464,178 (+1669) and index.cjs from 1,405,179 to 1,406,007 (+828), the bytes canonical CI printed on the
 * #731 head 5d8535af (run 40220911012). The worker, first-import and activation ceilings are carried unchanged.
 */
export const approvedTc848SettingsPanelRatchet: Tc848SettingsPanelRatchet = {
  label: "settings panel launcher, host and toasts (TC-848, #731): root index.mjs +1669 B, index.cjs +828 B gzip",
  ruling: "Approved by Naomi (exact CI bytes of run 40220911012 on 5d8535af; first import, activation and worker carried)",
  base: "b90a608ea0b079073845e0a0995f0c55e529d3af",
  sourceCommits: [
    "5d8535af1444d636029eb0733229006c2249b444",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40220911012",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40220911012/job/121252076932",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40220911012/job/121252076746",
    ],
  },
  root: {
    delta: { "index.mjs": 1669, "index.cjs": 828 },
    ceiling: { "index.mjs": 1464178, "index.cjs": 1406007 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67141 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23117, "activation.cjs": 24700 },
  },
  worker: { delta: 0, ceiling: 776128 },
  reason: "panel eager launcher, host and toasts; both figures include gzip alignment against the inline wasm payload (TC-1985).",
};

/**
 * Named-keys CLI sign-in report (js-sdk #739, TC-2034), approved by Naomi: the root index.mjs ceiling goes from
 * 1,464,178 to 1,464,317 (+139) and index.cjs from 1,406,007 to 1,406,152 (+145), the exact bytes canonical CI printed
 * on the #739 head 331a52de (run 40240409880). Worker, first-import and activation ceilings are carried unchanged.
 */
export const approvedTc2034NamedKeysCliRatchet: Tc2034NamedKeysCliRatchet = {
  label: "node-sdk reports whether sign-in's bootstrap created the encryption network (CLI named keys, TC-2034, #739)",
  ruling: "Approved by Naomi (exact canonical CI bytes at run 40240409880; no headroom)",
  base: "d01d67c02ef6587295212f507863d164f05961f9",
  sourceCommits: [
    "331a52de6b06a350cd62f149d74b6ebe315bc0c5",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40240409880",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40240409880/job/121310795747",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40240409880/job/121310795576",
    ],
  },
  root: {
    delta: { "index.mjs": 139, "index.cjs": 145 },
    ceiling: { "index.mjs": 1464317, "index.cjs": 1406152 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 51925, "replica.cjs": 67141 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23117, "activation.cjs": 24700 },
  },
  worker: { delta: 0, ceiling: 776128 },
  reason: "node-sdk reports whether sign-in's bootstrap created the encryption network (named-keys CLI)",
};

/** Canonical CI run 40247206055: opt-in prefix sync raises root and first-import ceilings; activation and workers are unchanged. */
export const approvedTc2043SyncScopeRatchet: Tc2043SyncScopeRatchet = {
  label: "replication syncScope opt-in (TC-2043, #742)",
  ruling: "Approved by Naomi (exact canonical CI bytes at run 40247206055; no headroom)",
  base: "ddfb8bb54f1d977718631735b5fc4aac3b84e9a3",
  sourceCommits: ["f6740607a9c5ef1ac9b979388add8515aea7e929"],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40247206055",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40247206055/job/121331195222",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40247206055/job/121331195022",
    ],
  },
  root: {
    delta: { "index.mjs": 41, "index.cjs": 30 },
    ceiling: { "index.mjs": 1464358, "index.cjs": 1406182 },
  },
  firstImport: {
    delta: { "replica.mjs": 40, "replica.cjs": 39 },
    ceiling: { "replica.mjs": 51965, "replica.cjs": 67178 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23117, "activation.cjs": 24700 },
  },
  worker: { delta: 0, ceiling: 776128 },
  reason: "opt-in `replication.syncScope: 'prefixes'` keeps sign-in kv/sync on declared prefixes when the manifest grants root KV (TinyCloud Home).",
};

/** Canonical CI run 40303939643: root, first import and activation rise by the approved deltas; worker is unchanged. */
export const approvedTc1888PurgeLocalCopyRatchet: Tc1888PurgeLocalCopyRatchet = {
  label: "sign-out erases the local copy and purgeLocalCopy (TC-1888, #728)",
  ruling: "Approved by Naomi (exact canonical CI bytes at run 40303939643; no headroom)",
  base: "bd41ce30df6cad86ce501a2230ecd2afebef2e66",
  sourceCommits: ["36dd6e5061735907e200222fc5cac362076d024d"],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40303939643",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40303939643/job/121508294847",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40303939643/job/121508294935",
    ],
  },
  root: {
    delta: { "index.mjs": 271, "index.cjs": 274 },
    ceiling: { "index.mjs": 1464629, "index.cjs": 1406456 },
  },
  firstImport: {
    delta: { "replica.mjs": 409, "replica.cjs": 393 },
    ceiling: { "replica.mjs": 52374, "replica.cjs": 67571 },
  },
  activation: {
    delta: { "activation.mjs": 270, "activation.cjs": 261 },
    ceiling: { "activation.mjs": 23386, "activation.cjs": 24959 },
  },
  worker: { delta: 0, ceiling: 776128 },
  reason: "sign-out and account switch erase the local copy with an SDK retry and a failure event; the minimum reviewed shape; optional code in the replica chunk.",
};

/** Manifest named keys (js-sdk #748, TC-1977), approved by Naomi: root index.mjs 1,464,629 -> 1,467,294 (+2,665) and index.cjs 1,406,456 -> 1,409,264 (+2,808), the exact deltas canonical CI printed on head 796fdd2a (run 40318285314). Worker is unchanged; first-import and activation deltas are 0, so their ceilings are the tc1888 caps. */
export const approvedTc1977ManifestKeysRatchet: Tc1977ManifestKeysRatchet = {
  label: "sdk: manifest named keys (TC-1977, #748): +2,665 B mjs / +2,808 B cjs gzip",
  ruling: "Approved by Naomi (measured at run 40318285314 within 10 bytes of the approved +2,666/+2,814; no headroom)",
  base: "5467d1248b20e59d3b7eca508da417c2b35316b3",
  sourceCommits: [
    "796fdd2a13c0f6b0e6f767e0347151c0cbaf84fe",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40318285314",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40318285314/job/121556330989",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40318285314/job/121556331284",
    ],
  },
  root: {
    delta: { "index.mjs": 2665, "index.cjs": 2808 },
    ceiling: { "index.mjs": 1467294, "index.cjs": 1409264 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 52374, "replica.cjs": 67571 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23386, "activation.cjs": 24959 },
  },
  worker: { delta: 0, ceiling: 776128 },
  reason: "manifest named keys: the `keys` block, key resource derivation and sign-in abilities (TC-1977)",
};

/** Panel background-read ability gating (TC-2038). Root delta +12 mjs / +9 cjs is the measured excess over the TC-1977 root ceiling in canonical CI run 40331788730 on head 1381ddff663cb62f63c4dee95293fcbc12d673d5: current index.mjs 1467306 vs TC-1977 1467294, index.cjs 1409273 vs TC-1977 1409264. First-import and activation match the measured values; worker ceiling is carried from TC-1977 and is not separately measured. */
export const approvedTc2038PanelPrefetchRatchet: Tc2038PanelPrefetchRatchet = {
  label: "sdk: panel prefetch ability gating (TC-2038): +12 B mjs / +9 B cjs gzip",
  ruling: "Approved by Naomi (measured at run 40331788730 within 10 bytes of the approved +15/+4; no headroom)",
  base: "c59bcd3ac04c18583025d402283aa687545ab9f3",
  sourceCommits: [
    "1381ddff663cb62f63c4dee95293fcbc12d673d5",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40331788730",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40331788730/job/121602802896",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40331788730/job/121602802667",
    ],
  },
  root: {
    delta: { "index.mjs": 12, "index.cjs": 9 },
    ceiling: { "index.mjs": 1467306, "index.cjs": 1409273 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 52374, "replica.cjs": 67571 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23386, "activation.cjs": 24959 },
  },
  worker: { delta: 0, ceiling: 776128 },
  reason: "panel background reads (account index, delegation query, storage status) go out only when the session holds the matching ReCap ability (TC-2038)",
};


/** Canonical CI run 40316432428 (TC-2005, #745): root index.mjs rises by 52 bytes; index.cjs, first import, activation and worker are unchanged. */
export const approvedTc2005RevokeWindowRatchet: Tc2005RevokeWindowRatchet = {
  label: "node-sdk owner revocation window (TC-2005, #745): +52 B mjs / +0 B cjs gzip",
  ruling: "Approved by Naomi (exact CI bytes at run 40316432428; ceilings measured on the merged master within 10 bytes)",
  base: "dc74efaad0363281b19dc389e3a6a5467cfde2cb",
  sourceCommits: ["e7706b989018cad874da7e6577558c566359c5a2"],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40316432428",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40316432428/job/121550076548",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40316432428/job/121550076779",
    ],
  },
  root: {
    delta: { "index.mjs": 52, "index.cjs": 0 },
    ceiling: { "index.mjs": 1467358, "index.cjs": 1409273 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 52374, "replica.cjs": 67571 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23386, "activation.cjs": 24959 },
  },
  worker: { delta: 0, ceiling: 776128 },
  reason: "the owner revocation window extends; one constant in node-sdk (TC-2005)",
};

/** Canonical CI run 40343675308 (TC-2096, #759): the kv-storage worker rises by 340 bytes and replica.worker.js by 323; root is unchanged. Replica first import +279/+275 and activation -2/-2 were measured at run 40348732196 (Node 22 sqlite+postgres identical). */
export const approvedTc2096RepairBackoffRatchet: Tc2096RepairBackoffRatchet = {
  label: "capped replica repair backoff (TC-2096, #759): kv-storage worker +340 B, replica worker +323 B gzip, replica first import +279/+275 B, activation -2/-2 B",
  ruling: "Approved by Naomi (exact canonical CI bytes at runs 40343675308 and 40348732196; no headroom)",
  base: "dc74efaad0363281b19dc389e3a6a5467cfde2cb",
  sourceCommits: ["c6b4703d15cb8b711f16629d8ee0fe2da1b3c675"],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40343675308",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40343675308/job/121644785274",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40343675308/job/121644785810",
    ],
  },
  root: {
    delta: { "index.mjs": 0, "index.cjs": 0 },
    ceiling: { "index.mjs": 1467358, "index.cjs": 1409273 },
  },
  firstImport: {
    delta: { "replica.mjs": 279, "replica.cjs": 275 },
    ceiling: { "replica.mjs": 52653, "replica.cjs": 67846 },
  },
  activation: {
    delta: { "activation.mjs": -2, "activation.cjs": -2 },
    ceiling: { "activation.mjs": 23386, "activation.cjs": 24959 },
  },
  worker: { delta: 340, ceiling: 776468 },
  replicaWorker: { delta: 323, ceiling: 770416 },
  reason: "the replica retries a value it could not verify with growing gaps and gives up after five tries (TC-2096)",
};

/** Canonical CI run 40348214990 (TC-2072, #754): root index.mjs is carried (delta 0) and index.cjs rises by 8 bytes over TC-2096; first import, activation and worker carry TC-2096's ceilings. */
export const approvedTc2072LocationGuardRatchet: Tc2072LocationGuardRatchet = {
  label: "constructing TinyCloudWeb without a location skips UI client registration (TC-2072, #754): +0 B mjs / +8 B cjs gzip",
  ruling: "Approved by Naomi (measured at run 40348214990 within 10 bytes of the approved +7/+7; the mjs ceiling is carried)",
  base: "5467d1248b20e59d3b7eca508da417c2b35316b3",
  sourceCommits: ["1b6b4fddd31630f0287464808feb1ef82e449ef6"],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40348214990",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40348214990/job/121660792942",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40348214990/job/121660792806",
    ],
  },
  root: {
    delta: { "index.mjs": 0, "index.cjs": 8 },
    ceiling: { "index.mjs": 1467358, "index.cjs": 1409281 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 52653, "replica.cjs": 67846 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23386, "activation.cjs": 24959 },
  },
  worker: { delta: 0, ceiling: 776468 },
  replicaWorker: { delta: 0, ceiling: 770416 },
  reason: "constructing TinyCloudWeb without a location skips UI client registration (TC-2072)",
};

/** Canonical CI run 40366506455 measured the kv-storage worker +71 bytes and the replica worker +51 bytes (TC-2096, #761). Canonical CI run 40370497109 measured the replica first import +104/+111 bytes and IDB activation +26/+22 bytes on this row's head (sqlite and postgres identical). The root is carried at the TC-2072 ceilings with zero delta. */
export const approvedTc2096LazyContentRatchet: Tc2096LazyContentRatchet = {
  label: "lazy content fetch (TC-2096, #761): kv-storage worker +71 B, replica worker +51 B, replica first import +104/+111 B, activation +26/+22 B gzip; root unchanged",
  ruling: "Worker bytes measured at canonical CI run 40366506455; replica first-import and activation bytes measured at canonical CI run 40370497109 (sqlite and postgres identical); exact-byte approval by Naomi",
  base: "7ed3546aa5211798aef89bdc0414131f2d7af6fb",
  sourceCommits: ["10470576f0f2b2abbec3fb760a199e046929c5af"],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40370497109",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40370497109/job/121739610898",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40370497109/job/121739611355",
    ],
  },
  root: {
    delta: { "index.mjs": 0, "index.cjs": 0 },
    ceiling: { "index.mjs": 1467358, "index.cjs": 1409281 },
  },
  firstImport: {
    delta: { "replica.mjs": 104, "replica.cjs": 111 },
    ceiling: { "replica.mjs": 52757, "replica.cjs": 67957 },
  },
  activation: {
    delta: { "activation.mjs": 26, "activation.cjs": 22 },
    ceiling: { "activation.mjs": 23412, "activation.cjs": 24981 },
  },
  worker: { delta: 71, ceiling: 776539 },
  replicaWorker: { delta: 51, ceiling: 770467 },
  reason: "lazy content fetch syncs entry names without downloading values; reads of values the replica does not hold go to the network (TC-2096)",
};

/** Canonical CI run 40385555260 (TC-2113, #763; measured at 2cd7543e): root index.mjs rises 1641 B and index.cjs 1241 B over TC-2096's lazy-content root ceilings (1467358 / 1409281); first import, activation and worker carry the lazy row's ceilings with zero delta. */
export const approvedTc2113PanelGrantRatchet: Tc2113PanelGrantRatchet = {
  label: "panel button asks for the missing delegation-list permission (TC-2113, #763): +1641 B mjs / +1241 B cjs gzip",
  ruling: "Approved by Naomi (root ~+1,638 mjs / +1,397 cjs gz; measured at run 40385555260 at 2cd7543e: +1,641 / +1,241, within ±10 B)",
  base: "3b372a100fa7841d9a359d8f5d2f5995588e93e4",
  sourceCommits: ["20a872e061bf2818a7234b9dbe1b6dc29e497e3d"],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40385555260",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40385555260/job/121792750507",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40385555260/job/121792750969",
    ],
  },
  root: {
    delta: { "index.mjs": 1641, "index.cjs": 1241 },
    ceiling: { "index.mjs": 1468999, "index.cjs": 1410522 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 52757, "replica.cjs": 67957 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23412, "activation.cjs": 24981 },
  },
  worker: { delta: 0, ceiling: 776539 },
  replicaWorker: { delta: 0, ceiling: 770467 },
  reason: "the panel button asks for the missing delegation-list permission (TC-2113)",
};

/** Canonical CI run 40398188413 measured TinyCloudWeb._init reading window.location defensively at bad61a5c: root +1 mjs / +3 cjs gzip (TC-2127, #764). The worker and replica-worker ceilings are carried from the panel-grant row (TC-2113) with zero delta. */
export const approvedTc2127WindowLocationRatchet: Tc2127WindowLocationRatchet = {
  label: "TinyCloudWeb reads the SIWE domain without a window location (TC-2127, #764): +1 B mjs / +3 B cjs gzip",
  ruling: "Approved by Naomi (root +1 mjs / +3 cjs gz; measured at run 40398188413 at bad61a5c)",
  base: "533992691700b413fe64e1a9e9bfbca0f1f576b9",
  sourceCommits: ["134bc7b152166a617997a85851ebad98e62c93c0"],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40398188413",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40398188413/job/121836727416",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40398188413/job/121836727922",
    ],
  },
  root: {
    delta: { "index.mjs": 1, "index.cjs": 3 },
    ceiling: { "index.mjs": 1469000, "index.cjs": 1410525 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 52757, "replica.cjs": 67957 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23412, "activation.cjs": 24981 },
  },
  worker: { delta: 0, ceiling: 776539 },
  replicaWorker: { delta: 0, ceiling: 770467 },
  reason: "TinyCloudWeb._init reads the SIWE domain defensively when window.location is absent (TC-2127)",
};

/** Canonical CI run 40405133617 measured signInWithOpenKey on head 1d937c89 (after master merge), over the window location row (TC-2127, #764): root +957 mjs / +1025 cjs gzip over TC-2127 (TC-1977, #747). The worker and replica-worker ceilings are carried from TC-2127 with zero delta. */
export const approvedTc1977OpenKeySigninRatchet: Tc1977OpenKeySigninRatchet = {
  label: "signInWithOpenKey for the node SDK and web SDK (TC-1977, #747): +957 B mjs / +1025 B cjs gzip",
  ruling: "Approved by Naomi (root +955 mjs / +1,027 cjs gz at run 40398554596; stacked measurement at run 40405133617 at 1d937c89: +957 / +1,025, within ±10 B)",
  base: "f926276e5c97c36e3dbff5c18accbcddbb11e56b",
  sourceCommits: ["a21c5edce78ff53dcd3e075ef1658a092f931052"],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40405133617",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40405133617/job/121860849330",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40405133617/job/121860849456",
    ],
  },
  root: {
    delta: { "index.mjs": 957, "index.cjs": 1025 },
    ceiling: { "index.mjs": 1469957, "index.cjs": 1411550 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 52757, "replica.cjs": 67957 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23412, "activation.cjs": 24981 },
  },
  worker: { delta: 0, ceiling: 776539 },
  replicaWorker: { delta: 0, ceiling: 770467 },
  reason: "signInWithOpenKey adds the OpenKey sign-in path to the node and web SDKs (TC-1977)",
};

/** Predicted canonical bytes for the iPhone panel safe-area and ui.setButtonVisible (TC-2130, #765): TC-1977 plus +303 mjs / +282 cjs measured at run 40410108641 on head 89ef6f52; CI at the merged head is the authority. Worker and replica-worker ceilings are carried from TC-1977 with zero delta. */
export const approvedTc2130PanelIphoneRatchet: Tc2130PanelIphoneRatchet = {
  label: "iPhone panel safe-area and ui.setButtonVisible (TC-2130, #765): +303 B mjs / +282 B cjs gzip",
  ruling: "Approved by Naomi (root ~+344 mjs / +303 cjs gz; measured +303 / +282 stacked on #747 at run 40410108641 at 89ef6f52)",
  base: "33b16c5569efa4aa8458ee9ea4b2c53da8c2c820",
  sourceCommits: ["517e67264730211ea4df9b3225b842000578185b"],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40410108641",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40410108641/job/121878363620",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40410108641/job/121878363692",
    ],
  },
  root: {
    delta: { "index.mjs": 303, "index.cjs": 282 },
    ceiling: { "index.mjs": 1470260, "index.cjs": 1411832 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 52757, "replica.cjs": 67957 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23412, "activation.cjs": 24981 },
  },
  worker: { delta: 0, ceiling: 776539 },
  replicaWorker: { delta: 0, ceiling: 770467 },
  reason: "iPhone panel safe-area and ui.setButtonVisible (TC-2130)",
};

/** Predicted-then-measured canonical bytes for the isAppKeyHostBound export (TC-1977, #767): TC-2130 plus +55 mjs / +171 cjs measured at run 40419335009 on head 32ed8997. Worker and replica-worker ceilings are carried from TC-2130 with zero delta. */
export const approvedTc1977HostBindingRatchet: Tc1977HostBindingRatchet = {
  label: "isAppKeyHostBound export for the node SDK and web SDK (TC-1977, #767): +55 B mjs / +171 B cjs gzip",
  ruling: "Approved by Naomi (root +55 mjs / +171 cjs gz; measured at run 40419335009 at 32ed8997)",
  base: "c91a76fd298c1ee0ae68f56b2dca6506bf77ac2c",
  sourceCommits: ["32ed899747876650da43fe204d7f61434902dd12"],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40419335009",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40419335009/job/121909541826",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40419335009/job/121909542255",
    ],
  },
  root: {
    delta: { "index.mjs": 55, "index.cjs": 171 },
    ceiling: { "index.mjs": 1470315, "index.cjs": 1412003 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 52757, "replica.cjs": 67957 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23412, "activation.cjs": 24981 },
  },
  worker: { delta: 0, ceiling: 776539 },
  replicaWorker: { delta: 0, ceiling: 770467 },
  reason: "isAppKeyHostBound export for the node SDK and web SDK (TC-1977)",
};

export const approvedTc2132IssuedDelegationsRatchet: Tc2132IssuedDelegationsRatchet = {
  label: "delegations the delegate key issued: list and revoke, lazy-loaded (TC-2132, #766): +335 B mjs / +489 B cjs gzip",
  ruling: "Approved by Naomi (root ~+339 mjs / +360 cjs gz; measured +335 / +489 at run 40423860053 at 49f3665a, re-stacked on #767; stack-drift rule)",
  base: "9072053988179864d89ef9fb04e707ba66398a42",
  sourceCommits: ["49f3665ac1d66fe5f77cd28e9311329ba4970074"],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40423860053",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40423860053/job/121924641880",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40423860053/job/121924641891",
    ],
  },
  root: {
    delta: { "index.mjs": 335, "index.cjs": 489 },
    ceiling: { "index.mjs": 1470650, "index.cjs": 1412492 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 52757, "replica.cjs": 67957 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23412, "activation.cjs": 24981 },
  },
  worker: { delta: 0, ceiling: 776539 },
  replicaWorker: { delta: 0, ceiling: 770467 },
  reason: "delegations the delegate key issued: list and revoke, lazy-loaded (TC-2132)",
};

export const approvedTc2140ExactKeyDelegationRatchet: Tc2140ExactKeyDelegationRatchet = {
  label: "delegateTo exact named-key decrypt child (TC-2140, #769): +1204 B mjs / +142 B cjs gzip",
  ruling: "Approved by Naomi (up to +1,300 mjs / +350 cjs gz at CI bytes; measured +1,204 / +142 at run 40435549067 at f1678054, stand-alone on master 98b27a873; stack-drift rule)",
  base: "98b27a8731798bc3af3a56df1a54a1212f1ab74a",
  sourceCommits: ["f167805418040cbead1b4c850af0f6fa751d1474"],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40435549067",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40435549067/job/121963239730",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40435549067/job/121963239909",
    ],
  },
  root: {
    delta: { "index.mjs": 1204, "index.cjs": 142 },
    ceiling: { "index.mjs": 1471854, "index.cjs": 1412634 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 52757, "replica.cjs": 67957 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23412, "activation.cjs": 24981 },
  },
  worker: { delta: 0, ceiling: 776539 },
  replicaWorker: { delta: 0, ceiling: 770467 },
  reason: "delegateTo exact named-key decrypt child (TC-2140)",
};
export const approvedTc2202AgentShareReceiveRatchet: Tc2202AgentShareReceiveRatchet = {
  label: "recipient-agent share receive, exact V3 email leaf decrypt (TC-2202, #781)",
  ruling: "Approved by Naomi (TC-858 comment 4fb35c92): exact root ceilings 1,474,783/1,415,181 B; attributable +3,075/+2,525 B over exact base 24ffc3398bab34662a3b3b282deb888fd8378f35; additive ceiling increase +2,929/+2,547 B over TC-2140; no headroom",
  base: "24ffc3398bab34662a3b3b282deb888fd8378f35",
  sourceCommits: ["4eeed123ce9ee679c75fe879a17feb626c5d2e9a"],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40639085082",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40639085082/job/122652758353",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40639085082/job/122652758379",
    ],
  },
  root: {
    delta: { "index.mjs": 2929, "index.cjs": 2547 },
    ceiling: { "index.mjs": 1474783, "index.cjs": 1415181 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 52757, "replica.cjs": 67957 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23412, "activation.cjs": 24981 },
  },
  worker: { delta: 0, ceiling: 776539 },
  replicaWorker: { delta: 0, ceiling: 770467 },
  reason: "TC-2202 recipient-agent share receive with exact V3 email leaf decryption; candidate measured +3,075 B index.mjs / +2,525 B index.cjs over the exact base.",
};

export const approvedTc2205HomeFeedRatchet: Tc2205HomeFeedRatchet = {
  label: "Home hook readiness, logical SQL scopes and private SQL failures (TC-2205, #789)",
  ruling: "Latest conditional TC-858 ruling (comment dbed46da): exact current-base root ceilings 1,474,948/1,415,447 B; additive cap increments +165/+266 B above unchanged TC-2202; no headroom or controlled feature attribution. Canonical Bun 1.3.14; rustc 1.99.0 (b940084d7 2026-09-28).",
  base: "9006c2da03848610295f5d91828aa960fd08715d",
  sourceCommits: ["f5e2851258cdfbcd38ef177913d2d9a13aaaaf82"],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40820714206",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40820714206/job/123272293890",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40820714206/job/123272293953",
    ],
  },
  root: {
    delta: { "index.mjs": 165, "index.cjs": 266 },
    ceiling: { "index.mjs": 1474948, "index.cjs": 1415447 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 52757, "replica.cjs": 67957 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23412, "activation.cjs": 24981 },
  },
  worker: { delta: 0, ceiling: 776539 },
  replicaWorker: { delta: 0, ceiling: 770467 },
  reason: "Both canonical backends agree after the private-error allocation cut and actual upstream merge. This row admits only the measured absolute root sizes; it does not add a controlled-attribution charge or change another size bucket.",
};

export const approvedTc2230SiweRecipientsRatchet: Tc2230SiweRecipientsRatchet = {
  label: "signed recipients SIWE resource insertion (TC-2230, #794)",
  ruling: "Naomi approved up to +350 B per root format. Exact canonical CI at #794 source head b61e4869967e4a73ad7b0b567205dffb5692df9a measures 1,475,218/1,415,638 B, +270/+191 B over the TC-2205 ceilings and within the approved maximum; unused allowance is not retained. Local pre-sign estimate was +160/+314 B; CI differs by +110/-123 B. Bun 1.3.14; rustc 1.99.0 (b940084d7 2026-09-28).",
  base: "9838d6d9bd1a096c0d7316f448f4b5cb11b01c0f",
  sourceCommits: ["b61e4869967e4a73ad7b0b567205dffb5692df9a"],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40907518282",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40907518282/job/123566224035",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40907518282/job/123566224446",
    ],
  },
  root: {
    delta: { "index.mjs": 270, "index.cjs": 191 },
    ceiling: { "index.mjs": 1475218, "index.cjs": 1415638 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 52757, "replica.cjs": 67957 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23412, "activation.cjs": 24981 },
  },
  worker: { delta: 0, ceiling: 776539 },
  replicaWorker: { delta: 0, ceiling: 770467 },
  reason: "TC-2230 inserts the signed recipients SIWE resource; exact SQLite and PostgreSQL CI root gzip measurements agree. Only the root ceilings change; all other size buckets remain unchanged.",
};

export const approvedTc2192ExactKeyRuntimeConsentRatchet: Tc2192ExactKeyRuntimeConsentRatchet = {
  label: "exact Share-key runtime consent (TC-2192, #796)",
  ruling: "Naomi approved up to +700 B mjs and +1,200 B cjs over TC-2230. Exact canonical CI at source head 9f1ef80962458e2137039bbcee3c1adefff03f44 measures 1,475,277/1,416,790 B, +59/+1,152 B over TC-2230 and within approval; unused allowance is not retained. Bun 1.3.14; rustc 1.99.0 (b940084d7 2026-09-28).",
  base: "fd3d297c0688a6af14dc8606c7112d6bc900289c",
  sourceCommits: ["9f1ef80962458e2137039bbcee3c1adefff03f44"],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40923764869",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40923764869/job/123623682905",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40923764869/job/123623683110",
    ],
  },
  root: {
    delta: { "index.mjs": 59, "index.cjs": 1152 },
    ceiling: { "index.mjs": 1475277, "index.cjs": 1416790 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 52757, "replica.cjs": 67957 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23412, "activation.cjs": 24981 },
  },
  worker: { delta: 0, ceiling: 776539 },
  replicaWorker: { delta: 0, ceiling: 770467 },
  reason: "Verified: exact-head SQLite and PostgreSQL CI logs report identical aggregate root gzip sizes; no module-level attribution is present. At 9f1ef809, totals are 11 B smaller for mjs and 5 B smaller for cjs than at 45f8d6aa. Not verified: the cause of the 1,093 B CJS-versus-ESM delta gap; aggregate CI evidence cannot attribute it to a module/import or to base64UrlDecode.",
};

export const approvedTc2242WrappedKeyDigestRatchet: Tc2242WrappedKeyDigestRatchet = {
  label: "registered wrapped-key digest (TC-2242, #802)",
  ruling: "Exact canonical SQLite and PostgreSQL CI at source head aba2c4e37540cfb330b14be4fad7e078231047bb measures 1,475,309/1,416,810 B, +32/+20 B over TC-2192. Bun 1.3.14; rustc 1.99.0 (b940084d7 2026-09-28).",
  base: "b9f6185899c0e127c7782ce2a48d462a73b6d464",
  sourceCommits: ["aba2c4e37540cfb330b14be4fad7e078231047bb"],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40962482713",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40962482713/job/123758572691",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40962482713/job/123758572760",
    ],
  },
  root: {
    delta: { "index.mjs": 32, "index.cjs": 20 },
    ceiling: { "index.mjs": 1475309, "index.cjs": 1416810 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 52757, "replica.cjs": 67957 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23412, "activation.cjs": 24981 },
  },
  worker: { delta: 0, ceiling: 776539 },
  replicaWorker: { delta: 0, ceiling: 770467 },
  reason: "TC-2242 registered wrapped-key digest helper; exact SQLite and PostgreSQL CI root gzip measurements agree. All non-root size buckets are carried unchanged from TC-2192.",
};
export const approvedTc2113AllowAbilityRatchet: Tc2113AllowAbilityRatchet = {
  label: "panel Allow ability for the delegation list (TC-2113, #768)",
  ruling: "Exact canonical SQLite and PostgreSQL CI at source head f5c97c846265d62ae026bf30b4db7442926d78ca measures 1,475,824/1,417,412 B, +515/+602 B over TC-2242. Bun 1.3.14; rustc 1.99.0 (b940084d7 2026-09-28).",
  base: "d896e93edee5b2cdf14161c1f3f411dc7fc6c5bb",
  sourceCommits: ["f5c97c846265d62ae026bf30b4db7442926d78ca"],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/41041601835",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/41041601835/job/124015490543",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/41041601835/job/124015490874",
    ],
  },
  root: {
    delta: { "index.mjs": 515, "index.cjs": 602 },
    ceiling: { "index.mjs": 1475824, "index.cjs": 1417412 },
  },
  firstImport: {
    delta: { "replica.mjs": 0, "replica.cjs": 0 },
    ceiling: { "replica.mjs": 52757, "replica.cjs": 67957 },
  },
  activation: {
    delta: { "activation.mjs": 0, "activation.cjs": 0 },
    ceiling: { "activation.mjs": 23412, "activation.cjs": 24981 },
  },
  worker: { delta: 0, ceiling: 776539 },
  replicaWorker: { delta: 0, ceiling: 770467 },
  reason: "TC-2113 panel Allow ability row; exact SQLite and PostgreSQL CI root gzip measurements agree. All non-root size buckets are carried unchanged from TC-2242.",
};

export type GatedOnlyRatchet = {
  label: string;
  sourceCommit: string;
  measuredAt: string;
  toolchain: string;
  trigger: string;
  ceiling: { "replica-gated.mjs": number; "replica-gated.cjs": number };
};

export const approvedGatedOnlyRatchet: GatedOnlyRatchet = {
  label: "TC-858 refused-replica-admission observer, approved by Naomi 2026-10-16",
  sourceCommit: "212142ae1cf7ff8568d4172a2ca991a4d79364c7",
  measuredAt: "ddc032caef81a2177e7f9c30a6a28a8f593a4580",
  toolchain: "Bun 1.3.14; production webpack; gzip -9 -c",
  trigger: "Refused replica admission only: stale/missing/malformed restore or failed fresh establishment; never successful opt-in, replica-off, or sign-out.",
  ceiling: { "replica-gated.mjs": 926, "replica-gated.cjs": 1014 },
};

/** This is a distinct physical artifact; neither core nor first-import gains headroom. */
export function validateGatedOnlyRatchet(row?: GatedOnlyRatchet, base?: GatedOnlyRatchet): void {
  if (row !== undefined && JSON.stringify(row) !== JSON.stringify(approvedGatedOnlyRatchet)) {
    throw new Error("Only Naomi's exact measured TC-858 gated-only artifact ratchet is approved.");
  }
  if (base !== undefined && JSON.stringify(row) !== JSON.stringify(base)) {
    throw new Error("The gated-only artifact ratchet may not change after introduction.");
  }
}
const historicalToolchain = "Bun 1.4.3; production webpack; gzip -9 -c";

/** Every ledger row, except allowance and entries, with its approved constant. A row commit wires its constant here once. */
export const approvedLedgerRows: Record<string, unknown> = {
  phase2Ratchet: approvedPhase2,
  fixRequiredRatchet: approvedFixRequiredRatchet,
  canonicalToolchainCorrection: approvedCiToolchainCorrection,
  masterMergeResolution: approvedMasterMergeResolution,
  hardeningRatchet: approvedHardeningRatchet,
  logoutRatchet: approvedLogoutRatchet,
  tc1413Ratchet: approvedTc1413Ratchet,
  tc1436Ratchet: approvedTc1436Ratchet,
  tc1432Ratchet: approvedTc1432Ratchet,
  tc1424Ratchet: approvedTc1424Ratchet,
  tc1448Ratchet: approvedTc1448Ratchet,
  tc1443Ratchet: approvedTc1443Ratchet,
  tc1466Ratchet: approvedTc1466Ratchet,
  tc1443bRatchet: approvedTc1443bRatchet,
  tc1428Ratchet: approvedTc1428Ratchet,
  tc1476Ratchet: approvedTc1476Ratchet,
  tc1475Ratchet: approvedTc1475Ratchet,
  tc606WorkerRatchet: approvedTc606WorkerRatchet,
  masterDriftRatchet: approvedMasterDriftRatchet,
  tc1789Ratchet: approvedTc1789Ratchet,
  tc1757Ratchet: approvedTc1757Ratchet,
  tc1777Ratchet: approvedTc1777Ratchet,
  tc1777ExpiryRatchet: approvedTc1777ExpiryRatchet,
  tc848PanelRatchet: approvedTc848PanelRatchet,
  tc1781DecryptExpiryRatchet: approvedTc1781DecryptExpiryRatchet,
  tc1801NonTransferableShareRatchet: approvedTc1801NonTransferableShareRatchet,
  tc1807CredentialDiscoveryRatchet: approvedTc1807CredentialDiscoveryRatchet,
  tc1827WorkerRatchet: approvedTc1827WorkerRatchet,
  tc1827ReplicaWorkerRatchet: approvedTc1827ReplicaWorkerRatchet,
  tc1823SizeCodeRatchet: approvedTc1823SizeCodeRatchet,
  tc712CredentialCoreRatchet: approvedTc712CredentialCoreRatchet,
  tc1781DecryptStandardExpiryRatchet: approvedTc1781DecryptStandardExpiryRatchet,
  tc1855ManifestLimitGuardRatchet: approvedTc1855ManifestLimitGuardRatchet,
  tc1488SiweDomainUriRatchet: approvedTc1488SiweDomainUriRatchet,
  tc1737ShortLinkLazyChunkRatchet: approvedTc1737ShortLinkLazyChunkRatchet,
  tc1910SigningConsistencyRatchet: approvedTc1910SigningConsistencyRatchet,
  tc848SettingsPanelRatchet: approvedTc848SettingsPanelRatchet,
  tc2034NamedKeysCliRatchet: approvedTc2034NamedKeysCliRatchet,
  tc2043SyncScopeRatchet: approvedTc2043SyncScopeRatchet,
  tc1888PurgeLocalCopyRatchet: approvedTc1888PurgeLocalCopyRatchet,
  tc1977ManifestKeysRatchet: approvedTc1977ManifestKeysRatchet,
  tc2038PanelPrefetchRatchet: approvedTc2038PanelPrefetchRatchet,
  tc2005RevokeWindowRatchet: approvedTc2005RevokeWindowRatchet,
  tc2096RepairBackoffRatchet: approvedTc2096RepairBackoffRatchet,
  tc2072LocationGuardRatchet: approvedTc2072LocationGuardRatchet,
  tc2096LazyContentRatchet: approvedTc2096LazyContentRatchet,
  tc2113PanelGrantRatchet: approvedTc2113PanelGrantRatchet,
  tc2127WindowLocationRatchet: approvedTc2127WindowLocationRatchet,
  tc1977OpenKeySigninRatchet: approvedTc1977OpenKeySigninRatchet,
  tc2130PanelIphoneRatchet: approvedTc2130PanelIphoneRatchet,
  tc1977HostBindingRatchet: approvedTc1977HostBindingRatchet,
  tc2132IssuedDelegationsRatchet: approvedTc2132IssuedDelegationsRatchet,
  tc2140ExactKeyDelegationRatchet: approvedTc2140ExactKeyDelegationRatchet,
  tc2202AgentShareReceiveRatchet: approvedTc2202AgentShareReceiveRatchet,
  tc2205HomeFeedRatchet: approvedTc2205HomeFeedRatchet,
  tc2230SiweRecipientsRatchet: approvedTc2230SiweRecipientsRatchet,
  tc2192ExactKeyRuntimeConsentRatchet: approvedTc2192ExactKeyRuntimeConsentRatchet,
  tc2242WrappedKeyDigestRatchet: approvedTc2242WrappedKeyDigestRatchet,
  tc2113AllowAbilityRatchet: approvedTc2113AllowAbilityRatchet,
};

/** Only a git merge-base ledger may retain the pre-correction toolchain. */
export function validateLedger(value: Ledger, historicalBase = false): void {
  if (!value || !value.allowance || !Array.isArray(value.entries) ||
      Object.keys(value).some((key) => !["allowance", "entries"].includes(key) && !Object.hasOwn(approvedLedgerRows, key))) {
    throw new Error("Invalid packages/web-sdk/scripts/replica-size-ledger.json shape");
  }
  if (Object.keys(value.allowance).some((key) => !formats.includes(key as typeof formats[number]))) {
    throw new Error("Invalid packages/web-sdk/scripts/replica-size-ledger.json allowance shape");
  }
  for (const format of formats) {
    if (!Number.isFinite(value.allowance[format])) {
      throw new Error(`Invalid packages/web-sdk/scripts/replica-size-ledger.json allowance for ${format}`);
    }
  }
  for (const entry of value.entries) {
    if (!entry || Object.keys(entry).some((key) =>
      key !== "pr" && key !== "ticket" && key !== "note" && !formats.includes(key as typeof formats[number])) ||
        typeof entry.pr !== "string" || typeof entry.ticket !== "string" || typeof entry.note !== "string" ||
        formats.some((format) => !Number.isFinite(entry[format]))) {
      throw new Error("Invalid packages/web-sdk/scripts/replica-size-ledger.json entries[] item");
    }
  }
  const row = value.phase2Ratchet;
  if (row !== undefined) {
    if (value.allowance["index.mjs"] !== 388 || value.allowance["index.cjs"] !== 861 ||
        !row || Object.keys(row).some((key) =>
          !["label", "base", "toolchain", "baseline", "delta", "ceiling", "rationale", "safeCuts"].includes(key)) ||
        row.label !== approvedPhase2.label || row.base !== approvedPhase2.base ||
        (row.toolchain !== approvedPhase2.toolchain && !(historicalBase && row.toolchain === historicalToolchain)) ||
        formats.some((format) => row.baseline?.[format] !== approvedPhase2.baseline[format] ||
          row.delta?.[format] !== approvedPhase2.delta[format] ||
          row.ceiling?.[format] !== approvedPhase2.ceiling[format] ||
          row.baseline[format] + row.delta[format] !== row.ceiling[format]) ||
        !Array.isArray(row.rationale) || row.rationale.length < 3 ||
        row.rationale.some((item) => !item || Object.keys(item).some((key) =>
          !["module", "controlledMarginalBeforeSafeCuts", "requiredAtLoad"].includes(key)) ||
          typeof item.module !== "string" || item.module.length === 0 ||
          typeof item.requiredAtLoad !== "string" || item.requiredAtLoad.length < 40 ||
          formats.some((format) => !Number.isSafeInteger(item.controlledMarginalBeforeSafeCuts?.[format]))) ||
        typeof row.safeCuts !== "string" || row.safeCuts.length < 40) {
      throw new Error("TC-858 Phase 2 root ratchet must match Naomi's exact master9891 approval and document nonadditive file marginals");
    }
  }
  if (value.fixRequiredRatchet !== undefined &&
      (!value.phase2Ratchet ||
       JSON.stringify(value.fixRequiredRatchet) !== JSON.stringify(approvedFixRequiredRatchet))) {
    throw new Error("Only Naomi's exact ddc032ca fix-required root and first-import ratchet is approved.");
  }
  if (value.canonicalToolchainCorrection !== undefined &&
      (!value.fixRequiredRatchet || value.phase2Ratchet?.toolchain !== approvedPhase2.toolchain ||
       JSON.stringify(value.canonicalToolchainCorrection) !== JSON.stringify(approvedCiToolchainCorrection))) {
    throw new Error("Only the exact Rust 1.99.0 / Bun 1.3.14 CI measurement correction is approved.");
  }
  if (value.masterMergeResolution !== undefined &&
      (!value.canonicalToolchainCorrection ||
       JSON.stringify(value.masterMergeResolution) !== JSON.stringify(approvedMasterMergeResolution))) {
    throw new Error("Only Naomi's exact reviewed #564/#548 merged store, manifest, and lock blobs are approved.");
  }
  if (value.hardeningRatchet !== undefined &&
      (!value.masterMergeResolution ||
       JSON.stringify(value.hardeningRatchet) !== JSON.stringify(approvedHardeningRatchet))) {
    throw new Error("Only Naomi's exact canonical #565 fix-before-stable hardening ratchet is approved.");
  }
  if (value.logoutRatchet !== undefined &&
      (!value.hardeningRatchet || JSON.stringify(value.logoutRatchet) !== JSON.stringify(approvedLogoutRatchet))) {
    throw new Error("Only Naomi's exact canonical #571 sign-out contract ratchet is approved.");
  }
  if (value.tc1413Ratchet !== undefined &&
      (!value.logoutRatchet || JSON.stringify(value.tc1413Ratchet) !== JSON.stringify(approvedTc1413Ratchet))) {
    throw new Error("Only Naomi's exact canonical TC-1413 node-retry-errors ratchet is approved.");
  }
  if (value.tc1436Ratchet !== undefined &&
      (!value.tc1413Ratchet || JSON.stringify(value.tc1436Ratchet) !== JSON.stringify(approvedTc1436Ratchet))) {
    throw new Error("Only Naomi's exact canonical TC-1436 terminal-marker ratchet is approved.");
  }
  if (value.tc1432Ratchet !== undefined &&
      (!value.tc1436Ratchet || JSON.stringify(value.tc1432Ratchet) !== JSON.stringify(approvedTc1432Ratchet))) {
    throw new Error("Only Naomi's exact canonical TC-1432 vault etag/ifMatch/expectAad ratchet is approved.");
  }
  if (value.tc1424Ratchet !== undefined &&
      (!value.tc1432Ratchet || JSON.stringify(value.tc1424Ratchet) !== JSON.stringify(approvedTc1424Ratchet))) {
    throw new Error("Only Naomi's exact canonical TC-1424 receiver-key ratchet is approved.");
  }
  if (value.tc1448Ratchet !== undefined &&
      (!value.tc1424Ratchet || JSON.stringify(value.tc1448Ratchet) !== JSON.stringify(approvedTc1448Ratchet))) {
    throw new Error("Only Naomi's exact canonical TC-1448 terminal-grant recipient guard ratchet is approved.");
  }
  if (value.tc1443Ratchet !== undefined &&
      (!value.tc1448Ratchet || JSON.stringify(value.tc1443Ratchet) !== JSON.stringify(approvedTc1443Ratchet))) {
    throw new Error("Only the exact canonical TC-1443 registry-verdict ratchet is approved.");
  }
  if (value.tc1466Ratchet !== undefined &&
      (!value.tc1443Ratchet || JSON.stringify(value.tc1466Ratchet) !== JSON.stringify(approvedTc1466Ratchet))) {
    throw new Error("Only Naomi's exact canonical TC-1466 receiver-key clock race ratchet is approved.");
  }
  if (value.tc1443bRatchet !== undefined &&
      (!value.tc1466Ratchet || JSON.stringify(value.tc1443bRatchet) !== JSON.stringify(approvedTc1443bRatchet))) {
    throw new Error("Only the exact canonical TC-1443 slice b registry-policy ratchet is approved.");
  }
  if (value.tc1428Ratchet !== undefined &&
      (!value.tc1443bRatchet || JSON.stringify(value.tc1428Ratchet) !== JSON.stringify(approvedTc1428Ratchet))) {
    throw new Error("Only Naomi's exact canonical TC-1428 artifact-pin ratchet is approved.");
  }
  if (value.tc1476Ratchet !== undefined &&
      (!value.tc1428Ratchet || JSON.stringify(value.tc1476Ratchet) !== JSON.stringify(approvedTc1476Ratchet))) {
    throw new Error("Only Naomi's exact canonical TC-1476 registry-skip ratchet is approved.");
  }
  if (value.tc1475Ratchet !== undefined &&
      (!value.tc1428Ratchet || JSON.stringify(value.tc1475Ratchet) !== JSON.stringify(approvedTc1475Ratchet))) {
    throw new Error("Only Naomi's exact canonical TC-1475 retry ratchet is approved.");
  }
  if (value.tc606WorkerRatchet !== undefined &&
      (!value.tc1475Ratchet || JSON.stringify(value.tc606WorkerRatchet) !== JSON.stringify(approvedTc606WorkerRatchet))) {
    throw new Error("Only Naomi's exact canonical #606 worker ratchet is approved.");
  }
  if (value.masterDriftRatchet !== undefined &&
      (!value.tc606WorkerRatchet || JSON.stringify(value.masterDriftRatchet) !== JSON.stringify(approvedMasterDriftRatchet))) {
    throw new Error("Only Naomi's exact canonical master-drift ratchet is approved.");
  }
  if (value.tc1789Ratchet !== undefined &&
      (!value.masterDriftRatchet || JSON.stringify(value.tc1789Ratchet) !== JSON.stringify(approvedTc1789Ratchet))) {
    throw new Error("Only Naomi's exact canonical sdk-services 3.3.1 pin ratchet is approved.");
  }
  if (value.tc1757Ratchet !== undefined &&
      (!value.tc1789Ratchet || JSON.stringify(value.tc1757Ratchet) !== JSON.stringify(approvedTc1757Ratchet))) {
    throw new Error("Only Naomi's exact canonical web-recipient entry ratchet is approved.");
  }
  if (value.tc1777Ratchet !== undefined &&
      (!value.tc1757Ratchet || JSON.stringify(value.tc1777Ratchet) !== JSON.stringify(approvedTc1777Ratchet))) {
    throw new Error("Only Naomi's exact canonical replication-wiring boundary ratchet is approved.");
  }
  if (value.tc1777ExpiryRatchet !== undefined &&
      (!value.tc1777Ratchet || JSON.stringify(value.tc1777ExpiryRatchet) !== JSON.stringify(approvedTc1777ExpiryRatchet))) {
    throw new Error("Only Naomi's exact canonical expiryMs / hasPermissions ratchet is approved.");
  }
  if (value.tc848PanelRatchet !== undefined &&
      (!value.tc1777ExpiryRatchet || JSON.stringify(value.tc848PanelRatchet) !== JSON.stringify(approvedTc848PanelRatchet))) {
    throw new Error("Only Naomi's exact canonical developer request log panel ratchet is approved.");
  }
  if (value.tc1781DecryptExpiryRatchet !== undefined &&
      (!value.tc848PanelRatchet || JSON.stringify(value.tc1781DecryptExpiryRatchet) !== JSON.stringify(approvedTc1781DecryptExpiryRatchet))) {
    throw new Error("Only Naomi's exact canonical one-hour decrypt default ratchet is approved.");
  }
  if (value.tc1801NonTransferableShareRatchet !== undefined &&
      (!value.tc1781DecryptExpiryRatchet || JSON.stringify(value.tc1801NonTransferableShareRatchet) !== JSON.stringify(approvedTc1801NonTransferableShareRatchet))) {
    throw new Error("Only Naomi's exact canonical non-transferable share option ratchet is approved.");
  }
  if (value.tc1807CredentialDiscoveryRatchet !== undefined &&
      (!value.tc1801NonTransferableShareRatchet || JSON.stringify(value.tc1807CredentialDiscoveryRatchet) !== JSON.stringify(approvedTc1807CredentialDiscoveryRatchet))) {
    throw new Error("Only Naomi's exact canonical credential discovery ratchet is approved.");
  }
  if (value.tc1827WorkerRatchet !== undefined &&
      (!value.tc1807CredentialDiscoveryRatchet || JSON.stringify(value.tc1827WorkerRatchet) !== JSON.stringify(approvedTc1827WorkerRatchet))) {
    throw new Error("Only Naomi's exact canonical replica worker narrow-imports ratchet is approved.");
  }
  if (value.tc1827ReplicaWorkerRatchet !== undefined &&
      (!value.tc1827WorkerRatchet || JSON.stringify(value.tc1827ReplicaWorkerRatchet) !== JSON.stringify(approvedTc1827ReplicaWorkerRatchet))) {
    throw new Error("Only the exact canonical replica worker ratchet is approved.");
  }
  if (value.tc1823SizeCodeRatchet !== undefined &&
      (!value.tc1827WorkerRatchet || JSON.stringify(value.tc1823SizeCodeRatchet) !== JSON.stringify(approvedTc1823SizeCodeRatchet))) {
    throw new Error("Only Naomi's exact canonical request-size error code ratchet is approved.");
  }
  if (value.tc712CredentialCoreRatchet !== undefined &&
      (!value.tc1823SizeCodeRatchet || JSON.stringify(value.tc712CredentialCoreRatchet) !== JSON.stringify(approvedTc712CredentialCoreRatchet))) {
    throw new Error("Only Naomi's exact canonical credential consumer core ratchet is approved.");
  }
  if (value.tc1781DecryptStandardExpiryRatchet !== undefined &&
      (!value.tc712CredentialCoreRatchet || JSON.stringify(value.tc1781DecryptStandardExpiryRatchet) !== JSON.stringify(approvedTc1781DecryptStandardExpiryRatchet))) {
    throw new Error("Only Naomi's exact canonical decrypt standard expiry ratchet is approved.");
  }
  if (value.tc1855ManifestLimitGuardRatchet !== undefined &&
      (!value.tc1781DecryptStandardExpiryRatchet || JSON.stringify(value.tc1855ManifestLimitGuardRatchet) !== JSON.stringify(approvedTc1855ManifestLimitGuardRatchet))) {
    throw new Error("Only Naomi's exact canonical manifest limit guard ratchet is approved.");
  }
  if (value.tc1488SiweDomainUriRatchet !== undefined &&
      (!value.tc1855ManifestLimitGuardRatchet || JSON.stringify(value.tc1488SiweDomainUriRatchet) !== JSON.stringify(approvedTc1488SiweDomainUriRatchet))) {
    throw new Error("Only Naomi's exact canonical SIWE domain and URI ratchet is approved.");
  }
  if (value.tc1737ShortLinkLazyChunkRatchet !== undefined &&
      (!value.tc1488SiweDomainUriRatchet || JSON.stringify(value.tc1737ShortLinkLazyChunkRatchet) !== JSON.stringify(approvedTc1737ShortLinkLazyChunkRatchet))) {
    throw new Error("Only Naomi's exact canonical short-link ratchet is approved.");
  }
  if (value.tc1910SigningConsistencyRatchet !== undefined &&
      (!value.tc1737ShortLinkLazyChunkRatchet || JSON.stringify(value.tc1910SigningConsistencyRatchet) !== JSON.stringify(approvedTc1910SigningConsistencyRatchet))) {
    throw new Error("Only Naomi's exact canonical signing-consistency ratchet is approved.");
  }
  if (value.tc848SettingsPanelRatchet !== undefined &&
      (!value.tc1910SigningConsistencyRatchet || JSON.stringify(value.tc848SettingsPanelRatchet) !== JSON.stringify(approvedTc848SettingsPanelRatchet))) {
    throw new Error("Only Naomi's exact canonical panel ratchet is approved.");
  }
  if (value.tc2034NamedKeysCliRatchet !== undefined &&
      (!value.tc848SettingsPanelRatchet || JSON.stringify(value.tc2034NamedKeysCliRatchet) !== JSON.stringify(approvedTc2034NamedKeysCliRatchet))) {
    throw new Error("Only Naomi's exact canonical named-keys ratchet is approved.");
  }
  if (value.tc2043SyncScopeRatchet !== undefined &&
      (!value.tc2034NamedKeysCliRatchet || JSON.stringify(value.tc2043SyncScopeRatchet) !== JSON.stringify(approvedTc2043SyncScopeRatchet))) {
    throw new Error("Only Naomi's exact canonical replication syncScope ratchet is approved.");
  }
  if (value.tc1888PurgeLocalCopyRatchet !== undefined &&
      (!value.tc2043SyncScopeRatchet || JSON.stringify(value.tc1888PurgeLocalCopyRatchet) !== JSON.stringify(approvedTc1888PurgeLocalCopyRatchet))) {
    throw new Error("Only Naomi's exact canonical sign-out local copy ratchet is approved.");
  }
  if (value.tc1977ManifestKeysRatchet !== undefined &&
      (!value.tc1888PurgeLocalCopyRatchet || JSON.stringify(value.tc1977ManifestKeysRatchet) !== JSON.stringify(approvedTc1977ManifestKeysRatchet))) {
    throw new Error("Only Naomi's exact canonical manifest-keys ratchet is approved.");
  }
  if (value.tc2038PanelPrefetchRatchet !== undefined &&
      (!value.tc1977ManifestKeysRatchet || JSON.stringify(value.tc2038PanelPrefetchRatchet) !== JSON.stringify(approvedTc2038PanelPrefetchRatchet))) {
    throw new Error("Only Naomi's exact canonical panel-prefetch ratchet is approved.");
  }
  if (value.tc2005RevokeWindowRatchet !== undefined &&
      (!value.tc2038PanelPrefetchRatchet || JSON.stringify(value.tc2005RevokeWindowRatchet) !== JSON.stringify(approvedTc2005RevokeWindowRatchet))) {
    throw new Error("Only Naomi's exact canonical owner revocation-window ratchet is approved.");
  }
  if (value.tc2096RepairBackoffRatchet !== undefined &&
      (!value.tc2005RevokeWindowRatchet || JSON.stringify(value.tc2096RepairBackoffRatchet) !== JSON.stringify(approvedTc2096RepairBackoffRatchet))) {
    throw new Error("Only Naomi's exact canonical repair-backoff ratchet is approved.");
  }
  if (value.tc2072LocationGuardRatchet !== undefined &&
      (!value.tc2096RepairBackoffRatchet || JSON.stringify(value.tc2072LocationGuardRatchet) !== JSON.stringify(approvedTc2072LocationGuardRatchet))) {
    throw new Error("Only Naomi's exact canonical location-guard ratchet is approved.");
  }
  if (value.tc2096LazyContentRatchet !== undefined &&
      (!value.tc2072LocationGuardRatchet || JSON.stringify(value.tc2096LazyContentRatchet) !== JSON.stringify(approvedTc2096LazyContentRatchet))) {
    throw new Error("Only the exact canonical lazy-content ratchet is approved.");
  }
  if (value.tc2113PanelGrantRatchet !== undefined &&
      (!value.tc2096LazyContentRatchet || JSON.stringify(value.tc2113PanelGrantRatchet) !== JSON.stringify(approvedTc2113PanelGrantRatchet))) {
    throw new Error("Only Naomi's exact canonical panel grant ratchet is approved.");
  }
  if (value.tc2127WindowLocationRatchet !== undefined &&
      (!value.tc2113PanelGrantRatchet || JSON.stringify(value.tc2127WindowLocationRatchet) !== JSON.stringify(approvedTc2127WindowLocationRatchet))) {
    throw new Error("Only Naomi's exact canonical window location ratchet is approved.");
  }
  if (value.tc1977OpenKeySigninRatchet !== undefined &&
      (!value.tc2127WindowLocationRatchet || JSON.stringify(value.tc1977OpenKeySigninRatchet) !== JSON.stringify(approvedTc1977OpenKeySigninRatchet))) {
    throw new Error("Only Naomi's exact canonical OpenKey sign-in ratchet is approved.");
  }
  if (value.tc2130PanelIphoneRatchet !== undefined &&
      (!value.tc1977OpenKeySigninRatchet || JSON.stringify(value.tc2130PanelIphoneRatchet) !== JSON.stringify(approvedTc2130PanelIphoneRatchet))) {
    throw new Error("Only Naomi's exact canonical panel safe-area ratchet is approved.");
  }
  if (value.tc1977HostBindingRatchet !== undefined &&
      (!value.tc2130PanelIphoneRatchet || JSON.stringify(value.tc1977HostBindingRatchet) !== JSON.stringify(approvedTc1977HostBindingRatchet))) {
    throw new Error("Only Naomi's exact canonical host-binding ratchet is approved.");
  }
  if (value.tc2132IssuedDelegationsRatchet !== undefined &&
      (!value.tc1977HostBindingRatchet || JSON.stringify(value.tc2132IssuedDelegationsRatchet) !== JSON.stringify(approvedTc2132IssuedDelegationsRatchet))) {
    throw new Error("Only Naomi's exact canonical issued-delegations ratchet is approved.");
  }
  if (value.tc2140ExactKeyDelegationRatchet !== undefined &&
      (!value.tc2132IssuedDelegationsRatchet || JSON.stringify(value.tc2140ExactKeyDelegationRatchet) !== JSON.stringify(approvedTc2140ExactKeyDelegationRatchet))) {
    throw new Error("Only Naomi's exact canonical exact-key delegation ratchet is approved.");
  }
  if (value.tc2202AgentShareReceiveRatchet !== undefined &&
      (!value.tc2140ExactKeyDelegationRatchet || JSON.stringify(value.tc2202AgentShareReceiveRatchet) !== JSON.stringify(approvedTc2202AgentShareReceiveRatchet))) {
    throw new Error("Only Naomi's exact canonical TC-2202 recipient-agent share receive ratchet is approved.");
  }
  if (value.tc2205HomeFeedRatchet !== undefined &&
      (!value.tc2202AgentShareReceiveRatchet || JSON.stringify(value.tc2205HomeFeedRatchet) !== JSON.stringify(approvedTc2205HomeFeedRatchet))) {
    throw new Error("Only the exact canonical TC-2205 Home feed root admission is approved.");
  }
  if (value.tc2230SiweRecipientsRatchet !== undefined &&
      (!value.tc2205HomeFeedRatchet || JSON.stringify(value.tc2230SiweRecipientsRatchet) !== JSON.stringify(approvedTc2230SiweRecipientsRatchet))) {
    throw new Error("Only Naomi's exact canonical TC-2230 signed-recipients SIWE resource ratchet is approved.");
  }
  if (value.tc2192ExactKeyRuntimeConsentRatchet !== undefined &&
      (!value.tc2230SiweRecipientsRatchet || JSON.stringify(value.tc2192ExactKeyRuntimeConsentRatchet) !== JSON.stringify(approvedTc2192ExactKeyRuntimeConsentRatchet))) {
    throw new Error("Only Naomi's exact canonical TC-2192 exact Share-key runtime consent ratchet is approved.");
  }
  if (value.tc2242WrappedKeyDigestRatchet !== undefined &&
      (!value.tc2192ExactKeyRuntimeConsentRatchet || JSON.stringify(value.tc2242WrappedKeyDigestRatchet) !== JSON.stringify(approvedTc2242WrappedKeyDigestRatchet))) {
    throw new Error("Only the exact canonical TC-2242 wrapped-key digest size row is approved.");
  }
  if (value.tc2113AllowAbilityRatchet !== undefined &&
      (!value.tc2242WrappedKeyDigestRatchet || JSON.stringify(value.tc2113AllowAbilityRatchet) !== JSON.stringify(approvedTc2113AllowAbilityRatchet))) {
    throw new Error("Only Naomi's exact canonical TC-2113 Allow ability ratchet is approved.");
  }
}

/** The #606 worker ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc606WorkerRatchetTransition(base?: WorkerRatchet, current?: WorkerRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc606WorkerRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact #606 worker ratchet may be introduced once and cannot change later.");
  }
}

/** The master-drift ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateMasterDriftRatchetTransition(base?: MasterDriftRatchet, current?: MasterDriftRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedMasterDriftRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact master-drift ratchet may be introduced once and cannot change later.");
  }
}

/** The sdk-services 3.3.1 pin ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1789RatchetTransition(base?: Tc1789Ratchet, current?: Tc1789Ratchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1789Ratchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact sdk-services 3.3.1 pin ratchet may be introduced once and cannot change later.");
  }
}

/** The web-recipient entry ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1757RatchetTransition(base?: Tc1757Ratchet, current?: Tc1757Ratchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1757Ratchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact web-recipient entry ratchet may be introduced once and cannot change later.");
  }
}

/** The replication-wiring boundary ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1777RatchetTransition(base?: Tc1777Ratchet, current?: Tc1777Ratchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1777Ratchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact replication-wiring boundary ratchet may be introduced once and cannot change later.");
  }
}

/** The expiryMs / hasPermissions ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1777ExpiryRatchetTransition(base?: Tc1777ExpiryRatchet, current?: Tc1777ExpiryRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1777ExpiryRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact expiryMs / hasPermissions ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-848 developer request log panel ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc848PanelRatchetTransition(base?: Tc848PanelRatchet, current?: Tc848PanelRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc848PanelRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-848 developer request log panel ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1781 one-hour decrypt default and secret-read coverage ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1781DecryptExpiryRatchetTransition(base?: Tc1781DecryptExpiryRatchet, current?: Tc1781DecryptExpiryRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1781DecryptExpiryRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1781 one-hour decrypt default ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1801 non-transferable share option ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1801NonTransferableShareRatchetTransition(base?: Tc1801NonTransferableShareRatchet, current?: Tc1801NonTransferableShareRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1801NonTransferableShareRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1801 non-transferable share ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1807 credential discovery ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1807CredentialDiscoveryRatchetTransition(base?: Tc1807CredentialDiscoveryRatchet, current?: Tc1807CredentialDiscoveryRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1807CredentialDiscoveryRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1807 credential discovery ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1827 worker ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1827WorkerRatchetTransition(base?: Tc1827WorkerRatchet, current?: Tc1827WorkerRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1827WorkerRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1827 replica worker narrow-imports ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1827 replica worker ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1827ReplicaWorkerRatchetTransition(base?: Tc1827ReplicaWorkerRatchet, current?: Tc1827ReplicaWorkerRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1827ReplicaWorkerRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1827 replica worker ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1823 request-size error code ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1823SizeCodeRatchetTransition(base?: Tc1823SizeCodeRatchet, current?: Tc1823SizeCodeRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1823SizeCodeRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1823 request-size error code ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-712 credential consumer core ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc712CredentialCoreRatchetTransition(base?: Tc712CredentialCoreRatchet, current?: Tc712CredentialCoreRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc712CredentialCoreRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-712 credential consumer core ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1781 decrypt standard expiry ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1781DecryptStandardExpiryRatchetTransition(base?: Tc1781DecryptStandardExpiryRatchet, current?: Tc1781DecryptStandardExpiryRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1781DecryptStandardExpiryRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1781 decrypt standard expiry ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1855 manifest limit guard ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1855ManifestLimitGuardRatchetTransition(base?: Tc1855ManifestLimitGuardRatchet, current?: Tc1855ManifestLimitGuardRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1855ManifestLimitGuardRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1855 manifest limit guard ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1488 SIWE domain/URI ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1488SiweDomainUriRatchetTransition(base?: Tc1488SiweDomainUriRatchet, current?: Tc1488SiweDomainUriRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1488SiweDomainUriRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1488 SIWE domain and URI ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1737 short-link ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1737ShortLinkLazyChunkRatchetTransition(base?: Tc1737ShortLinkLazyChunkRatchet, current?: Tc1737ShortLinkLazyChunkRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1737ShortLinkLazyChunkRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1737 short-link ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1910 signing-consistency ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1910SigningConsistencyRatchetTransition(base?: Tc1910SigningConsistencyRatchet, current?: Tc1910SigningConsistencyRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1910SigningConsistencyRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1910 signing-consistency ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-848 settings panel ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc848SettingsPanelRatchetTransition(base?: Tc848SettingsPanelRatchet, current?: Tc848SettingsPanelRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc848SettingsPanelRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-848 settings panel ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-2034 named-keys CLI ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc2034NamedKeysCliRatchetTransition(base?: Tc2034NamedKeysCliRatchet, current?: Tc2034NamedKeysCliRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc2034NamedKeysCliRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-2034 named-keys ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1888 sign-out local copy ratchet is introduced once and immutable afterwards. */
export function validateTc1888PurgeLocalCopyRatchetTransition(base?: Tc1888PurgeLocalCopyRatchet, current?: Tc1888PurgeLocalCopyRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1888PurgeLocalCopyRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1888 sign-out local copy ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-2043 replication syncScope ratchet is introduced once and immutable afterwards. */
export function validateTc2043SyncScopeRatchetTransition(base?: Tc2043SyncScopeRatchet, current?: Tc2043SyncScopeRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc2043SyncScopeRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-2043 replication syncScope ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1977 manifest-keys ratchet is introduced once and immutable afterwards. */
export function validateTc1977ManifestKeysRatchetTransition(base?: Tc1977ManifestKeysRatchet, current?: Tc1977ManifestKeysRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1977ManifestKeysRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1977 manifest-keys ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-2038 panel-prefetch ratchet is introduced once and immutable afterwards. */
export function validateTc2038PanelPrefetchRatchetTransition(base?: Tc2038PanelPrefetchRatchet, current?: Tc2038PanelPrefetchRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc2038PanelPrefetchRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-2038 panel-prefetch ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-2005 owner revocation-window ratchet is introduced once and immutable afterwards. */
export function validateTc2005RevokeWindowRatchetTransition(base?: Tc2005RevokeWindowRatchet, current?: Tc2005RevokeWindowRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc2005RevokeWindowRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-2005 owner revocation-window ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-2096 repair-backoff ratchet is introduced once and immutable afterwards. */
export function validateTc2096RepairBackoffRatchetTransition(base?: Tc2096RepairBackoffRatchet, current?: Tc2096RepairBackoffRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc2096RepairBackoffRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-2096 repair-backoff ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-2072 location-guard ratchet is introduced once and immutable afterwards. */
export function validateTc2072LocationGuardRatchetTransition(base?: Tc2072LocationGuardRatchet, current?: Tc2072LocationGuardRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc2072LocationGuardRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-2072 location-guard ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-2096 lazy-content ratchet is introduced once and immutable afterwards. */
export function validateTc2096LazyContentRatchetTransition(base?: Tc2096LazyContentRatchet, current?: Tc2096LazyContentRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc2096LazyContentRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-2096 lazy-content ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-2113 panel grant ratchet is introduced once and immutable afterwards. */
export function validateTc2113PanelGrantRatchetTransition(base?: Tc2113PanelGrantRatchet, current?: Tc2113PanelGrantRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc2113PanelGrantRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-2113 panel grant ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-2127 window location ratchet is introduced once and immutable afterwards. */
export function validateTc2127WindowLocationRatchetTransition(base?: Tc2127WindowLocationRatchet, current?: Tc2127WindowLocationRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc2127WindowLocationRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-2127 window location ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1977 OpenKey sign-in ratchet is introduced once and immutable afterwards. */
export function validateTc1977OpenKeySigninRatchetTransition(base?: Tc1977OpenKeySigninRatchet, current?: Tc1977OpenKeySigninRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1977OpenKeySigninRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1977 OpenKey sign-in ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-2130 panel safe-area ratchet is introduced once and immutable afterwards. */
export function validateTc2130PanelIphoneRatchetTransition(base?: Tc2130PanelIphoneRatchet, current?: Tc2130PanelIphoneRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc2130PanelIphoneRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-2130 panel safe-area ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1977 host-binding export ratchet is introduced once and immutable afterwards. */
export function validateTc1977HostBindingRatchetTransition(base?: Tc1977HostBindingRatchet, current?: Tc1977HostBindingRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1977HostBindingRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1977 host-binding ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-2132 issued-delegations ratchet is introduced once and immutable afterwards. */
export function validateTc2132IssuedDelegationsRatchetTransition(base?: Tc2132IssuedDelegationsRatchet, current?: Tc2132IssuedDelegationsRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc2132IssuedDelegationsRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-2132 issued-delegations ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-2140 exact-key delegation ratchet is introduced once and immutable afterwards. */
export function validateTc2140ExactKeyDelegationRatchetTransition(base?: Tc2140ExactKeyDelegationRatchet, current?: Tc2140ExactKeyDelegationRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc2140ExactKeyDelegationRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-2140 exact-key delegation ratchet may be introduced once and cannot change later.");
  }
}
/** The TC-2202 recipient-agent share receive ratchet is introduced once and immutable afterwards. */
export function validateTc2202AgentShareReceiveRatchetTransition(base?: Tc2202AgentShareReceiveRatchet, current?: Tc2202AgentShareReceiveRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc2202AgentShareReceiveRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The TC-2202 recipient-agent share receive ratchet may be introduced once and cannot change later.");
  }
}

/** The exact current-base Home admission may be introduced once and cannot later change or disappear. */
export function validateTc2205HomeFeedRatchetTransition(base?: Tc2205HomeFeedRatchet, current?: Tc2205HomeFeedRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc2205HomeFeedRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-2205 Home feed root admission may be introduced once and cannot change later.");
  }
}

/** The exact TC-2230 signed-recipients SIWE resource ratchet is introduced once and immutable afterwards. */
export function validateTc2230SiweRecipientsRatchetTransition(base?: Tc2230SiweRecipientsRatchet, current?: Tc2230SiweRecipientsRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc2230SiweRecipientsRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The TC-2230 signed-recipients SIWE resource ratchet may be introduced once and cannot change later.");
  }
}

/** The exact TC-2192 Share-key runtime consent ratchet is introduced once and immutable afterwards. */
export function validateTc2192ExactKeyRuntimeConsentRatchetTransition(base?: Tc2192ExactKeyRuntimeConsentRatchet, current?: Tc2192ExactKeyRuntimeConsentRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc2192ExactKeyRuntimeConsentRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The TC-2192 exact Share-key runtime consent ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-2242 wrapped-key digest ratchet is introduced once and immutable afterwards. */
export function validateTc2242WrappedKeyDigestRatchetTransition(base?: Tc2242WrappedKeyDigestRatchet, current?: Tc2242WrappedKeyDigestRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc2242WrappedKeyDigestRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The TC-2242 wrapped-key digest ratchet may be introduced once and cannot change later.");
  }
}
/** The TC-2113 Allow ability ratchet is introduced once and immutable afterwards. */
export function validateTc2113AllowAbilityRatchetTransition(base?: Tc2113AllowAbilityRatchet, current?: Tc2113AllowAbilityRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc2113AllowAbilityRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The TC-2113 Allow ability ratchet may be introduced once and cannot change later.");
  }
}

/** The resolved input blobs are introduced once and immutable in subsequent bases. */
export function validateMasterMergeResolutionTransition(
  base?: MasterMergeResolution, current?: MasterMergeResolution,
): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedMasterMergeResolution) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact #564/#548 merged-input resolution may be introduced once and cannot change later.");
  }
}

/** The hardening row is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateHardeningRatchetTransition(base?: HardeningRatchet, current?: HardeningRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedHardeningRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact #565 hardening ratchet may be introduced once and cannot change later.");
  }
}

/** The sign-out ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateLogoutRatchetTransition(base?: LogoutRatchet, current?: LogoutRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedLogoutRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact #571 sign-out ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1413 ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1413RatchetTransition(base?: Tc1413Ratchet, current?: Tc1413Ratchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1413Ratchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1413 ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1436 ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1436RatchetTransition(base?: Tc1436Ratchet, current?: Tc1436Ratchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1436Ratchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1436 ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1432 ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1432RatchetTransition(base?: Tc1432Ratchet, current?: Tc1432Ratchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1432Ratchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1432 ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1424 ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1424RatchetTransition(base?: Tc1424Ratchet, current?: Tc1424Ratchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1424Ratchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1424 ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1448 ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1448RatchetTransition(base?: Tc1448Ratchet, current?: Tc1448Ratchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1448Ratchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1448 ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1443 ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1443RatchetTransition(base?: Tc1443Ratchet, current?: Tc1443Ratchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1443Ratchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1443 ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1466 ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1466RatchetTransition(base?: Tc1466Ratchet, current?: Tc1466Ratchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1466Ratchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1466 ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1443 slice b ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1443bRatchetTransition(base?: Tc1443bRatchet, current?: Tc1443bRatchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1443bRatchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1443 slice b ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1428 ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1428RatchetTransition(base?: Tc1428Ratchet, current?: Tc1428Ratchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1428Ratchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1428 ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1476 ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1476RatchetTransition(base?: Tc1476Ratchet, current?: Tc1476Ratchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1476Ratchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1476 ratchet may be introduced once and cannot change later.");
  }
}

/** The TC-1475 ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1475RatchetTransition(base?: Tc1475Ratchet, current?: Tc1475Ratchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1475Ratchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1475 ratchet may be introduced once and cannot change later.");
  }
}

export function assertCiSizeToolchain(bun: string, rustcOutput: string, row: CiToolchainCorrection): void {
  const rustc = /^rustc (\d+\.\d+\.\d+)(?:\s|$)/.exec(rustcOutput)?.[1];
  if (bun !== row.toolchain.bun || rustc !== row.toolchain.rustc) {
    throw new Error(`TC-858 size toolchain mismatch: expected Bun ${row.toolchain.bun} and rustc ${row.toolchain.rustc}; received Bun ${bun} and ${rustcOutput}.`);
  }
}

export function validateCiToolchainTransition(
  base?: CiToolchainCorrection,
  current?: CiToolchainCorrection,
): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedCiToolchainCorrection) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The CI Rust 1.99.0 size correction may be introduced once and must remain unchanged thereafter.");
  }
}

// Webpack's index/replica/replica-gated entries and the replica tsup worker
// entry pull from these workspace packages (including transitive SDK and Share
// dependencies). No measured entry or dependency imports packages/cli.
const measuredPackagePrefixes = [
  "packages/web-sdk/",
  "packages/node-sdk/",
  "packages/sdk-services/",
  "packages/sdk-core/",
  "packages/replica/",
  "packages/sdk-rs/",
  "packages/bootstrap/",
  "packages/share-sdk/",
  "packages/share-envelope/",
] as const;

// The reviewed S0 sentence is contract text, not a module. Test files are
// admitted separately only after a fresh graph and emitted-map absence check.
const unbundledContract = "packages/sdk-services/src/kv/replication/CONTRACT.md";

function isCliNonInput(path: string): boolean {
  return path.startsWith("packages/cli/src/") ||
    path.startsWith("packages/cli/test/") ||
    path.startsWith("packages/cli/tests/") ||
    path.startsWith("packages/cli/__tests__/") ||
    path === "packages/cli/README.md" || path === "packages/cli/CHANGELOG.md";
}

function isMeasuredTest(path: string): boolean {
  return measuredPackagePrefixes.some((prefix) => path.startsWith(prefix)) &&
    (/\.test\.ts$/.test(path) || /\/(?:tests|__tests__)\//.test(path));
}

function isMeasuredArtifactInput(path: string): boolean {
  return path === "bun.lock" || path === "package.json" || path === "bunfig.toml" ||
    path === "turbo.json" || /^tsconfig(?:\.[^/]+)?\.json$/.test(path) ||
    path === ".github/workflows/replica-e2e.yml" ||
    (path.startsWith("packages/cli/") && !isCliNonInput(path)) ||
    measuredPackagePrefixes.some((prefix) => path.startsWith(prefix));
}

// A CLI implementation cannot enter either measured entry graph. Its manifest,
// scripts and configs can influence the CI build and remain frozen. Unknown
// paths fail closed, including executable files beside Changesets release notes.
// The I0 gate workflow builds only for packed CLI/MCP checks, never the size jobs.
export const ciCorrectionPolicyOnlyPaths: ReadonlySet<string> = new Set([
  ".github/workflows/tc-191-i0-gate.yml",
  "packages/replica/CHANGELOG.md",
  "packages/replica/README.md",
  "packages/replica/scripts/check-worker-size.test.ts",
  "packages/replica/scripts/check-worker-size.ts",
  "packages/web-sdk/README.md",
  "packages/web-sdk/scripts/check-phase1-replica-dist.ts",
  "packages/web-sdk/scripts/check-replica-built-entry.ts",
  "packages/web-sdk/scripts/replica-optional-size-ledger.json",
  "packages/web-sdk/scripts/replica-optional-size-policy.test.ts",
  "packages/web-sdk/scripts/replica-optional-size-policy.ts",
  "packages/web-sdk/scripts/replica-size-ledger.json",
  "packages/web-sdk/scripts/replica-size-policy.test.ts",
  "packages/web-sdk/scripts/replica-size-policy.ts",
  "packages/web-sdk/scripts/replica-size-inputs.ts",
]);

function changedPaths(root: string, from: string, to: string): Set<string> {
  const output = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", from, to], { cwd: root });
  return new Set(output.toString("utf8").split("\0").filter(Boolean));
}

function blobAt(root: string, ref: string, path: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", `${ref}:${path}`], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function isPolicyOnlySinceApprovedSource(
  root: string, approvedSource: string, allowed: ReadonlySet<string>, graph?: MeasuredInputGraph,
  approvedMeasuredBlobs: Readonly<Record<string, string>> = {}, masterBase?: string,
): boolean {
  if (spawnSync("git", ["merge-base", "--is-ancestor", approvedSource, "HEAD"], { cwd: root }).status !== 0) {
    return false;
  }
  // A path added and then renamed away may disappear from the source-to-HEAD
  // diff entirely. Require every approved blob to remain at its exact path.
  if (Object.entries(approvedMeasuredBlobs).some(([path, blob]) => blobAt(root, "HEAD", path) !== blob)) {
    return false;
  }
  let masterOrigin: ReadonlySet<string> = new Set();
  if (masterBase !== undefined) {
    if (spawnSync("git", ["merge-base", "--is-ancestor", masterBase, "HEAD"], { cwd: root }).status !== 0) {
      return false;
    }
    const oldBase = execFileSync("git", ["merge-base", approvedSource, masterBase], { cwd: root, encoding: "utf8" }).trim();
    const sourceToMaster = changedPaths(root, approvedSource, masterBase);
    masterOrigin = new Set([...changedPaths(root, oldBase, masterBase)].filter((path) => sourceToMaster.has(path)));
  }
  const changed = changedPaths(root, approvedSource, "HEAD");
  return [...changed].every((path) => {
    if (Object.hasOwn(approvedMeasuredBlobs, path)) return true;
    if (masterOrigin.has(path) && blobAt(root, "HEAD", path) === blobAt(root, masterBase!, path)) {
      return true;
    }
    if (allowed.has(path) || /^\.changeset\/[^/]+\.md$/.test(path) || path === unbundledContract) return true;
    if (isMeasuredArtifactInput(path) && !isMeasuredTest(path)) return false;
    if (!isMeasuredTest(path) && !isCliNonInput(path)) return false;
    return graph !== undefined && !graph.bundleInputs.has(path) && !graph.sourceMapInputs.has(path);
  });
}
