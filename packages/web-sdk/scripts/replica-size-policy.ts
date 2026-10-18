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
 * One reviewed exact-delta admission of js-sdk #582 (TC-1428): the owner-signed artifact pin the viewer
 * verifies. Only the root bundle grows, so the shape is the #571 root-only row.
 */
export type Tc1428Ratchet = LogoutRatchet;
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
  tc1428Ratchet?: Tc1428Ratchet;
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
 * Naomi's standing size rule applied to TC-1428 (js-sdk #582): after a real shrink, the artifact pin check is
 * admitted at exactly the bytes GitHub measured, root only, with no headroom. The row sits on top of the
 * TC-1443 root ceilings (#586 landed first).
 */
export const approvedTc1428Ratchet: Tc1428Ratchet = {
  label: "TC-1428 #582 owner-signed artifact pin for addressed shares, exact canonical delta",
  ruling: "Naomi's standing size rule for TC-1428 #582: a real shrink first, remainder by the PR's own exact-delta row at canonical CI bytes; rows chain after the latest row on master, so whichever PR lands later re-measures against the new base and updates its own row",
  base: "28ca77a0ce019d53aa61a6c5c3b39c52889e420d",
  sourceCommits: [
    "ae2b05bcfa00b5c15236a221d859160b6a5c4e65",
  ],
  canonicalCI: {
    run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39172089071",
    jobs: [
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39172089071/job/117807102974",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/39172089071/job/117807103034",
    ],
  },
  root: {
    delta: { "index.mjs": 911, "index.cjs": 767 },
    ceiling: { "index.mjs": 1471906, "index.cjs": 1398748 },
  },
  reason: "The viewer now checks the owner-signed artifactPin: assertArtifactBinding and verifyArtifactShare in share-sdk/src/artifact-pin.ts, the strict artifactPin field in the Policy/v3 envelope schema, and their call sites in resolvePolicyShare and ShareRecipientClient.decryptV3Content. Root only: the worker, first-import, activation and gated artifacts are unchanged. Cuts applied first: the layout helpers and the owner-side helpers (buildArtifactPin, verifyArtifactManifestBytes, verifyArtifactFileBytes) live in the separate @tinycloud/share-sdk/artifact entry and are not in the web bundle; pin errors use their code as the message (-159 gzip bytes in a share-sdk proxy build); the recipient no longer re-hashes the fetched bytes, because the binding already makes the pinned digest equal contentSource.initialCiphertextDigestHex, which decryptV3Content checks (-56). Reused: verifyEnvelopeV3SignatureOnly for the signature, the noble sha256 already bundled, and the existing ciphertext digest check; sdk-core and share-envelope hold no equivalent. Not taken: a lazy import, because the web build pins LimitChunkCountPlugin({ maxChunks: 1 }) and would inline it; a subpath for the verifier, because the viewer must run it; dropping the expected-artifact check or the edit refusal, each worth about 35 bytes. Local builds measured +1127/+993 before these cuts. Review changes then showed two canonical-CI surprises that local builds do not reproduce: a zod .max() on the pinned size moved the ESM root by +911..+924, so the bound lives in assertArtifactBinding instead (+17), and folding the two receive-path signature checks into one saved nothing. Re-measured after #579, #580, #583, #584, #586, #587, #588, #591, #592 and #593 landed: run 39172089071 on source ae2b05bc (a merge of master 28ca77a0) measured identical absolute bytes in both jobs, +911 / +767 over TC-1443's ceilings; the earlier run on 3227e2f2 (master 7539b854) measured 1,469,539 / 1,398,699 against TC-1448's, so the master moves in between (#586 and #587) account for the rest.",
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
  if (root.tc1428Ratchet !== undefined) pins.push({ row: "tc1428Ratchet", pin: root.tc1428Ratchet.sourceCommits.at(-1)! });
  if (hasGatedOnly) pins.push({ row: "gatedOnlyRatchet", pin: approvedGatedOnlyRatchet.sourceCommit });
  return pins;
}

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

/** Only a git merge-base ledger may retain the pre-correction toolchain. */
export function validateLedger(value: Ledger, historicalBase = false): void {
  if (!value || !value.allowance || !Array.isArray(value.entries) ||
      Object.keys(value).some((key) => key !== "allowance" && key !== "entries" && key !== "phase2Ratchet" && key !== "fixRequiredRatchet" && key !== "canonicalToolchainCorrection" && key !== "masterMergeResolution" && key !== "hardeningRatchet" && key !== "logoutRatchet" && key !== "tc1413Ratchet" && key !== "tc1436Ratchet" && key !== "tc1432Ratchet" && key !== "tc1424Ratchet" && key !== "tc1448Ratchet" && key !== "tc1443Ratchet" && key !== "tc1428Ratchet")) {
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
  if (value.tc1428Ratchet !== undefined &&
      (!value.tc1443Ratchet || JSON.stringify(value.tc1428Ratchet) !== JSON.stringify(approvedTc1428Ratchet))) {
    throw new Error("Only Naomi's exact canonical TC-1428 artifact-pin ratchet is approved.");
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

/** The TC-1428 ratchet is introduced once at its exact canonical bytes and immutable afterwards. */
export function validateTc1428RatchetTransition(base?: Tc1428Ratchet, current?: Tc1428Ratchet): void {
  if (current !== undefined && JSON.stringify(current) !== JSON.stringify(approvedTc1428Ratchet) ||
      base !== undefined && JSON.stringify(current) !== JSON.stringify(base)) {
    throw new Error("The exact TC-1428 ratchet may be introduced once and cannot change later.");
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
