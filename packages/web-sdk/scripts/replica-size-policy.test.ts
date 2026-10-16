import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertCiSizeToolchain, approvedFixRequiredRatchet, approvedGatedOnlyRatchet, isPolicyOnlySinceApprovedSource, validateCiToolchainTransition, validateGatedOnlyRatchet, validateLedger, type Ledger } from "./replica-size-policy";

const current = JSON.parse(readFileSync(resolve(import.meta.dir, "replica-size-ledger.json"), "utf8")) as Ledger;
const historical: Ledger = {
  ...current,
  canonicalToolchainCorrection: undefined,
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
    ciRun: "38958197518",
    ciJob: "117166290134",
    toolchain: { bun: "1.3.14", rustc: "1.99.0" },
    historical: {
      master: { "index.mjs": 1460603, "index.cjs": 1390460 },
      approvedDelta: { "index.mjs": 1431, "index.cjs": 1339 },
      rootCeiling: { "index.mjs": 1462034, "index.cjs": 1391799 },
      firstImportCeiling: { "replica.mjs": 51785, "replica.cjs": 66995 },
      activation: { "activation.mjs": 23071, "activation.cjs": 24650 },
    },
    measured: {
      master: { "index.mjs": 1462685, "index.cjs": 1393687 },
      delta: { "index.mjs": 1504, "index.cjs": 1348 },
      rootCeiling: { "index.mjs": 1464189, "index.cjs": 1395035 },
      firstImportCeiling: { "replica.mjs": 51786, "replica.cjs": 66995 },
      activationCeiling: { "activation.mjs": 23073, "activation.cjs": 24653 },
    },
    reason: "The approved shipped source is unchanged from ddc032ca; CI rustc 1.99.0 and Bun 1.3.14 rebuild master and candidate with the same WASM. The old values remain in the historical rows; measured candidate ceilings add no headroom.",
  };

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
});
