import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subject } from "../contracts/gate";
import { readJunitPrecondition } from "./junit";

const subject: Subject = {
  repo: "TinyCloudLabs/js-sdk",
  event: "pull_request",
  ref: "refs/pull/12/merge",
  sha: "merge-sha",
  prNumber: 12,
  headSha: "head-sha",
  baseSha: "base-sha",
};

function xml(name: string, tests: number, outcome = ""): string {
  const cases = Array.from({ length: tests }, (_, index) => `<testcase name="case-${index}">${index === 0 ? outcome : ""}</testcase>`).join("");
  const failures = outcome.includes("<failure") ? 1 : 0;
  return `<testsuite name="${name}" tests="${tests}" failures="${failures}" errors="0" skipped="0">${cases}</testsuite>`;
}

async function makeArtifacts(root: string, failSqliteSdk = false): Promise<void> {
  const cases = [
    ["tc858-junit-sqlite", "cli-acceptance-sqlite", "cli/acceptance.xml", 1, ""],
    ["tc858-junit-pg16", "cli-acceptance-pg16", "cli/acceptance.xml", 1, ""],
    ["tc858-junit-sqlite", "node-sdk-real-node-sqlite", "node-sdk/real-node.xml", 3, failSqliteSdk ? "<failure message=\"failed\"/>" : ""],
    ["tc858-junit-pg16", "node-sdk-real-node-pg16", "node-sdk/real-node.xml", 3, ""],
  ] as const;
  for (const [artifact, suite, path, count, outcome] of cases) {
    const file = join(root, artifact, path);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, xml(suite, count, outcome), "utf8");
  }
}

describe("readJunitPrecondition", () => {
  test("recursively reads both artifacts and binds the results to the PR", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc893-junit-"));
    try {
      await makeArtifacts(directory);
      const result = await readJunitPrecondition(directory, subject);
      expect(result).toEqual({
        schema: "tc893.junit-precondition/v1",
        minimumsVersion: 1,
        testedSha: "head-sha",
        association: { prNumber: 12, headSha: "head-sha", baseSha: "base-sha" },
        suites: [
          { name: "cli-acceptance-sqlite", present: true, exitCode: 0, skipped: 0, tests: 1 },
          { name: "cli-acceptance-pg16", present: true, exitCode: 0, skipped: 0, tests: 1 },
          { name: "node-sdk-real-node-sqlite", present: true, exitCode: 0, skipped: 0, tests: 3 },
          { name: "node-sdk-real-node-pg16", present: true, exitCode: 0, skipped: 0, tests: 3 },
        ],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports failure and rejects a missing required suite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc893-junit-"));
    try {
      await makeArtifacts(directory, true);
      const result = await readJunitPrecondition(directory, subject);
      expect(result.suites.find((suite) => suite.name === "node-sdk-real-node-sqlite")?.exitCode).toBe(1);
      await rm(join(directory, "tc858-junit-pg16", "node-sdk"), { recursive: true, force: true });
      await expect(readJunitPrecondition(directory, subject)).rejects.toThrow(/node-sdk-real-node-pg16.*missing/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("uses workflow-dispatch ref and SHA for the tested subject", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc893-junit-"));
    try {
      await makeArtifacts(directory);
      const dispatch: Subject = { repo: subject.repo, event: "workflow_dispatch", ref: "refs/heads/main", sha: "dispatch-sha" };
      const result = await readJunitPrecondition(directory, dispatch);
      expect(result.testedSha).toBe("dispatch-sha");
      expect(result.association).toEqual({ event: "workflow_dispatch", ref: "refs/heads/main", sha: "dispatch-sha" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
