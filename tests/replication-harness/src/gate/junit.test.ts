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

function cases(tests: number, outcome = ""): string {
  return Array.from({ length: tests }, (_, index) => `<testcase name="case-${index}">${index === 0 ? outcome : ""}</testcase>`).join("");
}

function xml(name: string, tests: number, outcome = ""): string {
  return `<testsuite name="${name}" tests="${tests}">${cases(tests, outcome)}</testsuite>`;
}

async function writeArtifact(root: string, artifact: string, fileName: string, contents: string): Promise<void> {
  const file = join(root, artifact, fileName);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, contents, "utf8");
}

async function makeArtifacts(root: string, failSqliteSdk = false, nestedSdkSuites = false): Promise<void> {
  for (const [backend, artifact] of [["sqlite", "tc858-junit-sqlite"], ["pg16", "tc858-junit-pg16"]] as const) {
    await writeArtifact(root, artifact, "cli-flag.xml", xml(`cli-${backend}`, 1));
    await writeArtifact(root, artifact, "cli-replica-e2e.xml", xml(`replica-${backend}`, 1));
    const sdkCases = cases(10, failSqliteSdk && backend === "sqlite" ? "<failure message=\"failed\"/>" : "");
    const sdkXml = nestedSdkSuites
      ? `<testsuites tests="20"><testsuite name="outer" tests="20"><testsuite name="inner" tests="10">${sdkCases}</testsuite></testsuite></testsuites>`
      : xml(`sdk-${backend}`, 10, failSqliteSdk && backend === "sqlite" ? "<failure message=\"failed\"/>" : "");
    await writeArtifact(root, artifact, "node-sdk.xml", sdkXml);
  }
}

describe("readJunitPrecondition", () => {
  test("maps the producer filenames for both backends and counts nested testcases once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc893-junit-"));
    try {
      await makeArtifacts(directory, false, true);
      const result = await readJunitPrecondition(directory, subject);
      expect(result).toEqual({
        schema: "tc893.junit-precondition/v1",
        minimumsVersion: 1,
        testedSha: "head-sha",
        association: { prNumber: 12, headSha: "head-sha", baseSha: "base-sha" },
        suites: [
          { name: "cli-acceptance-sqlite", present: true, exitCode: 0, skipped: 0, tests: 1 },
          { name: "cli-acceptance-pg16", present: true, exitCode: 0, skipped: 0, tests: 1 },
          { name: "cli-replica-sqlite", present: true, exitCode: 0, skipped: 0, tests: 1 },
          { name: "cli-replica-pg16", present: true, exitCode: 0, skipped: 0, tests: 1 },
          { name: "node-sdk-real-node-sqlite", present: true, exitCode: 0, skipped: 0, tests: 10 },
          { name: "node-sdk-real-node-pg16", present: true, exitCode: 0, skipped: 0, tests: 10 },
        ],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports a failed suite and rejects a missing PG16 node-sdk.xml", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tc893-junit-"));
    try {
      await makeArtifacts(directory, true);
      const result = await readJunitPrecondition(directory, subject);
      expect(result.suites.find((suite) => suite.name === "node-sdk-real-node-sqlite")?.exitCode).toBe(1);
      await rm(join(directory, "tc858-junit-pg16", "node-sdk.xml"));
      await expect(readJunitPrecondition(directory, subject)).rejects.toThrow(/node-sdk-real-node-pg16.*missing or has fewer than 10 tests \(found 0\)/);
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
