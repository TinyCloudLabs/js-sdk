import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { JunitPrecondition, JunitSuiteEvidence, Subject } from "../contracts/gate";

const suiteNames = [
  "cli-acceptance-sqlite",
  "cli-acceptance-pg16",
  "cli-replica-sqlite",
  "cli-replica-pg16",
  "node-sdk-real-node-sqlite",
  "node-sdk-real-node-pg16",
] as const;
type SuiteName = (typeof suiteNames)[number];
type Backend = "sqlite" | "pg16";
interface Counts { tests: number; skipped: number; failures: number; errors: number }

function suiteForFile(name: string, backend: Backend): SuiteName | null {
  switch (name.toLowerCase()) {
    case "cli-flag.xml": return `cli-acceptance-${backend}`;
    case "cli-replica-e2e.xml": return `cli-replica-${backend}`;
    case "node-sdk.xml": return `node-sdk-real-node-${backend}`;
    default: return null;
  }
}

/** Count testcase nodes once; testsuite-level aggregate attributes duplicate nested counts. */
function parseXml(xml: string): Counts {
  const testcases = [...xml.matchAll(/<testcase\b[^>]*>/gi)];
  const bodies = testcases.map((testcase, index) => xml.slice(testcase.index! + testcase[0].length, testcases[index + 1]?.index ?? xml.length));
  return {
    tests: testcases.length,
    skipped: bodies.filter((body) => /<skipped\b/i.test(body)).length,
    failures: bodies.filter((body) => /<failure\b/i.test(body)).length,
    errors: bodies.filter((body) => /<error\b/i.test(body)).length,
  };
}

async function xmlFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await xmlFiles(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".xml")) files.push(path);
  }
  return files;
}

function assertCiSubject(subject: Subject): asserts subject is Subject & ({ event: "pull_request"; prNumber: number; headSha: string; baseSha: string } | { event: "workflow_dispatch" }) {
  if (subject.event === "pull_request") {
    if (!Number.isInteger(subject.prNumber) || !subject.headSha || !subject.baseSha) throw new Error("pull_request subject is missing PR association metadata");
    return;
  }
  if (subject.event === "workflow_dispatch") return;
  throw new Error("JUnit precondition requires a pull_request or workflow_dispatch subject");
}

/** Reads the two uploaded producer artifact trees and binds their results to the CI subject. */
export async function readJunitPrecondition(directory: string, subject: Subject): Promise<JunitPrecondition> {
  assertCiSubject(subject);
  const totals: Record<SuiteName, Counts> = {
    "cli-acceptance-sqlite": { tests: 0, skipped: 0, failures: 0, errors: 0 },
    "cli-acceptance-pg16": { tests: 0, skipped: 0, failures: 0, errors: 0 },
    "cli-replica-sqlite": { tests: 0, skipped: 0, failures: 0, errors: 0 },
    "cli-replica-pg16": { tests: 0, skipped: 0, failures: 0, errors: 0 },
    "node-sdk-real-node-sqlite": { tests: 0, skipped: 0, failures: 0, errors: 0 },
    "node-sdk-real-node-pg16": { tests: 0, skipped: 0, failures: 0, errors: 0 },
  };

  for (const [artifact, backend] of [["tc858-junit-sqlite", "sqlite"], ["tc858-junit-pg16", "pg16"]] as const) {
    const artifactRoot = join(directory, artifact);
    if (!(await stat(artifactRoot).then((value) => value.isDirectory()).catch(() => false))) throw new Error(`missing JUnit artifact directory ${artifactRoot}`);
    const files = await xmlFiles(artifactRoot);
    if (!files.length) throw new Error(`JUnit artifact ${artifact} contains no XML files`);
    for (const file of files) {
      const name = suiteForFile(basename(file), backend);
      if (!name) continue;
      const counts = parseXml(await readFile(file, "utf8"));
      const total = totals[name];
      total.tests += counts.tests;
      total.skipped += counts.skipped;
      total.failures += counts.failures;
      total.errors += counts.errors;
    }
  }

  const minimums: Record<SuiteName, number> = {
    "cli-acceptance-sqlite": 1,
    "cli-acceptance-pg16": 1,
    "cli-replica-sqlite": 1,
    "cli-replica-pg16": 1,
    "node-sdk-real-node-sqlite": 10,
    "node-sdk-real-node-pg16": 10,
  };
  const suites: JunitSuiteEvidence[] = suiteNames.map((name) => {
    const counts = totals[name];
    if (counts.tests < minimums[name]) throw new Error(`JUnit suite ${name} is missing or has fewer than ${minimums[name]} tests (found ${counts.tests})`);
    return { name, present: true, exitCode: counts.failures === 0 && counts.errors === 0 ? 0 : 1, skipped: counts.skipped, tests: counts.tests };
  });

  const association = subject.event === "pull_request"
    ? { prNumber: subject.prNumber, headSha: subject.headSha, baseSha: subject.baseSha }
    : { event: "workflow_dispatch" as const, ref: subject.ref, sha: subject.sha };
  return {
    schema: "tc893.junit-precondition/v1",
    minimumsVersion: 1,
    testedSha: subject.event === "pull_request" ? subject.headSha : subject.sha,
    association,
    suites,
  };
}
