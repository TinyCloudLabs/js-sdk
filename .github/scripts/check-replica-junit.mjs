import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.env.RUNNER_TEMP ?? process.cwd();
const includeCliReplicaCommand = process.argv.includes("--cli-replica-command");
const suites = [
  { name: "node-sdk real-node", file: "node-sdk.xml", min: 10 },
  { name: "CLI replication flag real-node", file: "cli-flag.xml", min: 1 },
  { name: "CLI replica real-node", file: "cli-replica-e2e.xml", min: 4 },
  ...(includeCliReplicaCommand ? [{ name: "CLI replica command", file: "cli-replica-command.xml", min: 11 }] : []),
];
let failed = false;
for (const suite of suites) {
  const path = resolve(root, "replica-junit", suite.file);
  let xml;
  try {
    xml = await readFile(path, "utf8");
  } catch (error) {
    console.error(`${suite.name}: missing JUnit report ${path}: ${error.message}`);
    failed = true;
    continue;
  }
  const cases = [...xml.matchAll(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g)].map(([testcase]) => testcase);
  const skipped = cases.filter((testcase) => /<skipped\b/.test(testcase)).length;
  const failures = cases.filter((testcase) => /<(?:failure|error)\b/.test(testcase)).length;
  console.log(`${suite.name}: tests=${cases.length} failures=${failures} skipped=${skipped} minimum=${suite.min}`);
  if (cases.length < suite.min) {
    console.error(`${suite.name}: ran ${cases.length} tests; expected at least ${suite.min}`);
    failed = true;
  }
  if (failures !== 0) {
    console.error(`${suite.name}: ${failures} test(s) failed`);
    failed = true;
  }
  if (skipped !== 0) {
    console.error(`${suite.name}: ${skipped} test(s) skipped; real-node coverage must not silently skip`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
