import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MAX_REPLICA_WORKER_GZIP_BYTES, MAX_WORKER_GZIP_BYTES } from "../../replica/scripts/check-worker-size";
import { compactFixOptionalAllowance, mergedPinsNotLandedOn, optionalSourcePins, type OptionalLedger } from "./replica-optional-size-policy";
import { approvedTc1428Ratchet, validateTc1428RatchetTransition, type Tc1428Ratchet } from "./replica-size-policy";
import { approvedTc1476Ratchet, validateTc1476RatchetTransition, type Tc1476Ratchet } from "./replica-size-policy";
import { approvedTc1475Ratchet, approvedMasterDriftRatchet, approvedTc1789Ratchet, approvedTc606WorkerRatchet, validateMasterDriftRatchetTransition, validateTc1789RatchetTransition, validateTc606WorkerRatchetTransition, validateTc1475RatchetTransition, type Tc1475Ratchet } from "./replica-size-policy";
import { approvedTc1757Ratchet, validateTc1757RatchetTransition, type Tc1757Ratchet } from "./replica-size-policy";
import { approvedTc1777Ratchet, validateTc1777RatchetTransition, type Tc1777Ratchet } from "./replica-size-policy";
import { approvedTc1777ExpiryRatchet, validateTc1777ExpiryRatchetTransition, type Tc1777ExpiryRatchet } from "./replica-size-policy";
import { approvedTc848PanelRatchet, validateTc848PanelRatchetTransition, type Tc848PanelRatchet } from "./replica-size-policy";
import { approvedTc1781DecryptExpiryRatchet, validateTc1781DecryptExpiryRatchetTransition, type Tc1781DecryptExpiryRatchet } from "./replica-size-policy";
import { approvedTc1801NonTransferableShareRatchet, validateTc1801NonTransferableShareRatchetTransition, type Tc1801NonTransferableShareRatchet } from "./replica-size-policy";
import { approvedTc1807CredentialDiscoveryRatchet, validateTc1807CredentialDiscoveryRatchetTransition, type Tc1807CredentialDiscoveryRatchet } from "./replica-size-policy";
import { approvedTc1827WorkerRatchet, validateTc1827WorkerRatchetTransition, type Tc1827WorkerRatchet } from "./replica-size-policy";
import { approvedTc1827ReplicaWorkerRatchet, validateTc1827ReplicaWorkerRatchetTransition, type Tc1827ReplicaWorkerRatchet } from "./replica-size-policy";
import { approvedTc1823SizeCodeRatchet, validateTc1823SizeCodeRatchetTransition, type Tc1823SizeCodeRatchet } from "./replica-size-policy";
import { approvedTc712CredentialCoreRatchet, validateTc712CredentialCoreRatchetTransition, type Tc712CredentialCoreRatchet } from "./replica-size-policy";
import { approvedTc1781DecryptStandardExpiryRatchet, validateTc1781DecryptStandardExpiryRatchetTransition, type Tc1781DecryptStandardExpiryRatchet } from "./replica-size-policy";
import { approvedTc1855ManifestLimitGuardRatchet, validateTc1855ManifestLimitGuardRatchetTransition, type Tc1855ManifestLimitGuardRatchet } from "./replica-size-policy";
import { approvedTc1488SiweDomainUriRatchet, validateTc1488SiweDomainUriRatchetTransition, type Tc1488SiweDomainUriRatchet } from "./replica-size-policy";
import { approvedTc1737ShortLinkLazyChunkRatchet, validateTc1737ShortLinkLazyChunkRatchetTransition, type Tc1737ShortLinkLazyChunkRatchet } from "./replica-size-policy";
import { approvedTc1910SigningConsistencyRatchet, validateTc1910SigningConsistencyRatchetTransition, type Tc1910SigningConsistencyRatchet } from "./replica-size-policy";
import { approvedTc848SettingsPanelRatchet, validateTc848SettingsPanelRatchetTransition, type Tc848SettingsPanelRatchet } from "./replica-size-policy";
import { approvedTc2034NamedKeysCliRatchet, validateTc2034NamedKeysCliRatchetTransition, type Tc2034NamedKeysCliRatchet } from "./replica-size-policy";
import { approvedTc2043SyncScopeRatchet, validateTc2043SyncScopeRatchetTransition, type Tc2043SyncScopeRatchet, approvedTc1888PurgeLocalCopyRatchet, validateTc1888PurgeLocalCopyRatchetTransition, type Tc1888PurgeLocalCopyRatchet } from "./replica-size-policy";
import { approvedTc1977ManifestKeysRatchet, validateTc1977ManifestKeysRatchetTransition, type Tc1977ManifestKeysRatchet } from "./replica-size-policy";
import { approvedTc2096LazyContentRatchet, validateTc2096LazyContentRatchetTransition } from "./replica-size-policy";
import { approvedTc2113PanelGrantRatchet, validateTc2113PanelGrantRatchetTransition } from "./replica-size-policy";
import { approvedTc2127WindowLocationRatchet, validateTc2127WindowLocationRatchetTransition } from "./replica-size-policy";
import { approvedTc1977OpenKeySigninRatchet, validateTc1977OpenKeySigninRatchetTransition } from "./replica-size-policy";
import { approvedTc2130PanelIphoneRatchet, validateTc2130PanelIphoneRatchetTransition } from "./replica-size-policy";
import { approvedTc1977HostBindingRatchet, validateTc1977HostBindingRatchetTransition } from "./replica-size-policy";
import { approvedTc2132IssuedDelegationsRatchet, validateTc2132IssuedDelegationsRatchetTransition } from "./replica-size-policy";
import { approvedTc2140ExactKeyDelegationRatchet, validateTc2140ExactKeyDelegationRatchetTransition } from "./replica-size-policy";
import { approvedTc2202AgentShareReceiveRatchet, validateTc2202AgentShareReceiveRatchetTransition } from "./replica-size-policy";
import { approvedTc2205HomeFeedRatchet, validateTc2205HomeFeedRatchetTransition, type Tc2205HomeFeedRatchet } from "./replica-size-policy";
import { approvedTc2230SiweRecipientsRatchet, validateTc2230SiweRecipientsRatchetTransition, type Tc2230SiweRecipientsRatchet } from "./replica-size-policy";
import { approvedTc2192ExactKeyRuntimeConsentRatchet, validateTc2192ExactKeyRuntimeConsentRatchetTransition } from "./replica-size-policy";
import { approvedTc2038PanelPrefetchRatchet, validateTc2038PanelPrefetchRatchetTransition, type Tc2038PanelPrefetchRatchet } from "./replica-size-policy";
import { approvedTc2005RevokeWindowRatchet, validateTc2005RevokeWindowRatchetTransition, type Tc2005RevokeWindowRatchet } from "./replica-size-policy";
import { approvedTc2096RepairBackoffRatchet, validateTc2096RepairBackoffRatchetTransition, type Tc2096RepairBackoffRatchet } from "./replica-size-policy";
import { approvedTc2072LocationGuardRatchet, validateTc2072LocationGuardRatchetTransition, type Tc2072LocationGuardRatchet } from "./replica-size-policy";
import { activeRootCeiling, approvedLedgerRows, rootCeilingFor, rootCeilings } from "./replica-size-policy";
import { approvedTc1443Ratchet, approvedTc1443bRatchet, approvedTc1448Ratchet, approvedTc1466Ratchet, validateTc1443RatchetTransition, validateTc1443bRatchetTransition, validateTc1448RatchetTransition, validateTc1466RatchetTransition, type Tc1443Ratchet, type Tc1443bRatchet, type Tc1448Ratchet, type Tc1466Ratchet } from "./replica-size-policy";
import { ancestryPins, assertCiSizeToolchain, approvedCiToolchainCorrection, approvedFixRequiredRatchet, approvedGatedOnlyRatchet, approvedHardeningRatchet, approvedLogoutRatchet, approvedTc1413Ratchet, approvedTc1424Ratchet, approvedTc1432Ratchet, approvedTc1436Ratchet, ciCorrectionPolicyOnlyPaths, hasAncestor, isPolicyOnlySinceApprovedSource, landingCommit, pinLandedOn, validateCiToolchainTransition, validateGatedOnlyRatchet, validateHardeningRatchetTransition, validateLedger, validateLogoutRatchetTransition, validateMasterMergeResolutionTransition, validateTc1413RatchetTransition, validateTc1424RatchetTransition, validateTc1432RatchetTransition, validateTc1436RatchetTransition, type HardeningRatchet, type Ledger, type LogoutRatchet, type MasterMergeResolution, type Tc1413Ratchet, type Tc1424Ratchet, type Tc1432Ratchet, type Tc1436Ratchet } from "./replica-size-policy";

const current = JSON.parse(readFileSync(resolve(import.meta.dir, "replica-size-ledger.json"), "utf8")) as Ledger;

// Newest-row helpers. Order is the ledger file's key order and every ceiling is read from the ledger JSON, so
// appending a row moves these assertions with it. The replica worker's own row is not a kv-storage worker row.
const rootRowsInFileOrder = (ledger: Ledger) => {
  const rootRows = new Set(rootCeilings(ledger).map(({ row }) => row));
  return Object.keys(ledger).filter((key) => rootRows.has(key));
};
const newestRootRow = () => rootRowsInFileOrder(current).at(-1)!;
const ceilingOfRootRow = (row: string) => (current as unknown as Record<string, { root: { ceiling: { "index.mjs": number; "index.cjs": number } } }>)[row]!.root.ceiling;
const newestKvWorkerCeiling = () => {
  const rows = current as unknown as Record<string, { worker?: { ceiling: number } } | undefined>;
  const newest = Object.keys(rows).filter((key) => key !== "tc1827ReplicaWorkerRatchet" && rows[key]?.worker !== undefined).at(-1)!;
  return rows[newest]!.worker!.ceiling;
};
const newestReplicaWorkerCeiling = () => {
  const rows = current as unknown as Record<string, { replicaWorker?: { ceiling: number } } | undefined>;
  const newest = Object.keys(rows).filter((key) => rows[key]?.replicaWorker !== undefined).at(-1)!;
  return rows[newest]!.replicaWorker!.ceiling;
};

// Ceiling fields only: phase2Ratchet's ledger row carries rationale and safeCuts metadata its approved constant does not.
const ceilingsOf = (row: unknown) => {
  const { ceiling, root, worker } = (row ?? {}) as { ceiling?: unknown; root?: { ceiling?: unknown }; worker?: { ceiling?: unknown } };
  return { ceiling, root: root?.ceiling, worker: worker?.ceiling };
};

// Frozen prefix: the 28 root rows that exist today, in ledger file order. Never edit this list. Appended rows get their
// own test blocks. Deleting, renaming, or reordering any of these rows fails the order and newest-row assertions.
const knownRows = [
  "phase2Ratchet",
  "fixRequiredRatchet",
  "canonicalToolchainCorrection",
  "hardeningRatchet",
  "logoutRatchet",
  "tc1413Ratchet",
  "tc1436Ratchet",
  "tc1432Ratchet",
  "tc1424Ratchet",
  "tc1448Ratchet",
  "tc1443Ratchet",
  "tc1466Ratchet",
  "tc1443bRatchet",
  "tc1428Ratchet",
  "tc1476Ratchet",
  "tc1475Ratchet",
  "masterDriftRatchet",
  "tc1789Ratchet",
  "tc1757Ratchet",
  "tc1777Ratchet",
  "tc1777ExpiryRatchet",
  "tc848PanelRatchet",
  "tc1781DecryptExpiryRatchet",
  "tc1801NonTransferableShareRatchet",
  "tc1807CredentialDiscoveryRatchet",
  "tc1827WorkerRatchet",
  "tc1823SizeCodeRatchet",
  "tc712CredentialCoreRatchet",
];

// The historical base keeps only the rows that predate the canonical toolchain correction. Every other ledger row is
// undefined here, so a row appended later drops out of this fixture without edits.
const historicalKeptRows = new Set(["allowance", "entries", "phase2Ratchet", "fixRequiredRatchet"]);
const historical: Ledger = {
  ...current,
  ...Object.fromEntries(Object.keys(current).filter((key) => !historicalKeptRows.has(key)).map((key) => [key, undefined])),
  phase2Ratchet: {
    ...current.phase2Ratchet!,
    toolchain: "Bun 1.4.3; production webpack; gzip -9 -c",
  },
};

const copy = (ledger: Ledger) => structuredClone(ledger);

describe("TC-858 canonical size ratchet transition", () => {
  it("accepts the former Bun 1.4.3 parent only as the historical base and the Bun 1.3.14 ledger as current", () => {
    expect(() => validateLedger(historical, true)).not.toThrow();
    expect(() => validateLedger(historical)).toThrow();
    expect(() => validateLedger(current)).not.toThrow();
  });

  it("keeps every frozen prefix row identical to its approved constant", () => {
    const rows = current as unknown as Record<string, unknown>;
    for (const row of knownRows) expect(ceilingsOf(rows[row])).toEqual(ceilingsOf(approvedLedgerRows[row]));
  });

  it("rejects any other base toolchain and all later toolchain changes", () => {
    const wrongBase = copy(historical);
    wrongBase.phase2Ratchet!.toolchain = "Bun 1.4.4; production webpack; gzip -9 -c";
    expect(() => validateLedger(wrongBase, true)).toThrow();
    const wrongCurrent = copy(current);
    wrongCurrent.phase2Ratchet!.toolchain = "Bun 1.4.3; production webpack; gzip -9 -c";
    expect(() => validateLedger(wrongCurrent)).toThrow();
  });

  it("keeps the exact historical allowance and root baseline, delta, and absolute ceilings on both sides", () => {
    for (const base of [historical, current]) {
      const invalidCeiling = copy(base);
      invalidCeiling.phase2Ratchet!.ceiling["index.mjs"]++;
      expect(() => validateLedger(invalidCeiling, base === historical)).toThrow();
      const invalidBaseline = copy(base);
      invalidBaseline.phase2Ratchet!.baseline["index.cjs"]++;
      expect(() => validateLedger(invalidBaseline, base === historical)).toThrow();
      const invalidAllowance = copy(base);
      invalidAllowance.allowance["index.mjs"]++;
      expect(() => validateLedger(invalidAllowance, base === historical)).toThrow();
    }
  });

  it("rejects any top-level key that is not allowance, entries, or an approved ledger row", () => {
    for (const key of ["bogusRow", "note", "pr", "ticket", "constructor", "__proto__x"]) {
      expect(() => validateLedger({ ...copy(current), [key]: {} } as Ledger)).toThrow("Invalid packages/web-sdk/scripts/replica-size-ledger.json shape");
    }
  });
});

describe("TC-858 deferred refused-admission artifact", () => {
  it("allows only the exact first ratchet, with no base-row change", () => {
    expect(() => validateGatedOnlyRatchet(approvedGatedOnlyRatchet)).not.toThrow();
    expect(() => validateGatedOnlyRatchet(approvedGatedOnlyRatchet, approvedGatedOnlyRatchet)).not.toThrow();
    expect(() => validateGatedOnlyRatchet(undefined, approvedGatedOnlyRatchet)).toThrow();
  });

  it("rejects later cap, trigger, source or toolchain changes", () => {
    const changed = structuredClone(approvedGatedOnlyRatchet);
    changed.ceiling["replica-gated.mjs"]++;
    expect(() => validateGatedOnlyRatchet(changed, approvedGatedOnlyRatchet)).toThrow();
    changed.ceiling["replica-gated.mjs"]--;
    changed.ceiling["replica-gated.cjs"]++;
    expect(() => validateGatedOnlyRatchet(changed)).toThrow();
    changed.ceiling["replica-gated.cjs"]--;
    changed.trigger = "Every opt-in client loads the observer";
    expect(() => validateGatedOnlyRatchet(changed)).toThrow();
    changed.trigger = approvedGatedOnlyRatchet.trigger;
    changed.sourceCommit = "unreviewed source";
    expect(() => validateGatedOnlyRatchet(changed)).toThrow();
    changed.sourceCommit = approvedGatedOnlyRatchet.sourceCommit;
    changed.toolchain = "Bun 1.4.3";
    expect(() => validateGatedOnlyRatchet(changed)).toThrow();
  });
});

describe("TC-858 reviewed fix-required root and first-import ratchet", () => {
  it("accepts the exact measured ddc032ca row without changing the immutable historical entries or original phase2 row", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.fixRequiredRatchet).toEqual(approvedFixRequiredRatchet);
    expect(current.phase2Ratchet?.ceiling).toEqual({ "index.mjs": 1461925, "index.cjs": 1391665 });
    expect(current.entries.find((entry) => entry.pr === "#546")).toMatchObject({ "index.mjs": 238, "index.cjs": 183 });
    expect(current.entries.find((entry) => entry.pr === "#553")).toMatchObject({ "index.mjs": 52, "index.cjs": 55 });
  });

  it("rejects unreviewed root/first growth, source changes and synthetic historical-row edits", () => {
    const rootGrowth = copy(current);
    rootGrowth.fixRequiredRatchet!.rootCeiling["index.mjs"]++;
    expect(() => validateLedger(rootGrowth)).toThrow();
    const firstGrowth = copy(current);
    firstGrowth.fixRequiredRatchet!.firstImportCeiling["replica.cjs"]++;
    expect(() => validateLedger(firstGrowth)).toThrow();
    const changedEvidence = copy(current);
    changedEvidence.fixRequiredRatchet!.groupedMarginals[0].root["index.cjs"]++;
    expect(() => validateLedger(changedEvidence)).toThrow();
    const syntheticAllowance = copy(current);
    syntheticAllowance.allowance["index.mjs"]++;
    expect(() => validateLedger(syntheticAllowance)).toThrow();
  });
});

describe("TC-858 CI Rust toolchain measurement correction", () => {
  const corrected = copy(current) as Ledger & { canonicalToolchainCorrection?: unknown };
  corrected.canonicalToolchainCorrection = {
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

  it("binds zero-headroom correction to GitHub's two identical #548 Node size jobs", () => {
    const correction = current.canonicalToolchainCorrection!;
    expect(correction.ciRun).toBe("38971529166");
    expect(correction.ciJob).toBe("117210798521");
    expect(correction.ciSecondJob).toBe("117210798348");
    expect(correction.ciRunUrl).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/38971529166");
    expect(correction.ciJobUrls).toEqual([
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/38971529166/job/117210798521",
      "https://github.com/TinyCloudLabs/js-sdk/actions/runs/38971529166/job/117210798348",
    ]);
    expect(correction.measured).toEqual({
      master: { "index.mjs": 1462590, "index.cjs": 1393500 },
      delta: { "index.mjs": 1512, "index.cjs": 1369 },
      rootCeiling: { "index.mjs": 1464102, "index.cjs": 1394869 },
      firstImportCeiling: { "replica.mjs": 51785, "replica.cjs": 66995 },
      activationCeiling: { "activation.mjs": 23071, "activation.cjs": 24650 },
    });
    expect(correction.priorNoncanonical).toEqual({
      master: { "index.mjs": 1462685, "index.cjs": 1393687 },
      rootCeiling: { "index.mjs": 1464189, "index.cjs": 1395035 },
      firstImportCeiling: { "replica.mjs": 51786, "replica.cjs": 66995 },
      activationCeiling: { "activation.mjs": 23073, "activation.cjs": 24653 },
    });
  });

  it("rejects changes to GitHub provenance, prior local smoke values, or tight root caps", () => {
    const job = copy(current);
    job.canonicalToolchainCorrection!.ciJobUrls = [
      job.canonicalToolchainCorrection!.ciJobUrls[0],
      "https://example.invalid/other-job",
    ];
    expect(() => validateLedger(job)).toThrow();
    const previous = copy(current);
    previous.canonicalToolchainCorrection!.priorNoncanonical.master["index.cjs"]++;
    expect(() => validateLedger(previous)).toThrow();
    const extraByte = copy(current);
    extraByte.canonicalToolchainCorrection!.measured.rootCeiling["index.cjs"]++;
    expect(() => validateLedger(extraByte)).toThrow();
  });

  it("accepts exactly the measured CI correction while preserving the old Phase 2 and fix-required rows", () => {
    expect(() => validateLedger(corrected)).not.toThrow();
    expect(corrected.phase2Ratchet).toEqual(current.phase2Ratchet);
    expect(corrected.fixRequiredRatchet).toEqual(current.fixRequiredRatchet);
    expect(corrected.entries).toEqual(current.entries);
  });

  it("rejects extra root bytes or a modified historical measurement", () => {
    const growth = copy(corrected);
    growth.canonicalToolchainCorrection!.measured.rootCeiling["index.mjs"]++;
    expect(() => validateLedger(growth)).toThrow();
    const history = copy(corrected);
    history.fixRequiredRatchet!.rootCeiling["index.cjs"]++;
    expect(() => validateLedger(history)).toThrow();
  });

  it("does not attach the CI correction to a historical Bun 1.4.3 Phase 2 base", () => {
    const mixed = copy(corrected);
    mixed.phase2Ratchet!.toolchain = historical.phase2Ratchet!.toolchain;
    expect(() => validateLedger(mixed, true)).toThrow();
  });

  it("accepts the CI Node-size job toolchain and rejects a wrong local Bun or Rust compiler", () => {
    expect(() => assertCiSizeToolchain("1.3.14", "rustc 1.99.0 (b940084d7 2026-09-28)", corrected.canonicalToolchainCorrection!)).not.toThrow();
    expect(() => assertCiSizeToolchain("1.4.3", "rustc 1.99.0 (b940084d7 2026-09-28)", corrected.canonicalToolchainCorrection!)).toThrow(/toolchain/i);
    expect(() => assertCiSizeToolchain("1.3.14", "rustc 1.97.1 (wrong)", corrected.canonicalToolchainCorrection!)).toThrow(/toolchain/i);
    expect(() => assertCiSizeToolchain("1.3.14", "not rustc", corrected.canonicalToolchainCorrection!)).toThrow(/toolchain/i);
  });

  it("permits one exact CI correction transition but refuses changing or removing it later", () => {
    expect(() => validateCiToolchainTransition(undefined, corrected.canonicalToolchainCorrection)).not.toThrow();
    expect(() => validateCiToolchainTransition(corrected.canonicalToolchainCorrection, corrected.canonicalToolchainCorrection)).not.toThrow();
    const extra = structuredClone(corrected.canonicalToolchainCorrection!);
    extra.measured.rootCeiling["index.cjs"]++;
    expect(() => validateCiToolchainTransition(undefined, extra)).toThrow();
    expect(() => validateCiToolchainTransition(corrected.canonicalToolchainCorrection, extra)).toThrow();
    expect(() => validateCiToolchainTransition(corrected.canonicalToolchainCorrection, undefined)).toThrow();
  });
});

describe("TC-858 reviewed master-merge input resolution", () => {
  const reviewed: MasterMergeResolution = {
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
  const withResolution = () => ({ ...copy(current), masterMergeResolution: structuredClone(reviewed) });

  it("accepts only the five exact merged store, manifests, and derived lock blobs", () => {
    expect(() => validateLedger(withResolution())).not.toThrow();
    expect(current.masterMergeResolution).toEqual(reviewed);
    // The reviewed rows stay an unchanged prefix; each later replica PR must append exactly one
    // row of its own (check-phase1-replica-dist.ts), so the whole list is not pinned.
    expect(current.entries.slice(0, 8).map(({ pr }) => pr)).toEqual(["#511", "#529", "#546", "#551", "#563", "#564", "#553", "#565"]);
  });

  it("refuses the superseded #551 resolution bound to e57a6fd6 and e364e7a0", () => {
    const superseded = withResolution();
    Object.assign(superseded.masterMergeResolution, {
      mergedHead: "e364e7a0109cf00cd4af7ebbc79154eb7cc1fe34",
      masterBase: "e57a6fd646e26c56d3a02b2c08b1963179a52c67",
    });
    expect(() => validateLedger(superseded)).toThrow();
    const staleStore = withResolution();
    staleStore.masterMergeResolution.measuredPaths["packages/replica/src/sqlite/store.ts"] =
      "0b695140525dfc09b0c4f2eb903ae8ab143d5331";
    expect(() => validateLedger(staleStore)).toThrow();
  });

  it("rejects each omitted blob independently", () => {
    for (const path of Object.keys(reviewed.measuredPaths)) {
      const omitted = withResolution();
      delete omitted.masterMergeResolution.measuredPaths[path as keyof typeof reviewed.measuredPaths];
      expect(() => validateLedger(omitted)).toThrow();
    }
  });

  it("rejects each altered blob, extra measured path, and fabricated ruling independently", () => {
    for (const path of Object.keys(reviewed.measuredPaths)) {
      const changed = withResolution();
      changed.masterMergeResolution.measuredPaths[path as keyof typeof reviewed.measuredPaths] = "0".repeat(40);
      expect(() => validateLedger(changed)).toThrow();
    }
    const extra = withResolution();
    Object.assign(extra.masterMergeResolution.measuredPaths, {
      "packages/node-sdk/src/TinyCloudNode.ts": "0".repeat(40),
    });
    expect(() => validateLedger(extra)).toThrow();
    const ruling = withResolution();
    ruling.masterMergeResolution.rulings[0] = "unreviewed source";
    expect(() => validateLedger(ruling)).toThrow();
    const attribution = withResolution();
    attribution.masterMergeResolution.attribution["packages/node-sdk/package.json"] = "unreviewed release input";
    expect(() => validateLedger(attribution)).toThrow();
  });

  it("allows one introduction but freezes the row in every later merge base", () => {
    expect(() => validateMasterMergeResolutionTransition(undefined, reviewed)).not.toThrow();
    expect(() => validateMasterMergeResolutionTransition(reviewed, reviewed)).not.toThrow();
    const changed = structuredClone(reviewed);
    changed.measuredPaths["bun.lock"] = "0".repeat(40);
    expect(() => validateMasterMergeResolutionTransition(reviewed, changed)).toThrow();
    expect(() => validateMasterMergeResolutionTransition(reviewed, undefined)).toThrow();
    expect(() => validateMasterMergeResolutionTransition(undefined, changed)).toThrow();
  });
});

describe("TC-858 policy-only source identity", () => {
  const source = "packages/web-sdk/src/removed.ts";
  const allowed = "packages/web-sdk/scripts/replica-optional-size-policy.test.ts";
  const paths = new Set([allowed]);
  const git = (root: string, ...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

  function fixture(): { root: string; base: string } {
    const root = mkdtempSync(join(tmpdir(), "tc858-size-rename-"));
    git(root, "init", "-q");
    git(root, "config", "user.email", "policy@example.test");
    git(root, "config", "user.name", "Policy Test");
    mkdirSync(dirname(join(root, source)), { recursive: true });
    mkdirSync(dirname(join(root, allowed)), { recursive: true });
    writeFileSync(join(root, source), Array.from({ length: 20 }, (_, n) => `export const line${n} = ${n};`).join("\n"));
    git(root, "add", ".");
    git(root, "commit", "-qm", "approved source");
    return { root, base: git(root, "rev-parse", "HEAD") };
  }

  it("allows an ordinary edit to an approved policy-only path", () => {
    const { root, base } = fixture();
    try {
      writeFileSync(join(root, allowed), "export const policy = true;\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "policy test");
      expect(isPolicyOnlySinceApprovedSource(root, base, paths)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a real Git rename from shipped src into the approved policy path", () => {
    const { root, base } = fixture();
    try {
      git(root, "mv", source, allowed);
      git(root, "commit", "-qm", "move shipped source into policy test");
      expect(git(root, "diff", "--name-only", `${base}...HEAD`)).toBe(allowed);
      expect(isPolicyOnlySinceApprovedSource(root, base, paths)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows Changesets Markdown but not executable files under .changeset", () => {
    const { root, base } = fixture();
    try {
      mkdirSync(join(root, ".changeset"), { recursive: true });
      writeFileSync(join(root, ".changeset", "replica-policy.md"), "---\n'@tinycloud/web-sdk': patch\n---\n\nRelease note.\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "release note");
      expect(isPolicyOnlySinceApprovedSource(root, base, paths)).toBe(true);
      writeFileSync(join(root, ".changeset", "source.ts"), "export const shipped = true;\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "executable file");
      expect(isPolicyOnlySinceApprovedSource(root, base, paths)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses renaming shipped source to a Changesets Markdown file", () => {
    const { root, base } = fixture();
    try {
      mkdirSync(join(root, ".changeset"), { recursive: true });
      git(root, "mv", source, ".changeset/removed.md");
      git(root, "commit", "-qm", "rename shipped source");
      expect(isPolicyOnlySinceApprovedSource(root, base, paths)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts the merged ddc032ca-to-a335 policy paths through the official checker allowlist, but not worker source", () => {
    const { root, base } = fixture();
    try {
      const reviewedPaths = [
        ".changeset/replica-grant-policy.md",
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
      ];
      for (const path of reviewedPaths) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), "reviewed policy or release note\n");
      }
      git(root, "add", ".");
      git(root, "commit", "-qm", "merged policy-only history");
      expect(isPolicyOnlySinceApprovedSource(root, base, ciCorrectionPolicyOnlyPaths)).toBe(true);

      const workerSource = "packages/replica/src/kv-storage/worker.ts";
      mkdirSync(dirname(join(root, workerSource)), { recursive: true });
      writeFileSync(join(root, workerSource), "export const changedWorker = true;\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "changed shipped worker source");
      expect(isPolicyOnlySinceApprovedSource(root, base, ciCorrectionPolicyOnlyPaths)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("admits the I0 gate build-order workflow, but no other workflow", () => {
    // tc-191-i0-gate.yml builds for packed CLI/MCP checks; it never feeds the replica-e2e size jobs.
    for (const [workflow, admitted] of [
      [".github/workflows/tc-191-i0-gate.yml", true],
      [".github/workflows/replica-e2e.yml", false],
      [".github/workflows/authority-tests.yml", false],
    ] as const) {
      const { root, base } = fixture();
      try {
        mkdirSync(dirname(join(root, workflow)), { recursive: true });
        writeFileSync(join(root, workflow), "name: changed\n");
        git(root, "add", ".");
        git(root, "commit", "-qm", `change ${workflow}`);
        expect(isPolicyOnlySinceApprovedSource(root, base, ciCorrectionPolicyOnlyPaths)).toBe(admitted);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("refuses a real Git rename of shipped source into an approved worker-policy script", () => {
    const { root, base } = fixture();
    try {
      mkdirSync(join(root, "packages/replica/scripts"), { recursive: true });
      git(root, "mv", source, "packages/replica/scripts/check-worker-size.ts");
      git(root, "commit", "-qm", "rename shipped code into worker-policy script");
      expect(isPolicyOnlySinceApprovedSource(root, base, ciCorrectionPolicyOnlyPaths)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("permits CLI-only auth changes absent from a measured entry graph", async () => {
    const { root, base } = fixture();
    try {
      const cliSource = "packages/cli/src/auth/local-key.ts";
      mkdirSync(dirname(join(root, cliSource)), { recursive: true });
      writeFileSync(join(root, cliSource), "export const persistedReplicaStamp = true;\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "persist CLI sign-in stamp");
      expect(isPolicyOnlySinceApprovedSource(root, base, ciCorrectionPolicyOnlyPaths)).toBe(false);
      const { collectBuildInputs } = await import("./replica-size-inputs");
      const inputs = collectBuildInputs(root, [{ entries: [source], target: "browser" }]);
      expect(inputs.has(cliSource)).toBe(false);
      expect(isPolicyOnlySinceApprovedSource(root, base, ciCorrectionPolicyOnlyPaths, {
        bundleInputs: inputs, sourceMapInputs: new Set(),
      })).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows an unbundled Node test only with a current build graph", async () => {
    const { root } = fixture();
    try {
      const testFixture = "packages/node-sdk/src/replication/replication.e2e.test.ts";
      const entry = "packages/node-sdk/src/index.ts";
      mkdirSync(dirname(join(root, testFixture)), { recursive: true });
      writeFileSync(join(root, entry), "export const node = true;\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "approved measured entry");
      const base = git(root, "rev-parse", "HEAD");
      writeFileSync(join(root, testFixture), "export const guardedFixture = true;\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "guard real-node fixture");
      expect(isPolicyOnlySinceApprovedSource(root, base, ciCorrectionPolicyOnlyPaths)).toBe(false);
      const { collectBuildInputs } = await import("./replica-size-inputs");
      const inputs = collectBuildInputs(root, [{ entries: [entry], target: "bun" }]);
      expect(inputs.has(testFixture)).toBe(false);
      expect(isPolicyOnlySinceApprovedSource(root, base, ciCorrectionPolicyOnlyPaths, {
        bundleInputs: inputs, sourceMapInputs: new Set(),
      })).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a changed test imported by an unchanged measured entry", async () => {
    const { root } = fixture();
    try {
      const testFixture = "packages/node-sdk/src/replication/replication.e2e.test.ts";
      const entry = "packages/node-sdk/src/index.ts";
      mkdirSync(dirname(join(root, testFixture)), { recursive: true });
      writeFileSync(join(root, testFixture), "export const guardedFixture = true;\n");
      writeFileSync(join(root, entry), 'import "./replication/replication.e2e.test";\n');
      git(root, "add", ".");
      git(root, "commit", "-qm", "approved measured entry imports test");
      const base = git(root, "rev-parse", "HEAD");
      writeFileSync(join(root, testFixture), "export const guardedFixture = false;\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "change imported test alone");
      const { collectBuildInputs } = await import("./replica-size-inputs");
      const inputs = collectBuildInputs(root, [{ entries: [entry], target: "bun" }]);
      expect(inputs.has(testFixture)).toBe(true);
      expect(isPolicyOnlySinceApprovedSource(root, base, ciCorrectionPolicyOnlyPaths, {
        bundleInputs: inputs, sourceMapInputs: new Set(),
      })).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a test missing from the throwaway graph but present in emitted source maps", () => {
    const { root, base } = fixture();
    try {
      const testFixture = "packages/node-sdk/src/replication/replication.e2e.test.ts";
      mkdirSync(dirname(join(root, testFixture)), { recursive: true });
      writeFileSync(join(root, testFixture), "export const bundledOnlyInTsup = true;\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "change a test appearing in emitted maps");
      expect(isPolicyOnlySinceApprovedSource(root, base, ciCorrectionPolicyOnlyPaths, {
        bundleInputs: new Set(), sourceMapInputs: new Set([testFixture]),
      })).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the contract Markdown outside the measured entry graph", () => {
    const { root, base } = fixture();
    try {
      const contract = "packages/sdk-services/src/kv/replication/CONTRACT.md";
      mkdirSync(dirname(join(root, contract)), { recursive: true });
      writeFileSync(join(root, contract), "A replica must be stamped before checking node root support.\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "freeze root gate precedence");
      expect(isPolicyOnlySinceApprovedSource(root, base, ciCorrectionPolicyOnlyPaths)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const measured of [
    "packages/web-sdk/src/modules/tcw.ts",
    "packages/node-sdk/src/TinyCloudNode.ts",
    "packages/sdk-services/src/kv/replication/controller.ts",
    "packages/sdk-core/src/index.ts",
    "packages/replica/src/kv-storage/worker.ts",
    "packages/sdk-rs/web-sdk-wasm/src/lib.rs",
    "packages/bootstrap/src/index.ts",
    "packages/share-sdk/src/index.ts",
    "packages/share-envelope/src/index.ts",
    "packages/web-sdk/webpack.config.cjs",
    "packages/replica/tsup.config.ts",
    "packages/node-sdk/package.json",
    "packages/cli/package.json",
    "packages/cli/tsup.config.ts",
    "packages/cli/bunfig.toml",
    "packages/cli/scripts/new-build.ts",
    "bun.lock",
    ".github/workflows/replica-e2e.yml",
  ]) {
    it(`independently refuses changed build input ${measured}`, () => {
      const { root, base } = fixture();
      try {
        const path = join(root, measured);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `measured ${measured}\n`);
        git(root, "add", ".");
        git(root, "commit", "-qm", `change measured ${measured}`);
        expect(isPolicyOnlySinceApprovedSource(root, base, ciCorrectionPolicyOnlyPaths)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("refuses moving measured source into an otherwise ignored CLI path", () => {
    const { root, base } = fixture();
    try {
      const cliSource = "packages/cli/src/auth/local-key.ts";
      mkdirSync(dirname(join(root, cliSource)), { recursive: true });
      git(root, "mv", source, cliSource);
      git(root, "commit", "-qm", "move measured web source into CLI");
      expect(git(root, "diff", "--name-only", `${base}...HEAD`)).toBe(cliSource);
      expect(isPolicyOnlySinceApprovedSource(root, base, ciCorrectionPolicyOnlyPaths)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses moving measured source into a test-shaped path", () => {
    const { root, base } = fixture();
    try {
      const testPath = "packages/web-sdk/src/removed.test.ts";
      git(root, "mv", source, testPath);
      git(root, "commit", "-qm", "move measured source into test");
      expect(git(root, "diff", "--name-only", `${base}...HEAD`)).toBe(testPath);
      expect(isPolicyOnlySinceApprovedSource(root, base, ciCorrectionPolicyOnlyPaths, {
        bundleInputs: new Set(), sourceMapInputs: new Set(),
      })).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("accepts exact master-origin measured source and build metadata, but not a PR edit", () => {
    const { root, base } = fixture();
    const check = isPolicyOnlySinceApprovedSource;
    try {
      git(root, "switch", "-qc", "master-next");
      writeFileSync(join(root, source), "export const reviewedMasterSource = true;\n");
      writeFileSync(join(root, "bun.lock"), "reviewed release lockfile\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "master source and dependency update");
      const masterBase = git(root, "rev-parse", "HEAD");
      git(root, "switch", "-qc", "feature", base);
      writeFileSync(join(root, allowed), "export const policy = true;\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "feature policy");
      git(root, "merge", "--no-ff", "-qm", "normal master merge", "master-next");
      expect(check(root, base, paths, undefined, {}, masterBase)).toBe(true);
      writeFileSync(join(root, source), "export const unreviewedPrSource = true;\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "PR changes master source");
      expect(check(root, base, paths, undefined, {}, masterBase)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a measured-source rename into CLI after a normal master merge", () => {
    const { root, base } = fixture();
    const check = isPolicyOnlySinceApprovedSource;
    try {
      git(root, "switch", "-qc", "master-next");
      writeFileSync(join(root, source), "export const reviewedMasterSource = true;\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "master source update");
      const masterBase = git(root, "rev-parse", "HEAD");
      git(root, "switch", "-qc", "feature", base);
      writeFileSync(join(root, allowed), "export const policy = true;\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "feature policy");
      git(root, "merge", "--no-ff", "-qm", "normal master merge", "master-next");
      const destination = "packages/cli/src/removed.ts";
      mkdirSync(dirname(join(root, destination)), { recursive: true });
      git(root, "mv", source, destination);
      git(root, "commit", "-qm", "PR renames reviewed master source into CLI");
      expect(check(root, base, paths, {
        bundleInputs: new Set(), sourceMapInputs: new Set(),
      }, {}, masterBase)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an unmerged or substituted PR base SHA", () => {
    const { root, base } = fixture();
    const check = isPolicyOnlySinceApprovedSource;
    try {
      git(root, "switch", "-qc", "master-next");
      writeFileSync(join(root, source), "export const reviewedMasterSource = true;\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "master source update");
      const masterBase = git(root, "rev-parse", "HEAD");
      git(root, "switch", "-qc", "feature", base);
      writeFileSync(join(root, allowed), "export const policy = true;\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "feature policy without master");
      expect(check(root, base, paths, undefined, {}, masterBase)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  const resolvedPaths = [
    "packages/replica/src/sqlite/store.ts",
    "packages/web-sdk/package.json",
    "bun.lock",
    "packages/node-sdk/package.json",
    "packages/replica/package.json",
  ];

  function resolvedFixture() {
    const { root, base } = fixture();
    for (const path of resolvedPaths) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), `reviewed merged input: ${path}\n`);
    }
    git(root, "add", ".");
    git(root, "commit", "-qm", "reviewed exact master merge");
    const blobs = Object.fromEntries(resolvedPaths.map((path) => [path, git(root, "rev-parse", `HEAD:${path}`)]));
    return { root, base, blobs };
  }

  it("accepts exactly the approved merged input blobs", () => {
    const { root, base, blobs } = resolvedFixture();
    try {
      expect(isPolicyOnlySinceApprovedSource(root, base, paths, undefined, blobs)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const path of resolvedPaths) {
    it(`refuses a later edit to approved ${path}`, () => {
      const { root, base, blobs } = resolvedFixture();
      try {
        writeFileSync(join(root, path), "unreviewed second edit\n");
        git(root, "add", ".");
        git(root, "commit", "-qm", "second measured edit");
        expect(isPolicyOnlySinceApprovedSource(root, base, paths, undefined, blobs)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("refuses a wrong approved blob even when HEAD is otherwise unchanged", () => {
    for (const path of resolvedPaths) {
      const { root, base, blobs } = resolvedFixture();
      try {
        expect(isPolicyOnlySinceApprovedSource(root, base, paths, undefined, { ...blobs, [path]: "0".repeat(40) }))
          .toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("refuses each changed input omitted from the approved blob set", () => {
    for (const path of resolvedPaths) {
      const { root, base, blobs } = resolvedFixture();
      try {
        const omitted: Record<string, string> = { ...blobs };
        delete omitted[path];
        expect(isPolicyOnlySinceApprovedSource(root, base, paths, {
          bundleInputs: new Set(), sourceMapInputs: new Set(),
        }, omitted)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  for (const unrelated of [
    source,
    "packages/replica/src/sqlite/inspect.ts",
    "packages/web-sdk/webpack.config.js",
    "packages/cli/package.json",
    "package.json",
  ]) {
    it(`refuses unrelated measured input ${unrelated} beside the exact approved blobs`, () => {
      const { root, base, blobs } = resolvedFixture();
      try {
        mkdirSync(dirname(join(root, unrelated)), { recursive: true });
        writeFileSync(join(root, unrelated), "export const unreviewed = true;\n");
        git(root, "add", ".");
        git(root, "commit", "-qm", "unreviewed measured input");
        expect(isPolicyOnlySinceApprovedSource(root, base, paths, {
          bundleInputs: new Set(), sourceMapInputs: new Set(),
        }, blobs)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  // Moving an approved path away or overwriting it is refused by the HEAD-blob preflight.
  for (const path of resolvedPaths) {
    it(`refuses moving approved ${path} away or overwriting it with measured source`, () => {
      for (const [from, to] of [
        [path, "packages/cli/src/renamed-input.ts"],
        [source, path],
      ]) {
        const { root, base, blobs } = resolvedFixture();
        try {
          mkdirSync(dirname(join(root, to)), { recursive: true });
          git(root, "mv", "-f", from, to);
          git(root, "commit", "-qm", "rename across measured boundary");
          expect(isPolicyOnlySinceApprovedSource(root, base, paths, {
            bundleInputs: new Set(), sourceMapInputs: new Set(),
          }, blobs)).toBe(false);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    });
  }

  it("refuses renaming unrelated measured source into CLI while all five approved blobs stay exact", () => {
    // The preflight passes here; only the --no-renames source-side deletion refuses.
    const { root, base, blobs } = resolvedFixture();
    try {
      const destination = "packages/cli/src/renamed-input.ts";
      mkdirSync(dirname(join(root, destination)), { recursive: true });
      git(root, "mv", source, destination);
      git(root, "commit", "-qm", "rename unrelated measured source out of the graph");
      expect(Object.entries(blobs).every(([path, blob]) => git(root, "rev-parse", `HEAD:${path}`) === blob)).toBe(true);
      expect(isPolicyOnlySinceApprovedSource(root, base, paths, {
        bundleInputs: new Set(), sourceMapInputs: new Set(),
      }, blobs)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the separate S4 authority blob mandatory beside the five merge blobs", () => {
    const authority = "packages/node-sdk/src/replication/authority.ts";
    const run = (content: string, approved: (blobs: Record<string, string>, blob: string) => Record<string, string>) => {
      const { root, base, blobs } = resolvedFixture();
      try {
        mkdirSync(dirname(join(root, authority)), { recursive: true });
        writeFileSync(join(root, authority), "export const coveredCompactGrant = true;\n");
        git(root, "add", ".");
        git(root, "commit", "-qm", "approved S4 authority");
        const blob = git(root, "rev-parse", `HEAD:${authority}`);
        if (content !== "export const coveredCompactGrant = true;\n") {
          writeFileSync(join(root, authority), content);
          git(root, "add", ".");
          git(root, "commit", "-qm", "unreviewed authority edit");
        }
        // Same composition as check-phase1-replica-dist.ts: S4 row first, merge row second.
        return isPolicyOnlySinceApprovedSource(root, base, paths, {
          bundleInputs: new Set(), sourceMapInputs: new Set(),
        }, approved(blobs, blob));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };
    const approved = "export const coveredCompactGrant = true;\n";
    expect(run(approved, (blobs, blob) => ({ [authority]: blob, ...blobs }))).toBe(true);
    expect(run(approved, (blobs) => blobs)).toBe(false);
    expect(run("export const coveredCompactGrant = false;\n", (blobs, blob) => ({ [authority]: blob, ...blobs })))
      .toBe(false);
  });
});

describe("TC-858 emitted-map coverage for measured Node and worker entries", () => {
  const node = [{ entry: { index: "src/index.ts", core: "src/core.ts" }, format: ["esm", "cjs"], sourcemap: true }];
  const worker = [{ entry: {
    "replica.worker": "src/worker.ts", "kv-storage.worker": "src/kv-storage/worker.ts",
  }, format: ["esm"], platform: "browser", sourcemap: true }];

  function putMap(root: string, name: string, sources: string[]): void {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 3, sources }));
  }

  function putCompleteNodeMaps(root: string): void {
    for (const format of ["js", "cjs"]) {
      putMap(root, `packages/node-sdk/dist/index.${format}.map`, ["../src/index.ts"]);
      putMap(root, `packages/node-sdk/dist/core.${format}.map`, ["../src/core.ts"]);
    }
  }

  it("refuses an unrelated Node map in place of expected entry maps", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc858-incomplete-maps-"));
    try {
      putMap(root, "packages/node-sdk/dist/unrelated.js.map", ["../src/unrelated.ts"]);
      putMap(root, "packages/replica/dist/replica.worker.js.map", ["../src/worker.ts"]);
      putMap(root, "packages/replica/dist/kv-storage.worker.js.map", ["../src/kv-storage/worker.ts"]);
      const { collectNodeWorkerSourceMaps } = await import("./replica-size-inputs");
      expect(() => collectNodeWorkerSourceMaps(root, node, worker)).toThrow(/source-map coverage incomplete/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a required worker map with no source evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc858-empty-maps-"));
    try {
      putCompleteNodeMaps(root);
      putMap(root, "packages/replica/dist/replica.worker.js.map", ["../src/worker.ts"]);
      putMap(root, "packages/replica/dist/kv-storage.worker.js.map", []);
      const { collectNodeWorkerSourceMaps } = await import("./replica-size-inputs");
      expect(() => collectNodeWorkerSourceMaps(root, node, worker)).toThrow(/source-map coverage incomplete/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses complete non-empty maps for each configured Node and worker output", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc858-complete-maps-"));
    try {
      putCompleteNodeMaps(root);
      putMap(root, "packages/replica/dist/replica.worker.js.map", ["../src/worker.ts"]);
      putMap(root, "packages/replica/dist/kv-storage.worker.js.map", ["../src/kv-storage/worker.ts"]);
      const { collectNodeWorkerSourceMaps } = await import("./replica-size-inputs");
      const inputs = collectNodeWorkerSourceMaps(root, node, worker);
      expect(inputs.has("packages/node-sdk/src/index.ts")).toBe(true);
      expect(inputs.has("packages/node-sdk/src/core.ts")).toBe(true);
      expect(inputs.has("packages/replica/src/worker.ts")).toBe(true);
      expect(inputs.has("packages/replica/src/kv-storage/worker.ts")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("TC-858 exact-blob fix-required measured source exception", () => {
  const git = (root: string, ...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const authority = "packages/node-sdk/src/replication/authority.ts";

  function fixture(): { root: string; base: string; blob: string } {
    const root = mkdtempSync(join(tmpdir(), "tc858-compact-source-"));
    git(root, "init", "-q");
    git(root, "config", "user.email", "policy@example.test");
    git(root, "config", "user.name", "Policy Test");
    mkdirSync(dirname(join(root, authority)), { recursive: true });
    writeFileSync(join(root, authority), "export const ownerOnly = true;\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "approved baseline");
    const base = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, authority), "export const coveredCompactGrant = true;\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "approved compact fix");
    return { root, base, blob: git(root, "rev-parse", `HEAD:${authority}`) };
  }

  it("allows only the approved authority source blob", () => {
    const { root, base, blob } = fixture();
    try {
      expect(isPolicyOnlySinceApprovedSource(root, base, ciCorrectionPolicyOnlyPaths, {
        bundleInputs: new Set([authority]), sourceMapInputs: new Set([authority]),
      }, { [authority]: blob })).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a later authority edit even when its path remains listed", () => {
    const { root, base, blob } = fixture();
    try {
      writeFileSync(join(root, authority), "export const coveredCompactGrant = false;\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "unreviewed measured source edit");
      expect(isPolicyOnlySinceApprovedSource(root, base, ciCorrectionPolicyOnlyPaths, {
        bundleInputs: new Set(), sourceMapInputs: new Set(),
      }, { [authority]: blob })).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses another measured file changed alongside the approved authority blob", () => {
    const { root, base, blob } = fixture();
    try {
      const other = "packages/sdk-services/src/kv/replication/controller.ts";
      mkdirSync(dirname(join(root, other)), { recursive: true });
      writeFileSync(join(root, other), "export const weakened = true;\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "unreviewed controller change");
      expect(isPolicyOnlySinceApprovedSource(root, base, ciCorrectionPolicyOnlyPaths, {
        bundleInputs: new Set(), sourceMapInputs: new Set(),
      }, { [authority]: blob })).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses moving the approved authority source into an otherwise admitted CLI path", () => {
    const { root, base, blob } = fixture();
    try {
      const destination = "packages/cli/src/authority.ts";
      mkdirSync(dirname(join(root, destination)), { recursive: true });
      git(root, "mv", authority, destination);
      git(root, "commit", "-qm", "rename approved authority out of measured graph");
      expect(isPolicyOnlySinceApprovedSource(root, base, ciCorrectionPolicyOnlyPaths, {
        bundleInputs: new Set(), sourceMapInputs: new Set(),
      }, { [authority]: blob })).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("TC-858 #565 hardening exact-delta ratchet", () => {
  const row = () => structuredClone(approvedHardeningRatchet);

  it("is in the ledger exactly once with ceilings equal to the prior caps plus the canonical deltas", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.hardeningRatchet).toEqual(approvedHardeningRatchet);
    const prior = approvedCiToolchainCorrection.measured;
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(approvedHardeningRatchet.root.ceiling[format]).toBe(prior.rootCeiling[format] + approvedHardeningRatchet.root.delta[format]);
    }
    for (const format of ["replica.mjs", "replica.cjs"] as const) {
      expect(approvedHardeningRatchet.firstImport.ceiling[format])
        .toBe(compactFixOptionalAllowance[format] + approvedHardeningRatchet.firstImport.delta[format]);
    }
    for (const format of ["activation.mjs", "activation.cjs"] as const) {
      expect(approvedHardeningRatchet.activation.ceiling[format])
        .toBe(prior.activationCeiling[format] + approvedHardeningRatchet.activation.delta[format]);
    }
    expect(approvedHardeningRatchet.worker.ceiling).toBe(820_101 + approvedHardeningRatchet.worker.delta);
  });

  it("refuses one extra byte in any bucket, other CI provenance, a dropped source commit or a missing #548 base", () => {
    const mutations: Array<(changed: HardeningRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.mjs"]++; },
      (changed) => { changed.worker.ceiling++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits.pop(); },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.hardeningRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutBase = copy(current);
    delete withoutBase.masterMergeResolution;
    expect(() => validateLedger(withoutBase)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateHardeningRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateHardeningRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.firstImport.ceiling["replica.mjs"]++;
    expect(() => validateHardeningRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateHardeningRatchetTransition(row(), changed)).toThrow();
    expect(() => validateHardeningRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("TC-858 #571 sign-out exact-delta ratchet", () => {
  const row = () => structuredClone(approvedLogoutRatchet);

  it("is in the ledger once, with root ceilings equal to #565's plus the canonical deltas and nothing else raised", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.logoutRatchet).toEqual(approvedLogoutRatchet);
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(approvedLogoutRatchet.root.ceiling[format])
        .toBe(approvedHardeningRatchet.root.ceiling[format] + approvedLogoutRatchet.root.delta[format]);
    }
    expect(Object.keys(approvedLogoutRatchet)).not.toContain("firstImport");
    expect(Object.keys(approvedLogoutRatchet)).not.toContain("worker");
  });

  it("refuses one extra byte, other CI provenance, a dropped source commit or a missing #565 ratchet", () => {
    const mutations: Array<(changed: LogoutRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits.pop(); },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.logoutRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutHardening = copy(current);
    delete withoutHardening.hardeningRatchet;
    expect(() => validateLedger(withoutHardening)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateLogoutRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateLogoutRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateLogoutRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateLogoutRatchetTransition(row(), changed)).toThrow();
    expect(() => validateLogoutRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("TC-1413 typed node retry errors exact-delta ratchet", () => {
  const row = () => structuredClone(approvedTc1413Ratchet);

  it("is in the ledger once, each ceiling equal to its prior cap plus the canonical delta", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc1413Ratchet).toEqual(approvedTc1413Ratchet);
    const row1413 = approvedTc1413Ratchet;
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(row1413.root.ceiling[format]).toBe(approvedLogoutRatchet.root.ceiling[format] + row1413.root.delta[format]);
    }
    for (const format of ["replica.mjs", "replica.cjs"] as const) {
      expect(row1413.firstImport.ceiling[format])
        .toBe(approvedHardeningRatchet.firstImport.ceiling[format] + row1413.firstImport.delta[format]);
    }
    for (const format of ["activation.mjs", "activation.cjs"] as const) {
      expect(row1413.activation.ceiling[format])
        .toBe(approvedHardeningRatchet.activation.ceiling[format] + row1413.activation.delta[format]);
    }
    expect(row1413.worker.ceiling).toBe(approvedHardeningRatchet.worker.ceiling + row1413.worker.delta);
  });

  it("refuses one extra byte in any bucket, other CI provenance, a dropped source commit or a missing #571 row", () => {
    const mutations: Array<(changed: Tc1413Ratchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.mjs"]++; },
      (changed) => { changed.worker.ceiling++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits.pop(); },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1413Ratchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutLogout = copy(current);
    delete withoutLogout.logoutRatchet;
    expect(() => validateLedger(withoutLogout)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1413RatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1413RatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.worker.ceiling++;
    expect(() => validateTc1413RatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1413RatchetTransition(row(), changed)).toThrow();
    expect(() => validateTc1413RatchetTransition(row(), undefined)).toThrow();
  });
});

describe("TC-1436 terminal marker exact-delta ratchet", () => {
  const row = () => structuredClone(approvedTc1436Ratchet);

  it("is in the ledger once, its root ceiling equal to TC-1413's plus the canonical delta", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc1436Ratchet).toEqual(approvedTc1436Ratchet);
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(approvedTc1436Ratchet.root.ceiling[format])
        .toBe(approvedTc1413Ratchet.root.ceiling[format] + approvedTc1436Ratchet.root.delta[format]);
    }
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1436Ratchet", pin: approvedTc1436Ratchet.sourceCommits.at(-1)!,
    });
  });

  it("refuses one extra byte, other CI provenance, a dropped source commit or a missing TC-1413 row", () => {
    const mutations: Array<(changed: Tc1436Ratchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits.pop(); },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1436Ratchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutTc1413 = copy(current);
    delete withoutTc1413.tc1413Ratchet;
    expect(() => validateLedger(withoutTc1413)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1436RatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1436RatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc1436RatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1436RatchetTransition(row(), changed)).toThrow();
    expect(() => validateTc1436RatchetTransition(row(), undefined)).toThrow();
  });
});

describe("TC-1432 vault etag/ifMatch/expectAad exact-delta ratchet", () => {
  const row = () => structuredClone(approvedTc1432Ratchet);
  // Buckets where the prior ceiling already sat above the merge-base measurement: that headroom absorbs
  // part of the measured delta, so the new ceiling is the measured value, not prior + delta.
  const headroomAtBase = { "replica.mjs": 1, "replica.cjs": 0, "activation.mjs": 0, "activation.cjs": 0 };

  it("is in the ledger once, each ceiling on top of its prior cap (root: TC-1436's) plus the canonical delta", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc1432Ratchet).toEqual(approvedTc1432Ratchet);
    const row1432 = approvedTc1432Ratchet;
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(row1432.root.ceiling[format]).toBe(approvedTc1436Ratchet.root.ceiling[format] + row1432.root.delta[format]);
    }
    for (const format of ["replica.mjs", "replica.cjs"] as const) {
      expect(row1432.firstImport.ceiling[format])
        .toBe(approvedTc1413Ratchet.firstImport.ceiling[format] + row1432.firstImport.delta[format] - headroomAtBase[format]);
    }
    for (const format of ["activation.mjs", "activation.cjs"] as const) {
      expect(row1432.activation.ceiling[format])
        .toBe(approvedTc1413Ratchet.activation.ceiling[format] + row1432.activation.delta[format] - headroomAtBase[format]);
    }
    expect(row1432.worker.ceiling).toBe(approvedTc1413Ratchet.worker.ceiling + row1432.worker.delta);
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1432Ratchet", pin: row1432.sourceCommits.at(-1)!,
    });
  });

  it("refuses one extra byte in any bucket, other CI provenance, a dropped source commit or a missing TC-1436 row", () => {
    const mutations: Array<(changed: Tc1432Ratchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.mjs"]++; },
      (changed) => { changed.worker.ceiling++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits.pop(); },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1432Ratchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutTc1436 = copy(current);
    delete withoutTc1436.tc1436Ratchet;
    expect(() => validateLedger(withoutTc1436)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1432RatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1432RatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.worker.ceiling++;
    expect(() => validateTc1432RatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1432RatchetTransition(row(), changed)).toThrow();
    expect(() => validateTc1432RatchetTransition(row(), undefined)).toThrow();
  });
});

describe("TC-1424 receiver key exact-delta ratchet", () => {
  const row = () => structuredClone(approvedTc1424Ratchet);

  it("is in the ledger once, its root ceiling equal to TC-1432's plus the canonical delta", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc1424Ratchet).toEqual(approvedTc1424Ratchet);
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(approvedTc1424Ratchet.root.ceiling[format])
        .toBe(approvedTc1432Ratchet.root.ceiling[format] + approvedTc1424Ratchet.root.delta[format]);
    }
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1424Ratchet", pin: approvedTc1424Ratchet.sourceCommits.at(-1)!,
    });
  });

  it("refuses one extra byte, other CI provenance, a dropped source commit or a missing TC-1432 row", () => {
    const mutations: Array<(changed: Tc1424Ratchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits.pop(); },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1424Ratchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutTc1432 = copy(current);
    delete withoutTc1432.tc1432Ratchet;
    expect(() => validateLedger(withoutTc1432)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1424RatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1424RatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc1424RatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1424RatchetTransition(row(), changed)).toThrow();
    expect(() => validateTc1424RatchetTransition(row(), undefined)).toThrow();
  });
});

describe("TC-1448 terminal-grant recipient guard exact-delta ratchet", () => {
  const row = () => structuredClone(approvedTc1448Ratchet);

  it("is in the ledger once, its root ceiling equal to TC-1424's plus the canonical delta", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc1448Ratchet).toEqual(approvedTc1448Ratchet);
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(approvedTc1448Ratchet.root.ceiling[format])
        .toBe(approvedTc1424Ratchet.root.ceiling[format] + approvedTc1448Ratchet.root.delta[format]);
    }
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1448Ratchet", pin: approvedTc1448Ratchet.sourceCommits.at(-1)!,
    });
  });

  it("refuses one extra byte, other CI provenance, a dropped source commit or a missing TC-1424 row", () => {
    const mutations: Array<(changed: Tc1448Ratchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits.pop(); },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1448Ratchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutTc1424 = copy(current);
    delete withoutTc1424.tc1424Ratchet;
    expect(() => validateLedger(withoutTc1424)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1448RatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1448RatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc1448RatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1448RatchetTransition(row(), changed)).toThrow();
    expect(() => validateTc1448RatchetTransition(row(), undefined)).toThrow();
  });
});

describe("TC-1443 registry verdict exact-delta ratchet", () => {
  const row = () => structuredClone(approvedTc1443Ratchet);

  it("is in the ledger once, its root ceiling equal to TC-1448's plus the canonical delta", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc1443Ratchet).toEqual(approvedTc1443Ratchet);
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(approvedTc1443Ratchet.root.ceiling[format])
        .toBe(approvedTc1448Ratchet.root.ceiling[format] + approvedTc1443Ratchet.root.delta[format]);
    }
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1443Ratchet", pin: approvedTc1443Ratchet.sourceCommits.at(-1)!,
    });
  });

  it("stays within Naomi's approved delta of +2,368 / +61 gzip, +/-50 B", () => {
    expect(Math.abs(approvedTc1443Ratchet.root.delta["index.mjs"] - 2368)).toBeLessThanOrEqual(50);
    expect(Math.abs(approvedTc1443Ratchet.root.delta["index.cjs"] - 61)).toBeLessThanOrEqual(50);
  });

  it("refuses one extra byte, other CI provenance, a dropped source commit or a missing TC-1448 row", () => {
    const mutations: Array<(changed: Tc1443Ratchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits.pop(); },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1443Ratchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutTc1448 = copy(current);
    delete withoutTc1448.tc1448Ratchet;
    expect(() => validateLedger(withoutTc1448)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1443RatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1443RatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc1443RatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1443RatchetTransition(row(), changed)).toThrow();
    expect(() => validateTc1443RatchetTransition(row(), undefined)).toThrow();
  });
});

describe("TC-1466 receiver-key clock race exact-delta ratchet", () => {
  const row = () => structuredClone(approvedTc1466Ratchet);

  it("is in the ledger once, its root ceiling equal to TC-1443's plus the canonical delta", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc1466Ratchet).toEqual(approvedTc1466Ratchet);
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(approvedTc1466Ratchet.root.ceiling[format])
        .toBe(approvedTc1443Ratchet.root.ceiling[format] + approvedTc1466Ratchet.root.delta[format]);
    }
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1466Ratchet", pin: approvedTc1466Ratchet.sourceCommits.at(-1)!,
    });
  });

  it("stays within Naomi's approved delta of +12 / +6 gzip, +/-10 B", () => {
    expect(Math.abs(approvedTc1466Ratchet.root.delta["index.mjs"] - 12)).toBeLessThanOrEqual(10);
    expect(Math.abs(approvedTc1466Ratchet.root.delta["index.cjs"] - 6)).toBeLessThanOrEqual(10);
  });

  it("refuses one extra byte, other CI provenance, a dropped source commit or a missing TC-1443 row", () => {
    const mutations: Array<(changed: Tc1466Ratchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits.pop(); },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1466Ratchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutTc1443 = copy(current);
    delete withoutTc1443.tc1443Ratchet;
    expect(() => validateLedger(withoutTc1443)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1466RatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1466RatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc1466RatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1466RatchetTransition(row(), changed)).toThrow();
    expect(() => validateTc1466RatchetTransition(row(), undefined)).toThrow();
  });
});

describe("TC-1443 slice b registry policy exact-delta ratchet", () => {
  const row = () => structuredClone(approvedTc1443bRatchet);

  it("is in the ledger once, its root ceiling equal to TC-1466's plus the measured delta", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc1443bRatchet).toEqual(approvedTc1443bRatchet);
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(approvedTc1443bRatchet.root.ceiling[format])
        .toBe(approvedTc1466Ratchet.root.ceiling[format] + approvedTc1443bRatchet.root.delta[format]);
    }
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1443bRatchet", pin: approvedTc1443bRatchet.sourceCommits.at(-1)!,
    });
  });

  it("stays within Naomi's approved delta of +2,913 / +4,510 gzip, +/-50 B", () => {
    expect(Math.abs(approvedTc1443bRatchet.root.delta["index.mjs"] - 2913)).toBeLessThanOrEqual(50);
    expect(Math.abs(approvedTc1443bRatchet.root.delta["index.cjs"] - 4510)).toBeLessThanOrEqual(50);
  });

  it("refuses one extra byte, other CI provenance, a dropped source commit or a missing TC-1466 row", () => {
    const mutations: Array<(changed: Tc1443bRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits.pop(); },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1443bRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutTc1466 = copy(current);
    delete withoutTc1466.tc1466Ratchet;
    expect(() => validateLedger(withoutTc1466)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1443bRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1443bRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc1443bRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1443bRatchetTransition(row(), changed)).toThrow();
    expect(() => validateTc1443bRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("TC-1428 artifact pin exact-delta ratchet", () => {
  const row = () => structuredClone(approvedTc1428Ratchet);

  it("is in the ledger once, its root ceiling equal to TC-1443b's plus the measured delta", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc1428Ratchet).toEqual(approvedTc1428Ratchet);
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(approvedTc1428Ratchet.root.ceiling[format])
        .toBe(approvedTc1443bRatchet.root.ceiling[format] + approvedTc1428Ratchet.root.delta[format]);
    }
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1428Ratchet", pin: approvedTc1428Ratchet.sourceCommits.at(-1)!,
    });
  });

  it("refuses one extra byte, other CI provenance, a dropped source commit or a missing TC-1443b row", () => {
    const mutations: Array<(changed: Tc1428Ratchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits.pop(); },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1428Ratchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutTc1443b = copy(current);
    delete withoutTc1443b.tc1443bRatchet;
    expect(() => validateLedger(withoutTc1443b)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1428RatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1428RatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc1428RatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1428RatchetTransition(row(), changed)).toThrow();
    expect(() => validateTc1428RatchetTransition(row(), undefined)).toThrow();
  });
});

describe("TC-1476 registry-skip debug event exact-delta ratchet", () => {
  const row = () => structuredClone(approvedTc1476Ratchet);

  it("is in the ledger once, its root ceiling equal to TC-1428's plus the chained delta", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc1476Ratchet).toEqual(approvedTc1476Ratchet);
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(approvedTc1476Ratchet.root.ceiling[format])
        .toBe(approvedTc1428Ratchet.root.ceiling[format] + approvedTc1476Ratchet.root.delta[format]);
    }
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1476Ratchet", pin: approvedTc1476Ratchet.sourceCommits.at(-1)!,
    });
  });

  it("refuses one extra byte, other CI provenance, a dropped source commit or a missing TC-1428 row", () => {
    const mutations: Array<(changed: Tc1476Ratchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits.pop(); },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1476Ratchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutTc1428 = copy(current);
    delete withoutTc1428.tc1428Ratchet;
    expect(() => validateLedger(withoutTc1428)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1476RatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1476RatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc1476RatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1476RatchetTransition(row(), changed)).toThrow();
    expect(() => validateTc1476RatchetTransition(row(), undefined)).toThrow();
  });
});

describe("TC-1475 ServiceContext retry exact-delta ratchet", () => {
  const row = () => structuredClone(approvedTc1475Ratchet);

  it("is in the ledger once; root sits on TC-1476's, every other bucket on TC-1432's, plus the canonical delta", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc1475Ratchet).toEqual(approvedTc1475Ratchet);
    const row1475 = approvedTc1475Ratchet;
    for (const format of ["index.mjs", "index.cjs"] as const) {
      // The row chains after TC-1476's: its ceiling is the measured base, so ours is that plus the delta.
      expect(row1475.root.ceiling[format]).toBe(approvedTc1476Ratchet.root.ceiling[format] + row1475.root.delta[format]);
    }
    for (const format of ["replica.mjs", "replica.cjs"] as const) {
      expect(row1475.firstImport.ceiling[format])
        .toBe(approvedTc1432Ratchet.firstImport.ceiling[format] + row1475.firstImport.delta[format]);
    }
    for (const format of ["activation.mjs", "activation.cjs"] as const) {
      expect(row1475.activation.ceiling[format])
        .toBe(approvedTc1432Ratchet.activation.ceiling[format] + row1475.activation.delta[format]);
    }
    expect(row1475.worker.ceiling).toBe(approvedTc1432Ratchet.worker.ceiling + row1475.worker.delta);
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1475Ratchet", pin: row1475.sourceCommits.at(-1)!,
    });
  });

  it("refuses one extra byte in any bucket, other CI provenance, a dropped source commit or a missing TC-1428 row", () => {
    const mutations: Array<(changed: Tc1475Ratchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.mjs"]++; },
      (changed) => { changed.worker.ceiling++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits.pop(); },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1475Ratchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutTc1428 = copy(current);
    delete withoutTc1428.tc1428Ratchet;
    expect(() => validateLedger(withoutTc1428)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1475RatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1475RatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.worker.ceiling++;
    expect(() => validateTc1475RatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1475RatchetTransition(row(), changed)).toThrow();
    expect(() => validateTc1475RatchetTransition(row(), undefined)).toThrow();
  });
});

describe("#606 worker exact-delta ratchet", () => {
  const row = () => structuredClone(approvedTc606WorkerRatchet);

  it("sits 86 B above TC-1475's worker ceiling", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc606WorkerRatchet).toEqual(approvedTc606WorkerRatchet);
    expect(row().worker.ceiling).toBe(approvedTc1475Ratchet.worker.ceiling + row().worker.delta);
  });

  it("refuses an extra byte, other provenance, or a missing TC-1475 row", () => {
    const mutations: Array<(changed: ReturnType<typeof row>) => void> = [
      (changed) => { changed.worker.ceiling++; },
      (changed) => { changed.worker.delta++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc606WorkerRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const without1475 = copy(current);
    delete without1475.tc1475Ratchet;
    expect(() => validateLedger(without1475)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc606WorkerRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc606WorkerRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.worker.ceiling++;
    expect(() => validateTc606WorkerRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc606WorkerRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("master drift since 75eb5304 exact-delta ratchet", () => {
  const row = () => structuredClone(approvedMasterDriftRatchet);

  it("sits root +405/+329 and activation.cjs +1 on TC-1475's ceilings, with the worker already admitted", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.masterDriftRatchet).toEqual(approvedMasterDriftRatchet);
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(row().root.ceiling[format]).toBe(approvedTc1475Ratchet.root.ceiling[format] + row().root.delta[format]);
    }
    expect(row().activation.ceiling["activation.cjs"]).toBe(approvedTc1475Ratchet.activation.ceiling["activation.cjs"] + 1);
    expect(row().firstImport.ceiling).toEqual(approvedTc1475Ratchet.firstImport.ceiling);
    expect(row().activation.ceiling["activation.mjs"]).toBe(approvedTc1475Ratchet.activation.ceiling["activation.mjs"]);
    expect(row().worker.ceiling).toBe(approvedTc606WorkerRatchet.worker.ceiling);
    expect(ancestryPins(current, false)).toContainEqual({
      row: "masterDriftRatchet", pin: row().sourceCommits.at(-1)!,
    });
  });

  it("refuses one extra byte in any bucket, other CI provenance, or a missing #606 worker row", () => {
    const mutations: Array<(changed: ReturnType<typeof row>) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.cjs"]++; },
      (changed) => { changed.worker.ceiling++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.masterDriftRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutWorkerRow = copy(current);
    delete withoutWorkerRow.tc606WorkerRatchet;
    expect(() => validateLedger(withoutWorkerRow)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateMasterDriftRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateMasterDriftRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateMasterDriftRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateMasterDriftRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("sdk-services 3.3.1 pin exact-delta ratchet", () => {
  const row = () => structuredClone(approvedTc1789Ratchet);

  it("raises only the replica.cjs first-import ceiling by 1 B on the master-drift ceilings", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc1789Ratchet).toEqual(approvedTc1789Ratchet);
    expect(row().root.ceiling).toEqual(approvedMasterDriftRatchet.root.ceiling);
    expect(row().root.delta).toEqual({ "index.mjs": 0, "index.cjs": 0 });
    expect(row().worker).toEqual(approvedMasterDriftRatchet.worker);
    expect(row().activation.ceiling).toEqual(approvedMasterDriftRatchet.activation.ceiling);
    expect(row().firstImport.ceiling["replica.mjs"]).toBe(approvedMasterDriftRatchet.firstImport.ceiling["replica.mjs"]);
    expect(row().firstImport.ceiling["replica.cjs"]).toBe(approvedMasterDriftRatchet.firstImport.ceiling["replica.cjs"] + 1);
    expect(row().firstImport.delta).toEqual({ "replica.mjs": 0, "replica.cjs": 1 });
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1789Ratchet", pin: row().sourceCommits.at(-1)!,
    });
  });

  it("refuses one extra byte in any bucket, other CI provenance, or a missing master-drift row", () => {
    const mutations: Array<(changed: ReturnType<typeof row>) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.firstImport.delta["replica.mjs"]++; },
      (changed) => { changed.activation.ceiling["activation.cjs"]++; },
      (changed) => { changed.worker.ceiling++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1789Ratchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutMasterDrift = copy(current);
    delete withoutMasterDrift.masterDriftRatchet;
    expect(() => validateLedger(withoutMasterDrift)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1789RatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1789RatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.firstImport.ceiling["replica.cjs"]++;
    expect(() => validateTc1789RatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1789RatchetTransition(row(), undefined)).toThrow();
  });
});

describe("web-recipient entry (#678) lowered root ceiling ratchet", () => {
  const row = () => structuredClone(approvedTc1757Ratchet);

  it("lowers only the root ceilings, to the exact canonical CI bytes, and nothing else", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(JSON.stringify(current.tc1757Ratchet)).toBe(JSON.stringify(approvedTc1757Ratchet));
    expect(row().root.ceiling).toEqual({ "index.mjs": 1458843, "index.cjs": 1401918 });
    expect(row().root.ceiling["index.mjs"]).toBeLessThan(approvedTc1789Ratchet.root.ceiling["index.mjs"]);
    expect(row().root.ceiling["index.cjs"]).toBeLessThan(approvedTc1789Ratchet.root.ceiling["index.cjs"]);
    expect(row().root.delta).toEqual({ "index.mjs": -16712, "index.cjs": -1996 });
    expect(row().firstImport.ceiling).toEqual(approvedTc1789Ratchet.firstImport.ceiling);
    expect(row().firstImport.delta).toEqual({ "replica.mjs": 0, "replica.cjs": 0 });
    expect(row().activation).toEqual(approvedTc1789Ratchet.activation);
    expect(row().worker).toEqual(approvedTc1789Ratchet.worker);
    expect(row().ruling).toBe("Approved by Naomi (2026-10-22, policy review relayed by Amos)");
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/39817449009");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1757Ratchet", pin: row().sourceCommits.at(-1)!,
    });
  });

  it("refuses one extra byte in any bucket, other CI provenance, or a missing sdk-services pin row", () => {
    const mutations: Array<(changed: Tc1757Ratchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]--; },
      (changed) => { changed.root.delta["index.mjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.cjs"]++; },
      (changed) => { changed.worker.ceiling--; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1757Ratchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPin = copy(current);
    delete withoutPin.tc1789Ratchet;
    expect(() => validateLedger(withoutPin)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1757RatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1757RatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.mjs"]++;
    expect(() => validateTc1757RatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1757RatchetTransition(row(), undefined)).toThrow();
  });
});

describe("replication wiring boundary (#686) raised root ceiling ratchet", () => {
  const row = () => structuredClone(approvedTc1777Ratchet);

  it("raises only the root ceilings, by the exact canonical CI delta over the previous row, and nothing else", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(JSON.stringify(current.tc1777Ratchet)).toBe(JSON.stringify(approvedTc1777Ratchet));
    expect(row().root.delta).toEqual({ "index.mjs": 15, "index.cjs": 29 });
    expect(row().root.ceiling).toEqual({ "index.mjs": 1458858, "index.cjs": 1401947 });
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(row().root.ceiling[format]).toBe(approvedTc1757Ratchet.root.ceiling[format] + row().root.delta[format]);
    }
    expect(row().firstImport).toEqual(approvedTc1757Ratchet.firstImport);
    expect(row().activation).toEqual(approvedTc1757Ratchet.activation);
    expect(row().worker).toEqual(approvedTc1757Ratchet.worker);
    expect(row().ruling).toBe("Approved by Naomi (2026-10-22, policy review relayed by Amos)");
    expect(row().base).toBe("bc49820c1417a449041e9801b60c86a63485b55d");
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/39855300327");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1777Ratchet", pin: row().sourceCommits.at(-1)!,
    });
  });

  it("refuses one extra byte in any bucket, other CI provenance, or a missing web-recipient row", () => {
    const mutations: Array<(changed: Tc1777Ratchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]--; },
      (changed) => { changed.root.delta["index.mjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.cjs"]++; },
      (changed) => { changed.worker.ceiling--; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1777Ratchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc1757Ratchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1777RatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1777RatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.mjs"]++;
    expect(() => validateTc1777RatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1777RatchetTransition(row(), undefined)).toThrow();
  });
});

describe("expiryMs / hasPermissions (#668) raised root ceiling ratchet", () => {
  const row = () => structuredClone(approvedTc1777ExpiryRatchet);

  it("raises only the root ceilings, by the exact canonical CI delta over the previous row, and nothing else", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(JSON.stringify(current.tc1777ExpiryRatchet)).toBe(JSON.stringify(approvedTc1777ExpiryRatchet));
    expect(row().root.delta).toEqual({ "index.mjs": 172, "index.cjs": 174 });
    expect(row().root.ceiling).toEqual({ "index.mjs": 1459030, "index.cjs": 1402121 });
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(row().root.ceiling[format]).toBe(approvedTc1777Ratchet.root.ceiling[format] + row().root.delta[format]);
    }
    expect(row().firstImport).toEqual(approvedTc1777Ratchet.firstImport);
    expect(row().activation).toEqual(approvedTc1777Ratchet.activation);
    expect(row().worker).toEqual(approvedTc1777Ratchet.worker);
    expect(row().ruling).toBe("Approved by Naomi (2026-10-22, policy review relayed by Amos)");
    expect(row().base).toBe("80d387441dbe87e2309a849c653e2d0adecd400b");
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/39861366041");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1777ExpiryRatchet", pin: row().sourceCommits.at(-1)!,
    });
  });

  it("refuses one extra byte in any bucket, other CI provenance, or a missing replication-wiring row", () => {
    const mutations: Array<(changed: Tc1777ExpiryRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]--; },
      (changed) => { changed.root.delta["index.mjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.cjs"]++; },
      (changed) => { changed.worker.ceiling--; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1777ExpiryRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc1777Ratchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1777ExpiryRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1777ExpiryRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.mjs"]++;
    expect(() => validateTc1777ExpiryRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1777ExpiryRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("developer request log panel (#656) raised root ceiling ratchet", () => {
  const row = () => structuredClone(approvedTc848PanelRatchet);

  it("raises only the root ceilings, by the exact canonical CI delta over the previous row, and nothing else", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(JSON.stringify(current.tc848PanelRatchet)).toBe(JSON.stringify(approvedTc848PanelRatchet));
    expect(row().root.delta).toEqual({ "index.mjs": 3016, "index.cjs": 2224 });
    expect(row().root.ceiling).toEqual({ "index.mjs": 1462046, "index.cjs": 1404345 });
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(row().root.ceiling[format]).toBe(approvedTc1777ExpiryRatchet.root.ceiling[format] + row().root.delta[format]);
    }
    expect(row().firstImport).toEqual(approvedTc1777ExpiryRatchet.firstImport);
    expect(row().activation).toEqual(approvedTc1777ExpiryRatchet.activation);
    expect(row().worker).toEqual(approvedTc1777ExpiryRatchet.worker);
    expect(row().ruling).toBe("Approved by Naomi (2026-10-22, policy review relayed by Amos)");
    expect(row().base).toBe("bf510d9f226c84bd6fd8d9d018c82e84b1fd2cc8");
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/39869142170");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc848PanelRatchet", pin: row().sourceCommits.at(-1)!,
    });
  });

  it("refuses one extra byte in any bucket, other CI provenance, or a missing expiryMs / hasPermissions row", () => {
    const mutations: Array<(changed: Tc848PanelRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]--; },
      (changed) => { changed.root.delta["index.mjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.cjs"]++; },
      (changed) => { changed.worker.ceiling--; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc848PanelRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc1777ExpiryRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc848PanelRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc848PanelRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.mjs"]++;
    expect(() => validateTc848PanelRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc848PanelRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("one-hour decrypt default and secret-read coverage (#681) raised root ceiling ratchet", () => {
  const row = () => structuredClone(approvedTc1781DecryptExpiryRatchet);

  it("raises only the root ceilings, by the exact canonical CI delta over the previous row, and nothing else", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(JSON.stringify(current.tc1781DecryptExpiryRatchet)).toBe(JSON.stringify(approvedTc1781DecryptExpiryRatchet));
    expect(row().root.delta).toEqual({ "index.mjs": 303, "index.cjs": 217 });
    expect(row().root.ceiling).toEqual({ "index.mjs": 1462349, "index.cjs": 1404562 });
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(row().root.ceiling[format]).toBe(approvedTc848PanelRatchet.root.ceiling[format] + row().root.delta[format]);
    }
    expect(row().firstImport).toEqual(approvedTc848PanelRatchet.firstImport);
    expect(row().activation).toEqual(approvedTc848PanelRatchet.activation);
    expect(row().worker).toEqual(approvedTc848PanelRatchet.worker);
    expect(row().ruling).toBe("Approved by Naomi (2026-10-23, policy review relayed by Amos)");
    expect(row().base).toBe("e88e40e003cd2570e80b1a3cd53d0a5531838e42");
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/39890426909");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1781DecryptExpiryRatchet", pin: row().sourceCommits.at(-1)!,
    });
  });

  it("refuses one extra byte in any bucket, other CI provenance, or a missing developer request log panel row", () => {
    const mutations: Array<(changed: Tc1781DecryptExpiryRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]--; },
      (changed) => { changed.root.delta["index.mjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.cjs"]++; },
      (changed) => { changed.worker.ceiling--; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1781DecryptExpiryRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc848PanelRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1781DecryptExpiryRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1781DecryptExpiryRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.mjs"]++;
    expect(() => validateTc1781DecryptExpiryRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1781DecryptExpiryRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("non-transferable share option (#687) raised root ceiling ratchet", () => {
  const row = () => structuredClone(approvedTc1801NonTransferableShareRatchet);

  it("raises only the root ceilings, by the exact canonical CI delta over the previous row, and nothing else", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(JSON.stringify(current.tc1801NonTransferableShareRatchet)).toBe(JSON.stringify(approvedTc1801NonTransferableShareRatchet));
    expect(row().root.delta).toEqual({ "index.mjs": 26, "index.cjs": 35 });
    expect(row().root.ceiling).toEqual({ "index.mjs": 1462375, "index.cjs": 1404597 });
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(row().root.ceiling[format]).toBe(approvedTc1781DecryptExpiryRatchet.root.ceiling[format] + row().root.delta[format]);
    }
    expect(row().firstImport).toEqual(approvedTc1781DecryptExpiryRatchet.firstImport);
    expect(row().activation).toEqual(approvedTc1781DecryptExpiryRatchet.activation);
    expect(row().worker).toEqual(approvedTc1781DecryptExpiryRatchet.worker);
    expect(row().ruling).toBe("Approved by Naomi (2026-10-23, policy review relayed by Amos)");
    expect(row().base).toBe("51ee7f0e9aa7a382d5150a7f1c20e9b64b36409b");
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/39896378690");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1801NonTransferableShareRatchet", pin: row().sourceCommits.at(-1)!,
    });
  });

  it("refuses one extra byte in any bucket, other CI provenance, or a missing one-hour decrypt default row", () => {
    const mutations: Array<(changed: Tc1801NonTransferableShareRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]--; },
      (changed) => { changed.root.delta["index.mjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.cjs"]++; },
      (changed) => { changed.worker.ceiling--; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1801NonTransferableShareRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc1781DecryptExpiryRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1801NonTransferableShareRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1801NonTransferableShareRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.mjs"]++;
    expect(() => validateTc1801NonTransferableShareRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1801NonTransferableShareRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("credential discovery default and typed error (#690) raised root ceiling ratchet", () => {
  const row = () => structuredClone(approvedTc1807CredentialDiscoveryRatchet);

  it("raises only the root ceilings, by the exact canonical CI delta over the previous row, and nothing else", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(JSON.stringify(current.tc1807CredentialDiscoveryRatchet)).toBe(JSON.stringify(approvedTc1807CredentialDiscoveryRatchet));
    expect(row().root.delta).toEqual({ "index.mjs": 81, "index.cjs": 88 });
    expect(row().root.ceiling).toEqual({ "index.mjs": 1462456, "index.cjs": 1404685 });
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(row().root.ceiling[format]).toBe(approvedTc1801NonTransferableShareRatchet.root.ceiling[format] + row().root.delta[format]);
    }
    expect(row().firstImport).toEqual(approvedTc1801NonTransferableShareRatchet.firstImport);
    expect(row().activation).toEqual(approvedTc1801NonTransferableShareRatchet.activation);
    expect(row().worker).toEqual(approvedTc1801NonTransferableShareRatchet.worker);
    expect(row().ruling).toBe("Approved by Naomi (2026-10-23, policy review relayed by Amos)");
    expect(row().base).toBe("437ca1593cb9b41029409d154b724a64753625bc");
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/39904276924");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1807CredentialDiscoveryRatchet", pin: row().sourceCommits.at(-1)!,
    });
  });

  it("refuses one extra byte in any bucket, other CI provenance, or a missing non-transferable share option row", () => {
    const mutations: Array<(changed: Tc1807CredentialDiscoveryRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]--; },
      (changed) => { changed.root.delta["index.mjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.cjs"]++; },
      (changed) => { changed.worker.ceiling--; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1807CredentialDiscoveryRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc1801NonTransferableShareRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1807CredentialDiscoveryRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1807CredentialDiscoveryRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.mjs"]++;
    expect(() => validateTc1807CredentialDiscoveryRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1807CredentialDiscoveryRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("replica worker narrow imports (#694) lowered worker ceiling ratchet", () => {
  const row = () => structuredClone(approvedTc1827WorkerRatchet);

  it("lowers only the worker ceiling, to the exact canonical CI bytes, and is the checker's ceiling", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(JSON.stringify(current.tc1827WorkerRatchet)).toBe(JSON.stringify(approvedTc1827WorkerRatchet));
    expect(row().worker).toEqual({ delta: -46625, ceiling: 776128 });
    expect(row().worker.ceiling).toBe(approvedTc1807CredentialDiscoveryRatchet.worker.ceiling + row().worker.delta);
    expect(MAX_WORKER_GZIP_BYTES).toBe(newestKvWorkerCeiling());
    expect(row().root).toEqual({ delta: { "index.mjs": 0, "index.cjs": 0 }, ceiling: approvedTc1807CredentialDiscoveryRatchet.root.ceiling });
    expect(row().firstImport.ceiling).toEqual(approvedTc1807CredentialDiscoveryRatchet.firstImport.ceiling);
    expect(row().firstImport.delta).toEqual({ "replica.mjs": 0, "replica.cjs": -1 });
    expect(row().activation.ceiling).toEqual(approvedTc1807CredentialDiscoveryRatchet.activation.ceiling);
    expect(row().activation.delta).toEqual({ "activation.mjs": -1, "activation.cjs": -2 });
    expect(row().ruling).toBe("Approved by Naomi (2026-10-23, policy review relayed by Amos)");
    expect(row().base).toBe("6076581dcf13a6a0395b0f8798c6b6bf22928088");
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/39943720009");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1827WorkerRatchet", pin: row().sourceCommits.at(-1)!,
    });
  });

  it("refuses one extra byte in any bucket, other CI provenance, or a missing credential discovery row", () => {
    const mutations: Array<(changed: Tc1827WorkerRatchet) => void> = [
      (changed) => { changed.worker.ceiling++; },
      (changed) => { changed.worker.ceiling--; },
      (changed) => { changed.worker.delta++; },
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.cjs"]++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1827WorkerRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc1807CredentialDiscoveryRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1827WorkerRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1827WorkerRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.worker.ceiling++;
    expect(() => validateTc1827WorkerRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1827WorkerRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("replica worker (TC-1827 follow-up) first ceiling ratchet", () => {
  const row = () => structuredClone(approvedTc1827ReplicaWorkerRatchet);

  it("is the exact canonical CI bytes, is the checker's replica worker ceiling, and leaves the kv-storage worker alone", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(JSON.stringify(current.tc1827ReplicaWorkerRatchet)).toBe(JSON.stringify(approvedTc1827ReplicaWorkerRatchet));
    expect(row().worker).toEqual({ delta: 0, ceiling: 770093 });
    expect(MAX_REPLICA_WORKER_GZIP_BYTES).toBe(newestReplicaWorkerCeiling());
    expect(MAX_WORKER_GZIP_BYTES).toBe(newestKvWorkerCeiling());
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/39949887460");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(rootCeilings(current).map(({ row }) => row)).not.toContain("tc1827ReplicaWorkerRatchet");
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1827ReplicaWorkerRatchet", pin: row().sourceCommits.at(-1)!,
    });
  });

  it("refuses one extra or missing byte, other CI provenance, or a missing kv-storage worker row", () => {
    const mutations: Array<(changed: Tc1827ReplicaWorkerRatchet) => void> = [
      (changed) => { changed.worker.ceiling++; },
      (changed) => { changed.worker.ceiling--; },
      (changed) => { changed.worker.delta++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1827ReplicaWorkerRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc1827WorkerRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow();
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1827ReplicaWorkerRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1827ReplicaWorkerRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.worker.ceiling++;
    expect(() => validateTc1827ReplicaWorkerRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1827ReplicaWorkerRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("SQL and DuckDB request-size error codes (#693) raised root ceiling ratchet", () => {
  const row = () => structuredClone(approvedTc1823SizeCodeRatchet);

  it("raises only the root ceilings, by the exact canonical CI delta over the previous row, and nothing else", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(JSON.stringify(current.tc1823SizeCodeRatchet)).toBe(JSON.stringify(approvedTc1823SizeCodeRatchet));
    expect(row().root.delta).toEqual({ "index.mjs": 100, "index.cjs": 108 });
    expect(row().root.ceiling).toEqual({ "index.mjs": 1462556, "index.cjs": 1404793 });
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(row().root.ceiling[format]).toBe(approvedTc1827WorkerRatchet.root.ceiling[format] + row().root.delta[format]);
    }
    expect(row().firstImport.ceiling).toEqual(approvedTc1827WorkerRatchet.firstImport.ceiling);
    expect(row().activation.ceiling).toEqual(approvedTc1827WorkerRatchet.activation.ceiling);
    expect(row().worker).toEqual({ delta: 0, ceiling: approvedTc1827WorkerRatchet.worker.ceiling });
    expect(row().ruling).toBe("Approved by Naomi (2026-10-23, policy review relayed by Amos)");
    expect(row().base).toBe("d3da865460ad4b0b51bad753bddd8f89518db238");
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/39978157827");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1823SizeCodeRatchet", pin: row().sourceCommits.at(-1)!,
    });
  });

  it("refuses one extra byte in any bucket, other CI provenance, or a missing replica worker narrow-imports row", () => {
    const mutations: Array<(changed: Tc1823SizeCodeRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]--; },
      (changed) => { changed.root.delta["index.mjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.cjs"]++; },
      (changed) => { changed.worker.ceiling--; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1823SizeCodeRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc1827WorkerRatchet;
    delete withoutPrerequisite.tc1827ReplicaWorkerRatchet; // requires the row above
    expect(() => validateLedger(withoutPrerequisite)).toThrow("request-size error code");
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1823SizeCodeRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1823SizeCodeRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.mjs"]++;
    expect(() => validateTc1823SizeCodeRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1823SizeCodeRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("credential consumer core (#679, TC-712) raised root ceiling ratchet", () => {
  const row = () => structuredClone(approvedTc712CredentialCoreRatchet);

  it("raises only the root ceilings, by the exact canonical CI delta over the previous row, and nothing else", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(JSON.stringify(current.tc712CredentialCoreRatchet)).toBe(JSON.stringify(approvedTc712CredentialCoreRatchet));
    expect(row().root.delta).toEqual({ "index.mjs": 76, "index.cjs": 71 });
    expect(row().root.ceiling).toEqual({ "index.mjs": 1462632, "index.cjs": 1404864 });
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(row().root.ceiling[format]).toBe(approvedTc1823SizeCodeRatchet.root.ceiling[format] + row().root.delta[format]);
    }
    expect(row().firstImport.ceiling).toEqual(approvedTc1823SizeCodeRatchet.firstImport.ceiling);
    expect(row().activation.ceiling).toEqual(approvedTc1823SizeCodeRatchet.activation.ceiling);
    expect(row().worker).toEqual({ delta: 0, ceiling: approvedTc1823SizeCodeRatchet.worker.ceiling });
    expect(row().ruling).toBe("Approved by Naomi (2026-10-23, policy review relayed by Amos)");
    expect(row().base).toBe("43c5bea9cd6e9409e2e8094de30d302de9aa94a5");
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/40002503111");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc712CredentialCoreRatchet", pin: row().sourceCommits.at(-1)!,
    });
  });

  it("refuses one extra byte in any bucket, other CI provenance, or a missing request-size error code row", () => {
    const mutations: Array<(changed: Tc712CredentialCoreRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]--; },
      (changed) => { changed.root.delta["index.mjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.cjs"]++; },
      (changed) => { changed.worker.ceiling--; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc712CredentialCoreRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc1823SizeCodeRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("credential consumer core");
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc712CredentialCoreRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc712CredentialCoreRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.mjs"]++;
    expect(() => validateTc712CredentialCoreRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc712CredentialCoreRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("decrypt grants on the standard expiry (#707, TC-1781) lowered root ceiling ratchet", () => {
  const row = () => structuredClone(approvedTc1781DecryptStandardExpiryRatchet);

  it("lowers only the root ceilings, by the exact canonical CI delta under the credential consumer core row, and nothing else", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(JSON.stringify(current.tc1781DecryptStandardExpiryRatchet)).toBe(JSON.stringify(approvedTc1781DecryptStandardExpiryRatchet));
    expect(row().root.delta).toEqual({ "index.mjs": -313, "index.cjs": -229 });
    expect(row().root.ceiling).toEqual({ "index.mjs": 1462319, "index.cjs": 1404635 });
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(row().root.ceiling[format]).toBe(approvedTc712CredentialCoreRatchet.root.ceiling[format] + row().root.delta[format]);
    }
    expect(row().firstImport).toEqual({ ...approvedTc712CredentialCoreRatchet.firstImport, delta: { "replica.mjs": 0, "replica.cjs": 0 } });
    expect(row().activation).toEqual({ ...approvedTc712CredentialCoreRatchet.activation, delta: { "activation.mjs": 0, "activation.cjs": 0 } });
    expect(row().worker).toEqual({ delta: 0, ceiling: approvedTc712CredentialCoreRatchet.worker.ceiling });
    expect(row().ruling).toBe("Approved by Naomi (2026-10-23, policy review relayed by Amos)");
    expect(row().sourceCommits).toEqual(["218d4a83fc7771818d1f7d1f674b81e7163d6d07"]);
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/40030915569");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1781DecryptStandardExpiryRatchet", pin: row().sourceCommits.at(-1)!,
    });
  });

  it("refuses one byte of drift in any bucket, other CI provenance, or a missing credential consumer core row", () => {
    const mutations: Array<(changed: Tc1781DecryptStandardExpiryRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]--; },
      (changed) => { changed.root.delta["index.mjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.cjs"]++; },
      (changed) => { changed.worker.ceiling--; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1781DecryptStandardExpiryRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc712CredentialCoreRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("decrypt standard expiry");
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1781DecryptStandardExpiryRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1781DecryptStandardExpiryRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.mjs"]++;
    expect(() => validateTc1781DecryptStandardExpiryRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1781DecryptStandardExpiryRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("manifest limit guards (#702, TC-1855) raised root ceiling ratchet", () => {
  const row = () => structuredClone(approvedTc1855ManifestLimitGuardRatchet);

  it("raises only the root ceilings, by the exact canonical CI delta over the decrypt standard expiry row, and nothing else", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(JSON.stringify(current.tc1855ManifestLimitGuardRatchet)).toBe(JSON.stringify(approvedTc1855ManifestLimitGuardRatchet));
    expect(row().root.delta).toEqual({ "index.mjs": 155, "index.cjs": 106 });
    expect(row().root.ceiling).toEqual({ "index.mjs": 1462474, "index.cjs": 1404741 });
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(row().root.ceiling[format]).toBe(approvedTc1781DecryptStandardExpiryRatchet.root.ceiling[format] + row().root.delta[format]);
    }
    expect(row().firstImport).toEqual({ ...approvedTc1781DecryptStandardExpiryRatchet.firstImport, delta: { "replica.mjs": 0, "replica.cjs": 0 } });
    expect(row().activation).toEqual({ ...approvedTc1781DecryptStandardExpiryRatchet.activation, delta: { "activation.mjs": 0, "activation.cjs": 0 } });
    expect(row().worker).toEqual({ delta: 0, ceiling: approvedTc1781DecryptStandardExpiryRatchet.worker.ceiling });
    expect(row().ruling).toBe("Approved by Naomi (2026-10-24; accepted ~+168 B CJS to keep every guard; judge by the CJS delta)");
    expect(row().base).toBe("9a5eed8fee222c091d823e3f1c49127011408693");
    expect(row().sourceCommits).toEqual(["657abe77d520e8174e1394daf5911847bd2ff57d"]);
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/40058867098");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1855ManifestLimitGuardRatchet", pin: row().sourceCommits.at(-1)!,
    });
    expect(rootCeilings(current).find((e) => e.row === "tc1855ManifestLimitGuardRatchet")).toEqual({ row: "tc1855ManifestLimitGuardRatchet", ceiling: row().root.ceiling });
  });

  it("refuses one byte of drift in any bucket, other CI provenance, or a missing decrypt standard expiry row", () => {
    const mutations: Array<(changed: Tc1855ManifestLimitGuardRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]--; },
      (changed) => { changed.root.delta["index.mjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.cjs"]++; },
      (changed) => { changed.worker.ceiling--; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1855ManifestLimitGuardRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc1781DecryptStandardExpiryRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("manifest limit guard");
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1855ManifestLimitGuardRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1855ManifestLimitGuardRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.mjs"]++;
    expect(() => validateTc1855ManifestLimitGuardRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1855ManifestLimitGuardRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("browser SIWE domain and URI (#604, TC-1488) raised root ceiling ratchet", () => {
  const row = () => structuredClone(approvedTc1488SiweDomainUriRatchet);

  it("raises only the root ceilings, by the exact canonical CI delta over the manifest limit guard row, and nothing else", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(JSON.stringify(current.tc1488SiweDomainUriRatchet)).toBe(JSON.stringify(approvedTc1488SiweDomainUriRatchet));
    expect(row().root.delta).toEqual({ "index.mjs": 35, "index.cjs": 35 });
    expect(row().root.ceiling).toEqual({ "index.mjs": 1462509, "index.cjs": 1404776 });
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(row().root.ceiling[format]).toBe(approvedTc1855ManifestLimitGuardRatchet.root.ceiling[format] + row().root.delta[format]);
    }
    expect(row().firstImport).toEqual({ ...approvedTc1855ManifestLimitGuardRatchet.firstImport, delta: { "replica.mjs": 0, "replica.cjs": 0 } });
    expect(row().activation).toEqual({ ...approvedTc1855ManifestLimitGuardRatchet.activation, delta: { "activation.mjs": 0, "activation.cjs": 0 } });
    expect(row().worker).toEqual({ delta: 0, ceiling: approvedTc1855ManifestLimitGuardRatchet.worker.ceiling });
    expect(row().ruling).toBe("Approved by Naomi (2026-10-24; exact canonical CI bytes, no headroom)");
    expect(row().base).toBe("8e431447f23a164da75faed067d4b16af5c77ef0");
    expect(row().sourceCommits).toEqual(["aaa4ce3e6c9182c8022aaff3511c9f2144a5b756"]);
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/40089434307");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1488SiweDomainUriRatchet", pin: row().sourceCommits.at(-1)!,
    });
    expect(rootCeilings(current).find((e) => e.row === "tc1488SiweDomainUriRatchet")).toEqual({ row: "tc1488SiweDomainUriRatchet", ceiling: row().root.ceiling });
  });

  it("refuses one byte of drift in any bucket, other CI provenance, or a missing manifest limit guard row", () => {
    const mutations: Array<(changed: Tc1488SiweDomainUriRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]--; },
      (changed) => { changed.root.delta["index.mjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.cjs"]++; },
      (changed) => { changed.worker.ceiling--; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1488SiweDomainUriRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc1855ManifestLimitGuardRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("SIWE domain and URI");
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1488SiweDomainUriRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1488SiweDomainUriRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.mjs"]++;
    expect(() => validateTc1488SiweDomainUriRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1488SiweDomainUriRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("short links v=4 (#708, TC-1737) root ceiling ratchet", () => {
  const row = () => structuredClone(approvedTc1737ShortLinkLazyChunkRatchet);

  it("carries the index.mjs ceiling, sets index.cjs to the exact canonical CI bytes, and carries every other ceiling", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(JSON.stringify(current.tc1737ShortLinkLazyChunkRatchet)).toBe(JSON.stringify(approvedTc1737ShortLinkLazyChunkRatchet));
    expect(row().root.delta).toEqual({ "index.mjs": 0, "index.cjs": 166 });
    expect(row().root.ceiling).toEqual({ "index.mjs": 1462509, "index.cjs": 1404942 });
    expect(row().reason).toContain("index.mjs measured 1461950 in CI run 40136320965 and its ceiling is not lowered (within the TC-1985 gzip-alignment swing)");
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(row().root.ceiling[format]).toBe(approvedTc1488SiweDomainUriRatchet.root.ceiling[format] + row().root.delta[format]);
    }
    expect(row().firstImport).toEqual({ ...approvedTc1488SiweDomainUriRatchet.firstImport, delta: { "replica.mjs": 0, "replica.cjs": 0 } });
    expect(row().activation).toEqual({ ...approvedTc1488SiweDomainUriRatchet.activation, delta: { "activation.mjs": 0, "activation.cjs": 0 } });
    expect(row().ruling).toContain("worker ceilings unchanged");
    expect(row().base).toBe("e6aad66159e81b47c937da584a4c7f019be54100");
    expect(row().sourceCommits).toEqual(["8d15cd6123fd37924db59065e1317682dbff2772"]);
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/40136320965");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1737ShortLinkLazyChunkRatchet", pin: row().sourceCommits.at(-1)!,
    });
    expect(rootCeilings(current).find((e) => e.row === "tc1737ShortLinkLazyChunkRatchet")).toEqual({ row: "tc1737ShortLinkLazyChunkRatchet", ceiling: row().root.ceiling });
    expect(rootCeilings(current).map(({ row: name }) => name)).not.toContain("tc1827ReplicaWorkerRatchet");
  });

  it("refuses one byte of drift in any bucket, other CI provenance, or a missing SIWE domain and URI row", () => {
    const mutations: Array<(changed: Tc1737ShortLinkLazyChunkRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]--; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.cjs"]++; },
      (changed) => { changed.worker.ceiling--; },
      (changed) => { changed.worker.delta++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1737ShortLinkLazyChunkRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc1488SiweDomainUriRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("short-link");
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1737ShortLinkLazyChunkRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1737ShortLinkLazyChunkRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc1737ShortLinkLazyChunkRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1737ShortLinkLazyChunkRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("invocation signing consistency (#721, TC-1910) root ceiling ratchet", () => {
  const row = () => structuredClone(approvedTc1910SigningConsistencyRatchet);

  it("carries the index.mjs ceiling, sets index.cjs to the exact canonical CI bytes, and carries every other ceiling", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(JSON.stringify(current.tc1910SigningConsistencyRatchet)).toBe(JSON.stringify(approvedTc1910SigningConsistencyRatchet));
    expect(row().root.delta).toEqual({ "index.mjs": 0, "index.cjs": 237 });
    expect(row().root.ceiling).toEqual({ "index.mjs": 1462509, "index.cjs": 1405179 });
    expect(row().reason).toContain("index.mjs measured 1,462,173 (ceiling carried)");
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(row().root.ceiling[format]).toBe(approvedTc1737ShortLinkLazyChunkRatchet.root.ceiling[format] + row().root.delta[format]);
    }
    expect(row().firstImport).toEqual({ ...approvedTc1737ShortLinkLazyChunkRatchet.firstImport, delta: { "replica.mjs": 0, "replica.cjs": 0 } });
    expect(row().activation).toEqual({ ...approvedTc1737ShortLinkLazyChunkRatchet.activation, delta: { "activation.mjs": 0, "activation.cjs": 0 } });
    expect(row().worker).toEqual({ delta: 0, ceiling: approvedTc1737ShortLinkLazyChunkRatchet.worker.ceiling });
    expect(row().base).toBe("be28faab7608bf12ef4308666c3163b5ccceda93");
    expect(row().sourceCommits).toEqual(["f5f76a58f87afda5054969847c716bfac63fbbf3"]);
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/40176697796");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc1910SigningConsistencyRatchet", pin: row().sourceCommits.at(-1)!,
    });
    expect(rootCeilings(current).find((e) => e.row === "tc1910SigningConsistencyRatchet")).toEqual({ row: "tc1910SigningConsistencyRatchet", ceiling: row().root.ceiling });
  });

  it("refuses one byte of drift in any bucket, other CI provenance, or a missing short-link row", () => {
    const mutations: Array<(changed: Tc1910SigningConsistencyRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]--; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.cjs"]++; },
      (changed) => { changed.worker.ceiling--; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1910SigningConsistencyRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc1737ShortLinkLazyChunkRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("signing-consistency");
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc1910SigningConsistencyRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1910SigningConsistencyRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc1910SigningConsistencyRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1910SigningConsistencyRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("settings panel launcher, host and toasts (#731, TC-848) root ceiling ratchet", () => {
  const row = () => structuredClone(approvedTc848SettingsPanelRatchet);

  it("raises the index.mjs ceiling by 1669 and the index.cjs ceiling by 828 over the signing-consistency row, and carries every other ceiling", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(JSON.stringify(current.tc848SettingsPanelRatchet)).toBe(JSON.stringify(approvedTc848SettingsPanelRatchet));
    expect(row().root.delta).toEqual({ "index.mjs": 1669, "index.cjs": 828 });
    expect(row().root.ceiling).toEqual({ "index.mjs": 1464178, "index.cjs": 1406007 });
    expect(row().reason).toContain("panel eager launcher");
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(row().root.ceiling[format]).toBe(approvedTc1910SigningConsistencyRatchet.root.ceiling[format] + row().root.delta[format]);
    }
    expect(row().firstImport).toEqual({ ...approvedTc1910SigningConsistencyRatchet.firstImport, delta: { "replica.mjs": 0, "replica.cjs": 0 } });
    expect(row().activation).toEqual({ ...approvedTc1910SigningConsistencyRatchet.activation, delta: { "activation.mjs": 0, "activation.cjs": 0 } });
    expect(row().worker).toEqual({ delta: 0, ceiling: approvedTc1910SigningConsistencyRatchet.worker.ceiling });
    expect(row().base).toBe("b90a608ea0b079073845e0a0995f0c55e529d3af");
    expect(row().sourceCommits).toEqual(["5d8535af1444d636029eb0733229006c2249b444"]);
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/40220911012");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc848SettingsPanelRatchet", pin: row().sourceCommits.at(-1)!,
    });
    expect(rootCeilings(current).find((e) => e.row === "tc848SettingsPanelRatchet")).toEqual({ row: "tc848SettingsPanelRatchet", ceiling: row().root.ceiling });
  });

  it("refuses one byte of drift in any bucket, other CI provenance, or a missing signing-consistency row", () => {
    const mutations: Array<(changed: Tc848SettingsPanelRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]--; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.cjs"]++; },
      (changed) => { changed.worker.ceiling--; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc848SettingsPanelRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc1910SigningConsistencyRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("panel");
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc848SettingsPanelRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc848SettingsPanelRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc848SettingsPanelRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc848SettingsPanelRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("named-keys CLI sign-in report (#739, TC-2034) root ceiling ratchet", () => {
  const row = () => structuredClone(approvedTc2034NamedKeysCliRatchet);

  it("raises the two root ceilings by the exact canonical CI bytes over the settings panel row, and carries every other ceiling", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(JSON.stringify(current.tc2034NamedKeysCliRatchet)).toBe(JSON.stringify(approvedTc2034NamedKeysCliRatchet));
    expect(row().root.delta).toEqual({ "index.mjs": 139, "index.cjs": 145 });
    expect(row().root.ceiling).toEqual({ "index.mjs": 1464317, "index.cjs": 1406152 });
    expect(row().reason).toContain("named-keys CLI");
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(row().root.ceiling[format]).toBe(approvedTc848SettingsPanelRatchet.root.ceiling[format] + row().root.delta[format]);
    }
    expect(row().firstImport).toEqual({ ...approvedTc848SettingsPanelRatchet.firstImport, delta: { "replica.mjs": 0, "replica.cjs": 0 } });
    expect(row().activation).toEqual({ ...approvedTc848SettingsPanelRatchet.activation, delta: { "activation.mjs": 0, "activation.cjs": 0 } });
    expect(row().worker).toEqual({ delta: 0, ceiling: approvedTc848SettingsPanelRatchet.worker.ceiling });
    expect(row().base).toBe("d01d67c02ef6587295212f507863d164f05961f9");
    expect(row().sourceCommits).toEqual(["331a52de6b06a350cd62f149d74b6ebe315bc0c5"]);
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/40240409880");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc2034NamedKeysCliRatchet", pin: row().sourceCommits.at(-1)!,
    });
    expect(rootCeilings(current).find((e) => e.row === "tc2034NamedKeysCliRatchet")).toEqual({ row: "tc2034NamedKeysCliRatchet", ceiling: row().root.ceiling });
  });

  it("refuses one byte of drift in any bucket, other CI provenance, or a missing settings panel row", () => {
    const mutations: Array<(changed: Tc2034NamedKeysCliRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]++; },
      (changed) => { changed.root.ceiling["index.cjs"]--; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.cjs"]++; },
      (changed) => { changed.worker.ceiling--; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc2034NamedKeysCliRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc848SettingsPanelRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("named-keys");
  });

  it("may be introduced once and never changed or removed in a later base", () => {
    expect(() => validateTc2034NamedKeysCliRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc2034NamedKeysCliRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc2034NamedKeysCliRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc2034NamedKeysCliRatchetTransition(row(), undefined)).toThrow();
  });
});

const tc2043Ledger: Ledger = copy(current);
delete tc2043Ledger.tc1888PurgeLocalCopyRatchet;
delete tc2043Ledger.tc1977ManifestKeysRatchet;
delete tc2043Ledger.tc2038PanelPrefetchRatchet;
delete tc2043Ledger.tc2005RevokeWindowRatchet;
delete tc2043Ledger.tc2096RepairBackoffRatchet;
delete tc2043Ledger.tc2096LazyContentRatchet;
delete tc2043Ledger.tc2072LocationGuardRatchet;
delete tc2043Ledger.tc2113PanelGrantRatchet;
delete tc2043Ledger.tc2127WindowLocationRatchet;
delete tc2043Ledger.tc1977OpenKeySigninRatchet;
delete tc2043Ledger.tc2130PanelIphoneRatchet;
delete tc2043Ledger.tc1977HostBindingRatchet;
delete tc2043Ledger.tc2132IssuedDelegationsRatchet;
delete tc2043Ledger.tc2140ExactKeyDelegationRatchet;
delete tc2043Ledger.tc2202AgentShareReceiveRatchet;
delete tc2043Ledger.tc2205HomeFeedRatchet;
delete tc2043Ledger.tc2230SiweRecipientsRatchet;
delete tc2043Ledger.tc2192ExactKeyRuntimeConsentRatchet;
tc2043Ledger.entries = structuredClone(current.entries.slice(0, current.entries.findIndex((entry) => entry.pr === "#728")));
describe("replication syncScope opt-in (#742, TC-2043) size ratchet", () => {
  const row = () => structuredClone(approvedTc2043SyncScopeRatchet);

  it("pins exact CI bytes and carries unchanged activation and worker ceilings", () => {
    expect(() => validateLedger(tc2043Ledger)).not.toThrow();
    expect(tc2043Ledger.tc2043SyncScopeRatchet).toEqual(approvedTc2043SyncScopeRatchet);
    expect(tc2043Ledger.entries.at(-1)).toMatchObject({ pr: "#742", ticket: "TC-2043" });
    expect(row().root).toEqual({ delta: { "index.mjs": 41, "index.cjs": 30 }, ceiling: { "index.mjs": 1464358, "index.cjs": 1406182 } });
    expect(row().firstImport).toEqual({ delta: { "replica.mjs": 40, "replica.cjs": 39 }, ceiling: { "replica.mjs": 51965, "replica.cjs": 67178 } });
    expect(row().activation).toEqual({ ...approvedTc2034NamedKeysCliRatchet.activation, delta: { "activation.mjs": 0, "activation.cjs": 0 } });
    expect(row().worker).toEqual({ delta: 0, ceiling: approvedTc2034NamedKeysCliRatchet.worker.ceiling });
    expect(row().root.ceiling["index.mjs"]).toBe(approvedTc2034NamedKeysCliRatchet.root.ceiling["index.mjs"] + 41);
    expect(row().root.ceiling["index.cjs"]).toBe(approvedTc2034NamedKeysCliRatchet.root.ceiling["index.cjs"] + 30);
    expect(row().base).toBe("ddfb8bb54f1d977718631735b5fc4aac3b84e9a3");
    expect(row().sourceCommits).toEqual(["f6740607a9c5ef1ac9b979388add8515aea7e929"]);
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/40247206055");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(tc2043Ledger, false)).toContainEqual({ row: "tc2043SyncScopeRatchet", pin: row().sourceCommits[0] });
    expect(rootCeilings(tc2043Ledger).at(-1)).toEqual({ row: "tc2043SyncScopeRatchet", ceiling: row().root.ceiling });
  });

  it("refuses changed bytes, provenance or a missing named-keys prerequisite", () => {
    const mutations: Array<(changed: Tc2043SyncScopeRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.firstImport.delta["replica.mjs"]++; },
      (changed) => { changed.activation.ceiling["activation.mjs"]++; },
      (changed) => { changed.worker.ceiling++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(tc2043Ledger);
      const changed = row();
      mutate(changed);
      ledger.tc2043SyncScopeRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPrerequisite = copy(tc2043Ledger);
    delete withoutPrerequisite.tc2034NamedKeysCliRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("syncScope");
  });

  it("may be introduced once and never changed or removed", () => {
    expect(() => validateTc2043SyncScopeRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc2043SyncScopeRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc2043SyncScopeRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc2043SyncScopeRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("sign-out local copy erase (#728, TC-1888) size ratchet", () => {
  const row = () => structuredClone(approvedTc1888PurgeLocalCopyRatchet);

  it("pins exact CI bytes and the merged TC-2043 prerequisite", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc1888PurgeLocalCopyRatchet).toEqual(approvedTc1888PurgeLocalCopyRatchet);
    expect(row().root).toEqual({ delta: { "index.mjs": 271, "index.cjs": 274 }, ceiling: { "index.mjs": 1464629, "index.cjs": 1406456 } });
    expect(row().firstImport).toEqual({ delta: { "replica.mjs": 409, "replica.cjs": 393 }, ceiling: { "replica.mjs": 52374, "replica.cjs": 67571 } });
    expect(row().activation).toEqual({ delta: { "activation.mjs": 270, "activation.cjs": 261 }, ceiling: { "activation.mjs": 23386, "activation.cjs": 24959 } });
    expect(row().worker).toEqual({ delta: 0, ceiling: 776128 });
    expect(row().base).toBe("bd41ce30df6cad86ce501a2230ecd2afebef2e66");
    expect(row().sourceCommits).toEqual(["36dd6e5061735907e200222fc5cac362076d024d"]);
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/40303939643");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(current, false)).toContainEqual({ row: "tc1888PurgeLocalCopyRatchet", pin: row().sourceCommits[0] });
    expect(rootCeilings(current).find((row) => row.row === "tc1888PurgeLocalCopyRatchet")).toEqual({ row: "tc1888PurgeLocalCopyRatchet", ceiling: row().root.ceiling });
    expect(current.entries.find((entry) => entry.pr === "#728")).toMatchObject({ pr: "#728", ticket: "TC-1888", "index.mjs": 0, "index.cjs": 0 });
  });

  it("refuses changed bytes, provenance or a missing TC-2043 prerequisite", () => {
    const mutations: Array<(changed: Tc1888PurgeLocalCopyRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.firstImport.delta["replica.mjs"]++; },
      (changed) => { changed.activation.ceiling["activation.mjs"]++; },
      (changed) => { changed.worker.ceiling++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1888PurgeLocalCopyRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc2043SyncScopeRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("local copy");
  });

  it("may be introduced once and never changed or removed", () => {
    expect(() => validateTc1888PurgeLocalCopyRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1888PurgeLocalCopyRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc1888PurgeLocalCopyRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1888PurgeLocalCopyRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("manifest named keys (#748, TC-1977) size ratchet", () => {
  const row = () => structuredClone(approvedTc1977ManifestKeysRatchet);

  it("pins exact CI bytes and carries unchanged first-import, activation and worker ceilings", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc1977ManifestKeysRatchet).toEqual(approvedTc1977ManifestKeysRatchet);
    expect(row().root.delta).toEqual({ "index.mjs": 2665, "index.cjs": 2808 });
    expect(row().root.ceiling).toEqual({ "index.mjs": 1467294, "index.cjs": 1409264 });
    expect(row().firstImport).toEqual({ ...approvedTc1888PurgeLocalCopyRatchet.firstImport, delta: { "replica.mjs": 0, "replica.cjs": 0 } });
    expect(row().activation).toEqual({ ...approvedTc1888PurgeLocalCopyRatchet.activation, delta: { "activation.mjs": 0, "activation.cjs": 0 } });
    expect(row().worker).toEqual({ delta: 0, ceiling: approvedTc1888PurgeLocalCopyRatchet.worker.ceiling });
    expect(row().base).toBe("5467d1248b20e59d3b7eca508da417c2b35316b3");
    expect(row().sourceCommits).toEqual(["796fdd2a13c0f6b0e6f767e0347151c0cbaf84fe"]);
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/40318285314");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(rootCeilings(current).find(({ row: name }) => name === "tc1977ManifestKeysRatchet")).toEqual({ row: "tc1977ManifestKeysRatchet", ceiling: row().root.ceiling });
  });

  it("refuses changed bytes, provenance or a missing sign-out local copy prerequisite", () => {
    const mutations: Array<(changed: Tc1977ManifestKeysRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.mjs"]++; },
      (changed) => { changed.worker.ceiling++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc1977ManifestKeysRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc1888PurgeLocalCopyRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("manifest-keys");
  });

  it("may be introduced once and never changed or removed", () => {
    expect(() => validateTc1977ManifestKeysRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1977ManifestKeysRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc1977ManifestKeysRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc1977ManifestKeysRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("panel prefetch ability gating (TC-2038) size ratchet", () => {
  const row = () => structuredClone(approvedTc2038PanelPrefetchRatchet);

  it("pins exact CI bytes and carries unchanged first-import, activation and worker ceilings", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc2038PanelPrefetchRatchet).toEqual(approvedTc2038PanelPrefetchRatchet);
    expect(row().root.delta).toEqual({ "index.mjs": 12, "index.cjs": 9 });
    expect(row().root.ceiling).toEqual({ "index.mjs": 1467306, "index.cjs": 1409273 });
    expect(row().root.ceiling["index.mjs"]).toBe(approvedTc1977ManifestKeysRatchet.root.ceiling["index.mjs"] + 12);
    expect(row().root.ceiling["index.cjs"]).toBe(approvedTc1977ManifestKeysRatchet.root.ceiling["index.cjs"] + 9);
    expect(row().firstImport).toEqual({ ...approvedTc1977ManifestKeysRatchet.firstImport, delta: { "replica.mjs": 0, "replica.cjs": 0 } });
    expect(row().activation).toEqual({ ...approvedTc1977ManifestKeysRatchet.activation, delta: { "activation.mjs": 0, "activation.cjs": 0 } });
    expect(row().worker).toEqual({ delta: 0, ceiling: approvedTc1977ManifestKeysRatchet.worker.ceiling });
    expect(row().base).toBe("c59bcd3ac04c18583025d402283aa687545ab9f3");
    expect(row().sourceCommits).toEqual(["1381ddff663cb62f63c4dee95293fcbc12d673d5"]);
    expect(row().canonicalCI.run).toBe("https://github.com/TinyCloudLabs/js-sdk/actions/runs/40331788730");
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(rootCeilings(current).find(({ row: name }) => name === "tc2038PanelPrefetchRatchet")).toEqual({ row: "tc2038PanelPrefetchRatchet", ceiling: row().root.ceiling });
  });

  it("refuses changed bytes, provenance or a missing manifest-keys prerequisite", () => {
    const mutations: Array<(changed: Tc2038PanelPrefetchRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.mjs"]++; },
      (changed) => { changed.worker.ceiling++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc2038PanelPrefetchRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow();
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc1977ManifestKeysRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("panel-prefetch");
  });

  it("may be introduced once and never changed or removed", () => {
    expect(() => validateTc2038PanelPrefetchRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc2038PanelPrefetchRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc2038PanelPrefetchRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc2038PanelPrefetchRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("owner revocation window (TC-2005, #745) size ratchet", () => {
  const row = () => structuredClone(approvedTc2005RevokeWindowRatchet);

  it("pins exact CI bytes over the panel prefetch row and carries unchanged first-import, activation and worker ceilings", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc2005RevokeWindowRatchet).toEqual(approvedTc2005RevokeWindowRatchet);
    expect(row().root).toEqual({ delta: { "index.mjs": 52, "index.cjs": 0 }, ceiling: { "index.mjs": 1467358, "index.cjs": 1409273 } });
    expect(row().root.ceiling["index.mjs"]).toBe(approvedTc2038PanelPrefetchRatchet.root.ceiling["index.mjs"] + 52);
    expect(row().root.ceiling["index.cjs"]).toBe(approvedTc2038PanelPrefetchRatchet.root.ceiling["index.cjs"]);
    expect(row().firstImport).toEqual({ delta: { "replica.mjs": 0, "replica.cjs": 0 }, ceiling: { "replica.mjs": 52374, "replica.cjs": 67571 } });
    expect(row().activation).toEqual({ delta: { "activation.mjs": 0, "activation.cjs": 0 }, ceiling: { "activation.mjs": 23386, "activation.cjs": 24959 } });
    expect(row().worker).toEqual({ delta: 0, ceiling: 776128 });
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(current, false)).toContainEqual({ row: "tc2005RevokeWindowRatchet", pin: row().sourceCommits[0] });
    expect(rootCeilings(current).find(({ row: name }) => name === "tc2005RevokeWindowRatchet")).toEqual({ row: "tc2005RevokeWindowRatchet", ceiling: row().root.ceiling });
  });

  it("refuses changed bytes, provenance or a missing panel-prefetch prerequisite", () => {
    const mutations: Array<(changed: Tc2005RevokeWindowRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.mjs"]++; },
      (changed) => { changed.worker.ceiling++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc2005RevokeWindowRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow("revocation-window");
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc2038PanelPrefetchRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("revocation-window");
  });

  it("may be introduced once and never changed or removed", () => {
    expect(() => validateTc2005RevokeWindowRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc2005RevokeWindowRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc2005RevokeWindowRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc2005RevokeWindowRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("capped replica repair backoff (TC-2096, #759) size ratchet", () => {
  const row = () => structuredClone(approvedTc2096RepairBackoffRatchet);

  it("pins exact CI bytes over the revocation-window row, keeps root, first import and activation, and carries both worker deltas", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc2096RepairBackoffRatchet).toEqual(approvedTc2096RepairBackoffRatchet);
    expect(row().root).toEqual({ delta: { "index.mjs": 0, "index.cjs": 0 }, ceiling: approvedTc2005RevokeWindowRatchet.root.ceiling });
    expect(structuredClone(approvedTc2005RevokeWindowRatchet).firstImport).toEqual({ delta: { "replica.mjs": 0, "replica.cjs": 0 }, ceiling: approvedTc2005RevokeWindowRatchet.firstImport.ceiling });
    expect(structuredClone(approvedTc2005RevokeWindowRatchet).activation).toEqual({ delta: { "activation.mjs": 0, "activation.cjs": 0 }, ceiling: approvedTc2005RevokeWindowRatchet.activation.ceiling });
    expect(row().worker.delta).toBe(340);
    expect(row().worker.ceiling).toBe(approvedTc2005RevokeWindowRatchet.worker.ceiling + row().worker.delta);
    expect(row().replicaWorker.delta).toBe(323);
    expect(row().replicaWorker.ceiling).toBe(approvedTc1827ReplicaWorkerRatchet.worker.ceiling + row().replicaWorker.delta);
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(current, false)).toContainEqual({ row: "tc2096RepairBackoffRatchet", pin: row().sourceCommits[0] });
    expect(rootCeilings(current).find((entry) => entry.row === "tc2096RepairBackoffRatchet")).toEqual({ row: "tc2096RepairBackoffRatchet", ceiling: row().root.ceiling });
    expect(MAX_WORKER_GZIP_BYTES).toBe(newestKvWorkerCeiling());
    expect(MAX_REPLICA_WORKER_GZIP_BYTES).toBe(newestReplicaWorkerCeiling());
  });

  it("pins the TC-2096 first-import +279/+275 and activation -2/-2 deltas with their measured ceilings", () => {
    expect(row().firstImport).toEqual({ delta: { "replica.mjs": 279, "replica.cjs": 275 }, ceiling: { "replica.mjs": 52653, "replica.cjs": 67846 } });
    expect(row().activation).toEqual({ delta: { "activation.mjs": -2, "activation.cjs": -2 }, ceiling: { "activation.mjs": 23386, "activation.cjs": 24959 } });
  });

  it("refuses changed bytes, provenance or a missing revocation-window prerequisite", () => {
    const changedWorker = copy(current);
    changedWorker.tc2096RepairBackoffRatchet!.worker.ceiling++;
    expect(() => validateLedger(changedWorker)).toThrow("repair-backoff");
    const changedReplica = copy(current);
    changedReplica.tc2096RepairBackoffRatchet!.replicaWorker!.ceiling++;
    expect(() => validateLedger(changedReplica)).toThrow("repair-backoff");
    const changedRoot = copy(current);
    changedRoot.tc2096RepairBackoffRatchet!.root.ceiling["index.cjs"]++;
    expect(() => validateLedger(changedRoot)).toThrow("repair-backoff");
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc2005RevokeWindowRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("repair-backoff");
  });

  it("may be introduced once and never changed or removed", () => {
    expect(() => validateTc2096RepairBackoffRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc2096RepairBackoffRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.worker.ceiling++;
    expect(() => validateTc2096RepairBackoffRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc2096RepairBackoffRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("TinyCloudWeb location guard (TC-2072, #754) size ratchet", () => {
  const row = () => structuredClone(approvedTc2072LocationGuardRatchet);

  it("pins exact CI bytes over the repair-backoff row and carries its first-import, activation, worker and replica-worker ceilings", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc2072LocationGuardRatchet).toEqual(approvedTc2072LocationGuardRatchet);
    expect(row().root).toEqual({ delta: { "index.mjs": 0, "index.cjs": 8 }, ceiling: { "index.mjs": 1467358, "index.cjs": 1409281 } });
    expect(row().root.ceiling["index.mjs"]).toBe(approvedTc2096RepairBackoffRatchet.root.ceiling["index.mjs"] + 0);
    expect(row().root.ceiling["index.cjs"]).toBe(approvedTc2096RepairBackoffRatchet.root.ceiling["index.cjs"] + 8);
    expect(row().firstImport).toEqual({ delta: { "replica.mjs": 0, "replica.cjs": 0 }, ceiling: { "replica.mjs": 52653, "replica.cjs": 67846 } });
    expect(row().activation).toEqual({ delta: { "activation.mjs": 0, "activation.cjs": 0 }, ceiling: { "activation.mjs": 23386, "activation.cjs": 24959 } });
    expect(row().worker).toEqual({ delta: 0, ceiling: 776468 });
    expect(row().replicaWorker).toEqual({ delta: 0, ceiling: 770416 });
    expect(row().canonicalCI.jobs).toHaveLength(2);
    expect(ancestryPins(current, false)).toContainEqual({ row: "tc2072LocationGuardRatchet", pin: row().sourceCommits[0] });
    expect(rootRowsInFileOrder(current)).toContain("tc2072LocationGuardRatchet");
    expect(rootCeilings(current).find(({ row: name }) => name === "tc2072LocationGuardRatchet")).toEqual({ row: "tc2072LocationGuardRatchet", ceiling: row().root.ceiling });
    expect(MAX_WORKER_GZIP_BYTES).toBe(newestKvWorkerCeiling());
    expect(MAX_REPLICA_WORKER_GZIP_BYTES).toBe(newestReplicaWorkerCeiling());
  });

  it("refuses changed bytes, provenance or a missing repair-backoff prerequisite", () => {
    const mutations: Array<(changed: Tc2072LocationGuardRatchet) => void> = [
      (changed) => { changed.root.ceiling["index.mjs"]++; },
      (changed) => { changed.root.delta["index.cjs"]++; },
      (changed) => { changed.firstImport.ceiling["replica.cjs"]++; },
      (changed) => { changed.activation.ceiling["activation.mjs"]++; },
      (changed) => { changed.worker.ceiling++; },
      (changed) => { changed.replicaWorker.ceiling++; },
      (changed) => { changed.canonicalCI.run = "https://github.com/TinyCloudLabs/js-sdk/actions/runs/1"; },
      (changed) => { changed.sourceCommits = ["0".repeat(40)]; },
    ];
    for (const mutate of mutations) {
      const ledger = copy(current);
      const changed = row();
      mutate(changed);
      ledger.tc2072LocationGuardRatchet = changed;
      expect(() => validateLedger(ledger)).toThrow("location-guard");
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc2096RepairBackoffRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("location-guard");
  });

  it("may be introduced once and never changed or removed", () => {
    expect(() => validateTc2072LocationGuardRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc2072LocationGuardRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc2072LocationGuardRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc2072LocationGuardRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("lazy replica content fetch (TC-2096, #761) size ratchet", () => {
  const row = () => structuredClone(approvedTc2096LazyContentRatchet);
  const prerequisite = () => approvedTc2072LocationGuardRatchet;

  it("pins the lazy-fetch worker, first-import and activation deltas over the location-guard row and keeps root unchanged", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc2096LazyContentRatchet).toEqual(approvedTc2096LazyContentRatchet);
    expect(row().root).toEqual({ delta: { "index.mjs": 0, "index.cjs": 0 }, ceiling: prerequisite().root.ceiling });
    expect(row().firstImport).toEqual({ delta: { "replica.mjs": 104, "replica.cjs": 111 }, ceiling: { "replica.mjs": 52757, "replica.cjs": 67957 } });
    expect(row().activation).toEqual({ delta: { "activation.mjs": 26, "activation.cjs": 22 }, ceiling: { "activation.mjs": 23412, "activation.cjs": 24981 } });
    expect(row().worker.delta).toBe(71);
    expect(row().worker.ceiling).toBe(prerequisite().worker.ceiling + row().worker.delta);
    expect(row().replicaWorker.delta).toBe(51);
    expect(row().replicaWorker.ceiling).toBe(prerequisite().replicaWorker.ceiling + row().replicaWorker.delta);
    expect(rootCeilings(current).find(({ row: name }) => name === "tc2096LazyContentRatchet")).toEqual({ row: "tc2096LazyContentRatchet", ceiling: row().root.ceiling });
    expect(ancestryPins(current, false)).toContainEqual({ row: "tc2096LazyContentRatchet", pin: row().sourceCommits[0] });
    expect(MAX_WORKER_GZIP_BYTES).toBe(newestKvWorkerCeiling());
    expect(MAX_REPLICA_WORKER_GZIP_BYTES).toBe(newestReplicaWorkerCeiling());
  });

  it("refuses changed bytes or a missing location-guard prerequisite", () => {
    const changedWorker = copy(current);
    changedWorker.tc2096LazyContentRatchet!.worker.ceiling++;
    expect(() => validateLedger(changedWorker)).toThrow("lazy-content");
    const changedReplica = copy(current);
    changedReplica.tc2096LazyContentRatchet!.replicaWorker!.ceiling++;
    expect(() => validateLedger(changedReplica)).toThrow("lazy-content");
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc2072LocationGuardRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("lazy-content");
  });

  it("may be introduced once and never changed or removed", () => {
    expect(() => validateTc2096LazyContentRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc2096LazyContentRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.worker.ceiling++;
    expect(() => validateTc2096LazyContentRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc2096LazyContentRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("panel grant delegation-list ask (TC-2113, #763) size ratchet", () => {
  const row = () => structuredClone(approvedTc2113PanelGrantRatchet);
  const prerequisite = () => approvedTc2096LazyContentRatchet;

  it("pins the panel-grant root delta over the lazy-content row and keeps the other tiers unchanged", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc2113PanelGrantRatchet).toEqual(approvedTc2113PanelGrantRatchet);
    expect(row().root).toEqual({ delta: { "index.mjs": 1641, "index.cjs": 1241 }, ceiling: { "index.mjs": 1468999, "index.cjs": 1410522 } });
    expect(row().firstImport).toEqual({ delta: { "replica.mjs": 0, "replica.cjs": 0 }, ceiling: { "replica.mjs": 52757, "replica.cjs": 67957 } });
    expect(row().activation).toEqual({ delta: { "activation.mjs": 0, "activation.cjs": 0 }, ceiling: { "activation.mjs": 23412, "activation.cjs": 24981 } });
    expect(row().worker.delta).toBe(0);
    expect(row().worker.ceiling).toBe(prerequisite().worker.ceiling);
    expect(row().replicaWorker.delta).toBe(0);
    expect(row().replicaWorker.ceiling).toBe(prerequisite().replicaWorker.ceiling);
    expect(rootCeilings(current).find(({ row: name }) => name === "tc2113PanelGrantRatchet")).toEqual({ row: "tc2113PanelGrantRatchet", ceiling: row().root.ceiling });
    expect(ancestryPins(current, false)).toContainEqual({ row: "tc2113PanelGrantRatchet", pin: row().sourceCommits[0] });
    expect(MAX_WORKER_GZIP_BYTES).toBe(newestKvWorkerCeiling());
    expect(MAX_REPLICA_WORKER_GZIP_BYTES).toBe(newestReplicaWorkerCeiling());
  });

  it("refuses changed bytes or a missing lazy-content prerequisite", () => {
    const changedWorker = copy(current);
    changedWorker.tc2113PanelGrantRatchet!.worker.ceiling++;
    expect(() => validateLedger(changedWorker)).toThrow("panel grant");
    const changedRoot = copy(current);
    changedRoot.tc2113PanelGrantRatchet!.root.ceiling["index.cjs"]++;
    expect(() => validateLedger(changedRoot)).toThrow("panel grant");
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc2096LazyContentRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("panel grant");
  });

  it("may be introduced once and never changed or removed", () => {
    expect(() => validateTc2113PanelGrantRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc2113PanelGrantRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.worker.ceiling++;
    expect(() => validateTc2113PanelGrantRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc2113PanelGrantRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("window location SIWE domain size ratchet (TC-2127, #764)", () => {
  const row = () => structuredClone(approvedTc2127WindowLocationRatchet);
  const prerequisite = () => approvedTc2113PanelGrantRatchet;

  it("pins the window-location root delta over the panel-grant row and keeps the other tiers unchanged", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc2127WindowLocationRatchet).toEqual(approvedTc2127WindowLocationRatchet);
    expect(row().root).toEqual({ delta: { "index.mjs": 1, "index.cjs": 3 }, ceiling: { "index.mjs": 1469000, "index.cjs": 1410525 } });
    expect(row().firstImport).toEqual(prerequisite().firstImport);
    expect(row().activation).toEqual(prerequisite().activation);
    expect(row().worker).toEqual(prerequisite().worker);
    expect(row().replicaWorker).toEqual(prerequisite().replicaWorker);
    expect(rootCeilings(current).find(({ row: name }) => name === "tc2127WindowLocationRatchet")).toEqual({ row: "tc2127WindowLocationRatchet", ceiling: row().root.ceiling });
    expect(ancestryPins(current, false)).toContainEqual({ row: "tc2127WindowLocationRatchet", pin: row().sourceCommits[0] });
    expect(MAX_WORKER_GZIP_BYTES).toBe(newestKvWorkerCeiling());
    expect(MAX_REPLICA_WORKER_GZIP_BYTES).toBe(newestReplicaWorkerCeiling());
  });

  it("refuses changed bytes or a missing panel-grant prerequisite", () => {
    const changedRoot = copy(current);
    changedRoot.tc2127WindowLocationRatchet!.root.ceiling["index.cjs"]++;
    expect(() => validateLedger(changedRoot)).toThrow("window location");
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc2113PanelGrantRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("window location");
  });

  it("may be introduced once and never changed or removed", () => {
    expect(() => validateTc2127WindowLocationRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc2127WindowLocationRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.worker.ceiling++;
    expect(() => validateTc2127WindowLocationRatchetTransition(undefined, changed)).toThrow();
    expect(() => validateTc2127WindowLocationRatchetTransition(row(), undefined)).toThrow();
  });
});

describe("signInWithOpenKey (TC-1977, #747) size ratchet", () => {
  const row = () => structuredClone(approvedTc1977OpenKeySigninRatchet);
  const prerequisite = () => approvedTc2127WindowLocationRatchet;

  it("pins the OpenKey sign-in root delta over the window location row and keeps the worker ceilings unchanged", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc1977OpenKeySigninRatchet).toEqual(approvedTc1977OpenKeySigninRatchet);
    expect(row().root).toEqual({ delta: { "index.mjs": 957, "index.cjs": 1025 }, ceiling: { "index.mjs": 1469957, "index.cjs": 1411550 } });
    expect(row().root.ceiling["index.mjs"]).toBe(prerequisite().root.ceiling["index.mjs"] + row().root.delta["index.mjs"]);
    expect(row().root.ceiling["index.cjs"]).toBe(prerequisite().root.ceiling["index.cjs"] + row().root.delta["index.cjs"]);
    expect(row().firstImport.ceiling).toEqual(prerequisite().firstImport.ceiling);
    expect(row().activation.ceiling).toEqual(prerequisite().activation.ceiling);
    expect(row().worker).toEqual({ delta: 0, ceiling: prerequisite().worker.ceiling });
    expect(row().replicaWorker).toEqual({ delta: 0, ceiling: prerequisite().replicaWorker.ceiling });
    expect(rootCeilings(current).find(({ row: name }) => name === "tc1977OpenKeySigninRatchet")).toEqual({ row: "tc1977OpenKeySigninRatchet", ceiling: row().root.ceiling });
    expect(ancestryPins(current, false)).toContainEqual({ row: "tc1977OpenKeySigninRatchet", pin: row().sourceCommits[0] });
    expect(MAX_WORKER_GZIP_BYTES).toBe(row().worker.ceiling);
    expect(MAX_REPLICA_WORKER_GZIP_BYTES).toBe(row().replicaWorker.ceiling);
  });

  it("refuses changed bytes or a missing window location prerequisite", () => {
    const changedRoot = copy(current);
    changedRoot.tc1977OpenKeySigninRatchet!.root.ceiling["index.mjs"]++;
    expect(() => validateLedger(changedRoot)).toThrow("OpenKey");
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc2127WindowLocationRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("OpenKey");
  });

  it("may be introduced once and never changed or removed", () => {
    expect(() => validateTc1977OpenKeySigninRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1977OpenKeySigninRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc1977OpenKeySigninRatchetTransition(undefined, changed)).toThrow("TC-1977");
    expect(() => validateTc1977OpenKeySigninRatchetTransition(row(), undefined)).toThrow("TC-1977");
  });
});

describe("iPhone panel safe-area and ui.setButtonVisible (TC-2130, #765) size ratchet", () => {
  const row = () => structuredClone(approvedTc2130PanelIphoneRatchet);
  const prerequisite = () => approvedTc1977OpenKeySigninRatchet;

  it("pins the panel safe-area root delta over the OpenKey sign-in row and keeps the worker ceilings unchanged", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc2130PanelIphoneRatchet).toEqual(approvedTc2130PanelIphoneRatchet);
    expect(row().root).toEqual({ delta: { "index.mjs": 303, "index.cjs": 282 }, ceiling: { "index.mjs": 1470260, "index.cjs": 1411832 } });
    expect(row().root.ceiling["index.mjs"]).toBe(prerequisite().root.ceiling["index.mjs"] + row().root.delta["index.mjs"]);
    expect(row().root.ceiling["index.cjs"]).toBe(prerequisite().root.ceiling["index.cjs"] + row().root.delta["index.cjs"]);
    expect(row().firstImport.ceiling).toEqual(prerequisite().firstImport.ceiling);
    expect(row().activation.ceiling).toEqual(prerequisite().activation.ceiling);
    expect(row().worker).toEqual({ delta: 0, ceiling: prerequisite().worker.ceiling });
    expect(row().replicaWorker).toEqual({ delta: 0, ceiling: prerequisite().replicaWorker.ceiling });
    expect(rootCeilings(current).find(({ row: name }) => name === "tc2130PanelIphoneRatchet")).toEqual({ row: "tc2130PanelIphoneRatchet", ceiling: row().root.ceiling });
    expect(ancestryPins(current, false)).toContainEqual({ row: "tc2130PanelIphoneRatchet", pin: row().sourceCommits[0] });
    expect(MAX_WORKER_GZIP_BYTES).toBe(row().worker.ceiling);
    expect(MAX_REPLICA_WORKER_GZIP_BYTES).toBe(row().replicaWorker.ceiling);
  });

  it("refuses changed bytes or a missing OpenKey sign-in prerequisite", () => {
    const changedRoot = copy(current);
    changedRoot.tc2130PanelIphoneRatchet!.root.ceiling["index.mjs"]++;
    expect(() => validateLedger(changedRoot)).toThrow("panel safe-area");
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc1977OpenKeySigninRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("panel safe-area");
  });

  it("may be introduced once and never changed or removed", () => {
    expect(() => validateTc2130PanelIphoneRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc2130PanelIphoneRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc2130PanelIphoneRatchetTransition(undefined, changed)).toThrow("TC-2130");
    expect(() => validateTc2130PanelIphoneRatchetTransition(row(), undefined)).toThrow("TC-2130");
  });
});

describe("isAppKeyHostBound export (TC-1977, #767) size ratchet", () => {
  const row = () => structuredClone(approvedTc1977HostBindingRatchet);
  const prerequisite = () => approvedTc2130PanelIphoneRatchet;

  it("pins the host-binding root delta over the panel safe-area row and keeps the worker ceilings unchanged", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc1977HostBindingRatchet).toEqual(approvedTc1977HostBindingRatchet);
    expect(row().root).toEqual({ delta: { "index.mjs": 55, "index.cjs": 171 }, ceiling: { "index.mjs": 1470315, "index.cjs": 1412003 } });
    expect(row().root.ceiling["index.mjs"]).toBe(prerequisite().root.ceiling["index.mjs"] + row().root.delta["index.mjs"]);
    expect(row().root.ceiling["index.cjs"]).toBe(prerequisite().root.ceiling["index.cjs"] + row().root.delta["index.cjs"]);
    expect(row().firstImport.ceiling).toEqual(prerequisite().firstImport.ceiling);
    expect(row().activation.ceiling).toEqual(prerequisite().activation.ceiling);
    expect(row().worker).toEqual({ delta: 0, ceiling: prerequisite().worker.ceiling });
    expect(row().replicaWorker).toEqual({ delta: 0, ceiling: prerequisite().replicaWorker.ceiling });
    expect(rootCeilings(current).find(({ row: name }) => name === "tc1977HostBindingRatchet")).toEqual({ row: "tc1977HostBindingRatchet", ceiling: row().root.ceiling });
    expect(ancestryPins(current, false)).toContainEqual({ row: "tc1977HostBindingRatchet", pin: row().sourceCommits[0] });
    expect(MAX_WORKER_GZIP_BYTES).toBe(row().worker.ceiling);
    expect(MAX_REPLICA_WORKER_GZIP_BYTES).toBe(row().replicaWorker.ceiling);
  });

  it("refuses changed bytes or a missing panel safe-area prerequisite", () => {
    const changedRoot = copy(current);
    changedRoot.tc1977HostBindingRatchet!.root.ceiling["index.mjs"]++;
    expect(() => validateLedger(changedRoot)).toThrow("host-binding");
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc2130PanelIphoneRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("host-binding");
  });

  it("may be introduced once and never changed or removed", () => {
    expect(() => validateTc1977HostBindingRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc1977HostBindingRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc1977HostBindingRatchetTransition(undefined, changed)).toThrow("TC-1977");
    expect(() => validateTc1977HostBindingRatchetTransition(row(), undefined)).toThrow("TC-1977");
  });
});

describe("issued delegations (TC-2132, #766) size ratchet", () => {
  const row = () => structuredClone(approvedTc2132IssuedDelegationsRatchet);
  const prerequisite = () => approvedTc1977HostBindingRatchet;

  it("pins the issued-delegations root delta over the host-binding row and keeps the worker ceilings unchanged", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc2132IssuedDelegationsRatchet).toEqual(approvedTc2132IssuedDelegationsRatchet);
    expect(row().root).toEqual({ delta: { "index.mjs": 335, "index.cjs": 489 }, ceiling: { "index.mjs": 1470650, "index.cjs": 1412492 } });
    expect(row().root.ceiling["index.mjs"]).toBe(prerequisite().root.ceiling["index.mjs"] + row().root.delta["index.mjs"]);
    expect(row().root.ceiling["index.cjs"]).toBe(prerequisite().root.ceiling["index.cjs"] + row().root.delta["index.cjs"]);
    expect(row().firstImport.ceiling).toEqual(prerequisite().firstImport.ceiling);
    expect(row().activation.ceiling).toEqual(prerequisite().activation.ceiling);
    expect(row().worker).toEqual({ delta: 0, ceiling: prerequisite().worker.ceiling });
    expect(row().replicaWorker).toEqual({ delta: 0, ceiling: prerequisite().replicaWorker.ceiling });
    expect(rootCeilings(current).find(({ row: name }) => name === "tc2132IssuedDelegationsRatchet")).toEqual({ row: "tc2132IssuedDelegationsRatchet", ceiling: row().root.ceiling });
    expect(ancestryPins(current, false)).toContainEqual({ row: "tc2132IssuedDelegationsRatchet", pin: row().sourceCommits[0] });
    expect(MAX_WORKER_GZIP_BYTES).toBe(newestKvWorkerCeiling());
    expect(MAX_REPLICA_WORKER_GZIP_BYTES).toBe(newestReplicaWorkerCeiling());
  });

  it("refuses changed bytes or a missing host-binding prerequisite", () => {
    const changedRoot = copy(current);
    changedRoot.tc2132IssuedDelegationsRatchet!.root.ceiling["index.mjs"]++;
    expect(() => validateLedger(changedRoot)).toThrow("issued-delegations");
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc1977HostBindingRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("issued-delegations");
  });

  it("may be introduced once and never changed or removed", () => {
    expect(() => validateTc2132IssuedDelegationsRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc2132IssuedDelegationsRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc2132IssuedDelegationsRatchetTransition(undefined, changed)).toThrow("TC-2132");
    expect(() => validateTc2132IssuedDelegationsRatchetTransition(row(), undefined)).toThrow("TC-2132");
  });
});

describe("exact-key delegation (TC-2140, #769) size ratchet", () => {
  const row = () => structuredClone(approvedTc2140ExactKeyDelegationRatchet);
  const prerequisite = () => approvedTc2132IssuedDelegationsRatchet;

  it("pins the exact-key root delta over the issued-delegations row and keeps the worker ceilings unchanged", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc2140ExactKeyDelegationRatchet).toEqual(approvedTc2140ExactKeyDelegationRatchet);
    expect(row().root).toEqual({ delta: { "index.mjs": 1204, "index.cjs": 142 }, ceiling: { "index.mjs": 1471854, "index.cjs": 1412634 } });
    expect(row().root.ceiling["index.mjs"]).toBe(prerequisite().root.ceiling["index.mjs"] + row().root.delta["index.mjs"]);
    expect(row().root.ceiling["index.cjs"]).toBe(prerequisite().root.ceiling["index.cjs"] + row().root.delta["index.cjs"]);
    expect(row().firstImport.ceiling).toEqual(prerequisite().firstImport.ceiling);
    expect(row().activation.ceiling).toEqual(prerequisite().activation.ceiling);
    expect(row().worker).toEqual({ delta: 0, ceiling: prerequisite().worker.ceiling });
    expect(row().replicaWorker).toEqual({ delta: 0, ceiling: prerequisite().replicaWorker.ceiling });
    expect(rootCeilings(current).find(({ row: name }) => name === "tc2140ExactKeyDelegationRatchet")).toEqual({ row: "tc2140ExactKeyDelegationRatchet", ceiling: row().root.ceiling });
    expect(ancestryPins(current, false)).toContainEqual({ row: "tc2140ExactKeyDelegationRatchet", pin: row().sourceCommits[0] });
    expect(MAX_WORKER_GZIP_BYTES).toBe(newestKvWorkerCeiling());
    expect(MAX_REPLICA_WORKER_GZIP_BYTES).toBe(newestReplicaWorkerCeiling());
  });

  it("refuses changed bytes or a missing issued-delegations prerequisite", () => {
    const changedRoot = copy(current);
    changedRoot.tc2140ExactKeyDelegationRatchet!.root.ceiling["index.mjs"]++;
    expect(() => validateLedger(changedRoot)).toThrow("exact-key");
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc2132IssuedDelegationsRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("exact-key");
  });

  it("may be introduced once and never changed or removed", () => {
    expect(() => validateTc2140ExactKeyDelegationRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc2140ExactKeyDelegationRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc2140ExactKeyDelegationRatchetTransition(undefined, changed)).toThrow("TC-2140");
    expect(() => validateTc2140ExactKeyDelegationRatchetTransition(row(), undefined)).toThrow("TC-2140");
  });
});
describe("recipient-agent share receive (TC-2202, #781) size ratchet", () => {
  const row = () => structuredClone(approvedTc2202AgentShareReceiveRatchet);
  const prerequisite = () => approvedTc2140ExactKeyDelegationRatchet;

  it("pins the exact approved root ceilings and carries every other size bucket", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc2202AgentShareReceiveRatchet).toEqual(approvedTc2202AgentShareReceiveRatchet);
    expect(row().root).toEqual({
      delta: { "index.mjs": 2929, "index.cjs": 2547 },
      ceiling: { "index.mjs": 1474783, "index.cjs": 1415181 },
    });
    expect(row().root.ceiling["index.mjs"]).toBe(prerequisite().root.ceiling["index.mjs"] + row().root.delta["index.mjs"]);
    expect(row().root.ceiling["index.cjs"]).toBe(prerequisite().root.ceiling["index.cjs"] + row().root.delta["index.cjs"]);
    expect(row().base).toBe("24ffc3398bab34662a3b3b282deb888fd8378f35");
    expect(row().sourceCommits).toEqual(["4eeed123ce9ee679c75fe879a17feb626c5d2e9a"]);
    expect(row().canonicalCI).toEqual({
      run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40639085082",
      jobs: [
        "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40639085082/job/122652758353",
        "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40639085082/job/122652758379",
      ],
    });
    expect(row().firstImport).toEqual(prerequisite().firstImport);
    expect(row().activation).toEqual(prerequisite().activation);
    expect(row().worker).toEqual({ delta: 0, ceiling: prerequisite().worker.ceiling });
    expect(row().replicaWorker).toEqual({ delta: 0, ceiling: prerequisite().replicaWorker.ceiling });
    expect(rootCeilings(current).find(({ row: name }) => name === "tc2202AgentShareReceiveRatchet")).toEqual({
      row: "tc2202AgentShareReceiveRatchet",
      ceiling: row().root.ceiling,
    });
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc2202AgentShareReceiveRatchet",
      pin: row().sourceCommits.at(-1)!,
    });
  });

  it("refuses changed bytes or a missing exact-key prerequisite", () => {
    const changedRoot = copy(current);
    changedRoot.tc2202AgentShareReceiveRatchet!.root.ceiling["index.mjs"]++;
    expect(() => validateLedger(changedRoot)).toThrow("TC-2202");
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc2140ExactKeyDelegationRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("TC-2202");
  });

  it("may be introduced once and never changed or removed", () => {
    expect(() => validateTc2202AgentShareReceiveRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc2202AgentShareReceiveRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc2202AgentShareReceiveRatchetTransition(undefined, changed)).toThrow("TC-2202");
    expect(() => validateTc2202AgentShareReceiveRatchetTransition(row(), undefined)).toThrow("TC-2202");
  });
});

describe("Home feed current-base root admission (TC-2205, #789)", () => {
  const row = () => structuredClone(approvedTc2205HomeFeedRatchet);

  it("remains present with its exact cap and preserves the historical TC-2202 limit", () => {
    validateLedger(current);
    expect(rootCeilings(current).find(({ row: name }) => name === "tc2205HomeFeedRatchet")).toEqual({
      row: "tc2205HomeFeedRatchet",
      ceiling: row().root.ceiling,
    });
    expect(rootCeilings(current).find(({ row: name }) => name === "tc2202AgentShareReceiveRatchet")).toEqual({
      row: "tc2202AgentShareReceiveRatchet",
      ceiling: { "index.mjs": 1474783, "index.cjs": 1415181 },
    });
  });

  it("rejects extra bytes, altered evidence, and changes to unrelated size buckets", () => {
    const mutations: Array<(value: Tc2205HomeFeedRatchet) => void> = [
      (value) => { value.root.ceiling["index.mjs"]++; },
      (value) => { value.root.ceiling["index.cjs"]++; },
      (value) => { value.root.delta["index.mjs"]++; },
      (value) => { value.base = "0".repeat(40); },
      (value) => { value.sourceCommits[0] = "0".repeat(40); },
      (value) => { value.canonicalCI.jobs.pop(); },
      (value) => { value.ruling += " unapproved headroom"; },
      (value) => { value.firstImport.ceiling["replica.mjs"]++; },
      (value) => { value.activation.ceiling["activation.cjs"]++; },
      (value) => { value.worker.ceiling++; },
      (value) => { value.replicaWorker.ceiling++; },
      (value) => { Object.assign(value, { unapproved: true }); },
    ];
    for (const mutate of mutations) {
      const changed = copy(current);
      const admission = row();
      mutate(admission);
      changed.tc2205HomeFeedRatchet = admission;
      expect(() => validateLedger(changed)).toThrow("TC-2205");
    }
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc2202AgentShareReceiveRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("TC-2205");
  });

  it("requires the measured source pin and rejects later removal or replacement", () => {
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc2205HomeFeedRatchet",
      pin: "f5e2851258cdfbcd38ef177913d2d9a13aaaaf82",
    });
    validateTc2205HomeFeedRatchetTransition(undefined, row());
    validateTc2205HomeFeedRatchetTransition(row(), row());
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc2205HomeFeedRatchetTransition(undefined, changed)).toThrow("TC-2205");
    expect(() => validateTc2205HomeFeedRatchetTransition(row(), undefined)).toThrow("TC-2205");
  });
});

describe("signed recipients SIWE resource insertion (TC-2230, #794) size ratchet", () => {
  const row = () => structuredClone(approvedTc2230SiweRecipientsRatchet);
  const prerequisite = () => approvedTc2205HomeFeedRatchet;

  it("pins exact canonical CI root bytes over TC-2205 and carries every other size bucket", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc2230SiweRecipientsRatchet).toEqual(approvedTc2230SiweRecipientsRatchet);
    expect(row().root).toEqual({
      delta: { "index.mjs": 270, "index.cjs": 191 },
      ceiling: { "index.mjs": 1475218, "index.cjs": 1415638 },
    });
    expect(row().root.ceiling["index.mjs"]).toBe(prerequisite().root.ceiling["index.mjs"] + row().root.delta["index.mjs"]);
    expect(row().root.ceiling["index.cjs"]).toBe(prerequisite().root.ceiling["index.cjs"] + row().root.delta["index.cjs"]);
    expect(row().base).toBe("9838d6d9bd1a096c0d7316f448f4b5cb11b01c0f");
    expect(row().sourceCommits).toEqual(["b61e4869967e4a73ad7b0b567205dffb5692df9a"]);
    expect(row().canonicalCI).toEqual({
      run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40907518282",
      jobs: [
        "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40907518282/job/123566224035",
        "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40907518282/job/123566224446",
      ],
    });
    expect(row().firstImport).toEqual(prerequisite().firstImport);
    expect(row().activation).toEqual(prerequisite().activation);
    expect(row().worker).toEqual({ delta: 0, ceiling: prerequisite().worker.ceiling });
    expect(row().replicaWorker).toEqual({ delta: 0, ceiling: prerequisite().replicaWorker.ceiling });
    expect(rootCeilings(current)).toContainEqual({
      row: "tc2230SiweRecipientsRatchet",
      ceiling: { "index.mjs": 1475218, "index.cjs": 1415638 },
    });
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc2230SiweRecipientsRatchet",
      pin: "b61e4869967e4a73ad7b0b567205dffb5692df9a",
    });
    expect(MAX_WORKER_GZIP_BYTES).toBe(newestKvWorkerCeiling());
    expect(MAX_REPLICA_WORKER_GZIP_BYTES).toBe(newestReplicaWorkerCeiling());
  });

  it("refuses changed bytes or a missing TC-2205 prerequisite", () => {
    const changed = copy(current);
    changed.tc2230SiweRecipientsRatchet!.root.ceiling["index.mjs"]++;
    expect(() => validateLedger(changed)).toThrow("TC-2230");
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc2205HomeFeedRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("TC-2230");
  });

  it("may be introduced once and never changed or removed", () => {
    expect(() => validateTc2230SiweRecipientsRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc2230SiweRecipientsRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc2230SiweRecipientsRatchetTransition(undefined, changed)).toThrow("TC-2230");
    expect(() => validateTc2230SiweRecipientsRatchetTransition(row(), undefined)).toThrow("TC-2230");
  });
});
describe("exact Share-key runtime consent (TC-2192, #796) size ratchet", () => {
  const row = () => structuredClone(approvedTc2192ExactKeyRuntimeConsentRatchet);
  const prerequisite = () => approvedTc2230SiweRecipientsRatchet;

  it("pins exact canonical CI root bytes over TC-2230 and carries every other size bucket", () => {
    expect(() => validateLedger(current)).not.toThrow();
    expect(current.tc2192ExactKeyRuntimeConsentRatchet).toEqual(approvedTc2192ExactKeyRuntimeConsentRatchet);
    expect(row().root).toEqual({
      delta: { "index.mjs": 59, "index.cjs": 1152 },
      ceiling: { "index.mjs": 1475277, "index.cjs": 1416790 },
    });
    expect(row().root.ceiling["index.mjs"]).toBe(prerequisite().root.ceiling["index.mjs"] + row().root.delta["index.mjs"]);
    expect(row().root.ceiling["index.cjs"]).toBe(prerequisite().root.ceiling["index.cjs"] + row().root.delta["index.cjs"]);
    expect(row().base).toBe("fd3d297c0688a6af14dc8606c7112d6bc900289c");
    expect(row().sourceCommits).toEqual(["9f1ef80962458e2137039bbcee3c1adefff03f44"]);
    expect(row().canonicalCI).toEqual({
      run: "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40923764869",
      jobs: [
        "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40923764869/job/123623682905",
        "https://github.com/TinyCloudLabs/js-sdk/actions/runs/40923764869/job/123623683110",
      ],
    });
    expect(row().firstImport).toEqual(prerequisite().firstImport);
    expect(row().activation).toEqual(prerequisite().activation);
    expect(row().worker).toEqual({ delta: 0, ceiling: prerequisite().worker.ceiling });
    expect(row().replicaWorker).toEqual({ delta: 0, ceiling: prerequisite().replicaWorker.ceiling });
    expect(rootCeilingFor(current, "index.mjs")).toEqual({ row: "tc2192ExactKeyRuntimeConsentRatchet", ceiling: 1475277 });
    expect(rootCeilingFor(current, "index.cjs")).toEqual({ row: "tc2192ExactKeyRuntimeConsentRatchet", ceiling: 1416790 });
    expect(ancestryPins(current, false)).toContainEqual({
      row: "tc2192ExactKeyRuntimeConsentRatchet",
      pin: "9f1ef80962458e2137039bbcee3c1adefff03f44",
    });
  });

  it("refuses changed bytes or a missing TC-2230 prerequisite", () => {
    const changed = copy(current);
    changed.tc2192ExactKeyRuntimeConsentRatchet!.root.ceiling["index.mjs"]++;
    expect(() => validateLedger(changed)).toThrow("TC-2192");
    const withoutPrerequisite = copy(current);
    delete withoutPrerequisite.tc2230SiweRecipientsRatchet;
    expect(() => validateLedger(withoutPrerequisite)).toThrow("TC-2192");
  });

  it("may be introduced once and never changed or removed", () => {
    expect(() => validateTc2192ExactKeyRuntimeConsentRatchetTransition(undefined, row())).not.toThrow();
    expect(() => validateTc2192ExactKeyRuntimeConsentRatchetTransition(row(), row())).not.toThrow();
    const changed = row();
    changed.root.ceiling["index.cjs"]++;
    expect(() => validateTc2192ExactKeyRuntimeConsentRatchetTransition(undefined, changed)).toThrow("TC-2192");
    expect(() => validateTc2192ExactKeyRuntimeConsentRatchetTransition(row(), undefined)).toThrow("TC-2192");
  });
});

describe("the newest root ceiling is the only active one", () => {
  const rowOrder = (ledger: Ledger) => rootCeilings(ledger).map(({ row }) => row);

  it("is the newest ledger root row, below the older index.mjs rows it would otherwise be shadowed by", () => {
    expect(() => validateLedger(current)).not.toThrow();
    const active = activeRootCeiling(current)!;
    expect(active).toEqual({ row: newestRootRow(), ceiling: ceilingOfRootRow(newestRootRow()) });
    const older = rootCeilings(current).slice(0, -1);
    expect(older.length).toBeGreaterThan(0);
    expect(older.some((entry) => entry.ceiling["index.mjs"] > active.ceiling["index.mjs"])).toBe(true);
  });

  it("is never beaten by an older, higher row: the newest ceiling holds and newest+1 fails", () => {
    const ledger = copy(current);
    for (const { ceiling } of rootCeilings(ledger).slice(0, -1)) {
      ceiling["index.mjs"] += 1_000_000;
      ceiling["index.cjs"] += 1_000_000;
    }
    const active = activeRootCeiling(ledger)!;
    expect(active.row).toBe(newestRootRow());
    for (const format of ["index.mjs", "index.cjs"] as const) {
      const newest = ceilingOfRootRow(newestRootRow())[format];
      expect(active.ceiling[format]).toBe(newest);
      expect(newest > active.ceiling[format]).toBe(false);
      expect(newest + 1 > active.ceiling[format]).toBe(true);
    }
  });

  it("falls back to the newest row still present, and a lone older row is its own history", () => {
    const withoutNewest = copy(current);
    delete (withoutNewest as Record<string, unknown>)[newestRootRow()];
    const previous = rootRowsInFileOrder(current).at(-2)!;
    expect(activeRootCeiling(withoutNewest)).toEqual({ row: previous, ceiling: ceilingOfRootRow(previous) });
    expect(() => validateLedger(withoutNewest)).not.toThrow();
    expect(activeRootCeiling(historical)).toEqual({ row: "fixRequiredRatchet", ceiling: approvedFixRequiredRatchet.rootCeiling });
    expect(activeRootCeiling({ allowance: current.allowance, entries: [] })).toBeUndefined();
  });

  it("fails closed when the ledger has no root row at all, instead of skipping the root gate", () => {
    const stripped = copy(current);
    for (const { row } of rootCeilings(current)) delete (stripped as Record<string, unknown>)[row];
    expect(rootCeilings(stripped)).toEqual([]);
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(rootCeilingFor({ allowance: current.allowance, entries: [] }, format)).toEqual({ error: expect.stringContaining(`${format}: no active root ceiling`) });
      expect(rootCeilingFor(stripped, format)).toEqual({ error: expect.stringContaining(`${format}: no active root ceiling`) });
    }
  });

  it("fails closed when the active row has no ceiling for a format", () => {
    const missing = copy(current);
    const newest = newestRootRow();
    delete (missing as unknown as Record<string, { root: { ceiling: Record<string, unknown> } }>)[newest]!.root.ceiling["index.cjs"];
    expect(rootCeilingFor(missing, "index.cjs")).toEqual({ error: expect.stringContaining(`index.cjs: active root row ${newest} has no ceiling`) });
    expect(rootCeilingFor(missing, "index.mjs")).toEqual({ row: newest, ceiling: ceilingOfRootRow(newest)["index.mjs"] });
  });

  it("returns the newest row's number for each format on the real ledger", () => {
    for (const format of ["index.mjs", "index.cjs"] as const) {
      expect(rootCeilingFor(current, format)).toEqual({ row: newestRootRow(), ceiling: ceilingOfRootRow(newestRootRow())[format] });
    }
  });

  it("orders rows as the ledger introduces them: prerequisite chain, ancestryPins and ledger file key order", () => {
    const order = rowOrder(current);
    const pinned = ancestryPins(current, false).map(({ row }) => row).filter((row) => order.includes(row));
    const filed = Object.keys(current).filter((key) => order.includes(key));
    expect(pinned).toEqual(order);
    expect(filed).toEqual(order);
    expect(pinned.slice(0, knownRows.length)).toEqual(knownRows);
    expect(filed.slice(0, knownRows.length)).toEqual(knownRows);
    expect(order.at(-1)).toBe(newestRootRow());
  });

  it("pairs every ledger row with its approved constant, row for row, and keeps the root row count at least the frozen prefix", () => {
    const rows = current as unknown as Record<string, unknown>;
    const ledgerRows = Object.keys(current).filter((key) => key !== "allowance" && key !== "entries");
    expect([...ledgerRows].sort()).toEqual(Object.keys(approvedLedgerRows).sort());
    for (const row of ledgerRows) expect(ceilingsOf(rows[row])).toEqual(ceilingsOf(approvedLedgerRows[row]));
    expect(rootRowsInFileOrder(current).length).toBeGreaterThanOrEqual(knownRows.length);
  });
});

describe("TC-858 squash-proof ancestry pins", () => {
  const git = (root: string, ...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const commitFile = (root: string, path: string, content: string, message: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
    git(root, "add", ".");
    git(root, "commit", "-qm", message);
    return git(root, "rev-parse", "HEAD");
  };
  const initRepo = () => {
    const root = mkdtempSync(join(tmpdir(), "tc858-squash-"));
    git(root, "init", "-q", "-b", "master");
    git(root, "config", "user.email", "policy@example.test");
    git(root, "config", "user.name", "Policy Test");
    return root;
  };
  const repoRoot = resolve(import.meta.dir, "../../..");
  const squashOf548 = "94566db5fcc8831ad9913b593b1843b201ab0227";
  const squashOf565 = "86815bd81479a5ca6578d5cbef8fd9f5a42960c9";
  // Fixed refs read the ledgers as they were at #565's squash, so a later row (which has not landed
  // there) cannot fail these tests; they need full history, which CI fetches.
  const ledgerAt = <T>(file: string) =>
    JSON.parse(git(repoRoot, "show", `${squashOf565}:packages/web-sdk/scripts/${file}`)) as T;
  const ledger565 = ledgerAt<Ledger>("replica-size-ledger.json");
  const optional = ledgerAt<OptionalLedger>("replica-optional-size-ledger.json");

  it("resolves a squash-merged row's branch pin to the master commit that landed it", () => {
    const root = initRepo();
    try {
      commitFile(root, "packages/web-sdk/src/a.ts", "export const a = 1;\n", "base");
      git(root, "switch", "-qc", "abandoned");
      const neverLanded = commitFile(root, "packages/web-sdk/src/a.ts", "export const a = 3;\n", "abandoned source");
      commitFile(root, "packages/web-sdk/scripts/ledger.json", `{"measuredAt":"${neverLanded}"}\n`, "abandoned row");
      git(root, "switch", "-q", "master");
      git(root, "switch", "-qc", "feature");
      const reviewed = commitFile(root, "packages/web-sdk/src/a.ts", "export const a = 2;\n", "reviewed source");
      commitFile(root, "packages/web-sdk/scripts/ledger.json", `{"measuredAt":"${reviewed}"}\n`, "policy row");
      git(root, "switch", "-q", "master");
      git(root, "merge", "--squash", "-q", "feature");
      git(root, "commit", "-qm", "squash merge");
      const squash = git(root, "rev-parse", "HEAD");
      commitFile(root, "packages/web-sdk/scripts/ledger.json", `{"measuredAt":"${reviewed}","next":1}\n`, "later row");

      // The introduction check still needs the literal pin, which the PR head has.
      expect(hasAncestor(root, reviewed, "feature")).toBe(true);
      // The incident: after the squash, master cannot reach the reviewed commit itself.
      expect(hasAncestor(root, reviewed, "master")).toBe(false);
      expect(landingCommit(root, reviewed, "master")).toBe(squash);
      expect(pinLandedOn(root, reviewed, "master")).toBe(true);
      expect(pinLandedOn(root, neverLanded, "master")).toBe(false);
      expect(pinLandedOn(root, neverLanded, "abandoned")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lands a pin on the earliest first-parent commit, not the branch commit or a later re-add", () => {
    const root = initRepo();
    try {
      commitFile(root, "packages/web-sdk/src/a.ts", "export const a = 1;\n", "base");
      git(root, "switch", "-qc", "feature");
      const reviewed = commitFile(root, "packages/web-sdk/src/a.ts", "export const a = 2;\n", "reviewed source");
      const branchRow = commitFile(root, "packages/web-sdk/scripts/ledger.json", `{"measuredAt":"${reviewed}"}\n`, "policy row");
      git(root, "switch", "-q", "master");
      git(root, "merge", "--no-ff", "-q", "-m", "merge feature", "feature");
      const merge = git(root, "rev-parse", "HEAD");
      commitFile(root, "packages/web-sdk/scripts/ledger.json", "{}\n", "drop row");
      commitFile(root, "packages/web-sdk/scripts/ledger.json", `{"measuredAt":"${reviewed}"}\n`, "re-add row");

      // --first-parent selects master's merge commit over the branch commit that wrote the row;
      // --reverse selects it over the later drop and re-add, which also change the pin's count.
      expect(branchRow).not.toBe(merge);
      expect(landingCommit(root, reviewed, "master")).toBe(merge);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-pins every merged #548 and #565 row to its master squash commit", () => {
    const pins = [
      ...ancestryPins(ledger565, optional.gatedOnlyRatchet !== undefined),
      ...optionalSourcePins(optional),
    ];
    expect(Object.fromEntries(pins.map(({ row, pin }) => [row, landingCommit(repoRoot, pin, squashOf565)]))).toEqual({
      phase2Ratchet: squashOf548,
      "phase2Ratchet (#553 entry)": squashOf548,
      fixRequiredRatchet: squashOf548,
      canonicalToolchainCorrection: squashOf548,
      masterMergeResolution: squashOf548,
      hardeningRatchet: squashOf565,
      gatedOnlyRatchet: squashOf548,
      fixRequired: squashOf548,
      measurementCorrection: squashOf548,
      relocations: squashOf548,
    });
  });

  it("check-phase1 refuses exactly the merged pins its base has not landed", () => {
    expect(mergedPinsNotLandedOn(repoRoot, ledger565, optional, squashOf565)).toEqual([]);
    // Just before #548 landed, only phase2's base (a master commit) is reachable.
    expect(mergedPinsNotLandedOn(repoRoot, ledger565, optional, `${squashOf548}^`).map(({ row }) => row)).toEqual([
      "phase2Ratchet (#553 entry)", "fixRequiredRatchet", "canonicalToolchainCorrection", "masterMergeResolution",
      "hardeningRatchet", "gatedOnlyRatchet", "relocations", "measurementCorrection", "fixRequired",
    ]);
  });
});
