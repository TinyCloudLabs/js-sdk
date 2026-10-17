import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MAX_WORKER_GZIP_BYTES } from "../../replica/scripts/check-worker-size";
import { compactFixOptionalAllowance } from "./replica-optional-size-policy";
import { assertCiSizeToolchain, approvedCiToolchainCorrection, approvedFixRequiredRatchet, approvedGatedOnlyRatchet, approvedHardeningRatchet, ciCorrectionPolicyOnlyPaths, isPolicyOnlySinceApprovedSource, validateCiToolchainTransition, validateGatedOnlyRatchet, validateHardeningRatchetTransition, validateLedger, validateMasterMergeResolutionTransition, type HardeningRatchet, type Ledger, type MasterMergeResolution } from "./replica-size-policy";

const current = JSON.parse(readFileSync(resolve(import.meta.dir, "replica-size-ledger.json"), "utf8")) as Ledger;
const historical: Ledger = {
  ...current,
  canonicalToolchainCorrection: undefined,
  masterMergeResolution: undefined,
  hardeningRatchet: undefined,
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
    expect(current.entries.map(({ pr }) => pr)).toEqual(["#511", "#529", "#546", "#551", "#563", "#564", "#553", "#565"]);
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
    expect(MAX_WORKER_GZIP_BYTES).toBe(approvedHardeningRatchet.worker.ceiling);
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
