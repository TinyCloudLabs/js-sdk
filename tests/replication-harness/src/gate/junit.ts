import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { JunitPrecondition, JunitSuiteEvidence, Subject } from "../contracts/gate";

const suiteNames = [
  "cli-acceptance-sqlite",
  "cli-acceptance-pg16",
  "node-sdk-real-node-sqlite",
  "node-sdk-real-node-pg16",
] as const;
type SuiteName = (typeof suiteNames)[number];

interface Counts { tests: number; skipped: number; failures: number; errors: number }

function classify(label: string): SuiteName | null {
  const normalized = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const cli = /(^|-)cli(-|$)/.test(normalized) && /(^|-)acceptance(-|$)/.test(normalized);
  const sdk = /(^|-)sdk(-|$)/.test(normalized) && /(^|-)real(-|$)/.test(normalized) && /(^|-)node(-|$)/.test(normalized);
  const sqlite = /(^|-)sqlite(-|$)/.test(normalized);
  const pg16 = /(^|-)pg16(-|$)/.test(normalized) || /(^|-)postgres(?:ql)?-?16(-|$)/.test(normalized);
  if (cli && sqlite) return "cli-acceptance-sqlite";
  if (cli && pg16) return "cli-acceptance-pg16";
  if (sdk && sqlite) return "node-sdk-real-node-sqlite";
  if (sdk && pg16) return "node-sdk-real-node-pg16";
  return null;
}

function attributes(openingTag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of openingTag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) result[match[1]!] = match[3]!;
  return result;
}

function integerAttribute(attrs: Record<string, string>, name: string): number | undefined {
  const value = attrs[name];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid JUnit ${name} count: ${value}`);
  return parsed;
}

function parseXml(xml: string, pathLabel: string): { name: SuiteName; counts: Counts }[] {
  const suiteTags = [...xml.matchAll(/<testsuite\b[^>]*>/gi)];
  const results: { name: SuiteName; counts: Counts }[] = [];
  if (suiteTags.length) {
    for (const [index, tag] of suiteTags.entries()) {
      const attrs = attributes(tag[0]);
      const classified = [classify(pathLabel), classify(attrs.name ?? "")].filter((name): name is SuiteName => name !== null);
      const distinct = [...new Set(classified)];
      if (distinct.length > 1) throw new Error(`ambiguous JUnit suite classification in ${pathLabel} (${attrs.name ?? "unnamed"})`);
      if (!distinct.length) continue;
      const nextStart = suiteTags[index + 1]?.index ?? xml.length;
      const section = xml.slice(tag.index!, nextStart);
      const testcases = [...section.matchAll(/<testcase\b[^>]*>/gi)];
      const bodies = testcases.map((testcase, testcaseIndex) => section.slice(testcase.index!, testcases[testcaseIndex + 1]?.index ?? section.length));
      const tests = integerAttribute(attrs, "tests") ?? testcases.length;
      const skipped = integerAttribute(attrs, "skipped") ?? bodies.filter((body) => /<skipped\b/i.test(body)).length;
      const failures = integerAttribute(attrs, "failures") ?? bodies.filter((body) => /<failure\b/i.test(body)).length;
      const errors = integerAttribute(attrs, "errors") ?? bodies.filter((body) => /<error\b/i.test(body)).length;
      results.push({ name: distinct[0]!, counts: { tests, skipped, failures, errors } });
    }
    return results;
  }

  const classified = classify(pathLabel);
  if (!classified) return results;
  const testcases = [...xml.matchAll(/<testcase\b[^>]*>/gi)];
  const body = (index: number) => xml.slice(testcases[index]!.index!, testcases[index + 1]?.index ?? xml.length);
  results.push({ name: classified, counts: {
    tests: testcases.length,
    skipped: testcases.filter((_, index) => /<skipped\b/i.test(body(index))).length,
    failures: testcases.filter((_, index) => /<failure\b/i.test(body(index))).length,
    errors: testcases.filter((_, index) => /<error\b/i.test(body(index))).length,
  } });
  return results;
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

/** Reads the two uploaded JUnit artifact trees and binds their results to the CI subject. */
export async function readJunitPrecondition(directory: string, subject: Subject): Promise<JunitPrecondition> {
  assertCiSubject(subject);
  const totals: Record<SuiteName, Counts> = {
    "cli-acceptance-sqlite": { tests: 0, skipped: 0, failures: 0, errors: 0 },
    "cli-acceptance-pg16": { tests: 0, skipped: 0, failures: 0, errors: 0 },
    "node-sdk-real-node-sqlite": { tests: 0, skipped: 0, failures: 0, errors: 0 },
    "node-sdk-real-node-pg16": { tests: 0, skipped: 0, failures: 0, errors: 0 },
  };

  for (const [artifact, backend] of [["tc858-junit-sqlite", "sqlite"], ["tc858-junit-pg16", "pg16"]] as const) {
    const artifactRoot = join(directory, artifact);
    if (!(await stat(artifactRoot).then((value) => value.isDirectory()).catch(() => false))) throw new Error(`missing JUnit artifact directory ${artifactRoot}`);
    const files = await xmlFiles(artifactRoot);
    if (!files.length) throw new Error(`JUnit artifact ${artifact} contains no XML files`);
    for (const file of files) {
      const pathLabel = `${artifact}/${relative(artifactRoot, file)}`;
      for (const result of parseXml(await readFile(file, "utf8"), pathLabel)) {
        if (!result.name.endsWith(backend)) throw new Error(`JUnit suite ${result.name} is under the wrong artifact ${artifact}`);
        const total = totals[result.name];
        total.tests += result.counts.tests;
        total.skipped += result.counts.skipped;
        total.failures += result.counts.failures;
        total.errors += result.counts.errors;
      }
    }
  }

  const minimums: Record<SuiteName, number> = {
    "cli-acceptance-sqlite": 1,
    "cli-acceptance-pg16": 1,
    "node-sdk-real-node-sqlite": 3,
    "node-sdk-real-node-pg16": 3,
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
