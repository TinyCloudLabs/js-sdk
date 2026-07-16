import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type CoverageEntry = {
  command: string;
  status: "legacy" | "partially-migrated" | "migrated" | "excluded";
  operationId?: string;
  operationVersion?: number;
  remainingLegacyInputs?: readonly string[];
  reason?: string;
};

const packageDirectory = resolve(process.cwd());
const coveragePath = resolve(packageDirectory, "../operations/coverage.json");
const referencePath = resolve(packageDirectory, "skills/tc-cli/REFERENCE.md");
const coverage = JSON.parse(await readFile(coveragePath, "utf8")) as { commands: CoverageEntry[] };
const counts = new Map<string, number>();
for (const entry of coverage.commands) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
const generatedBlock = [
  "<!-- BEGIN GENERATED TINYCloud operations coverage -->",
  "This release has **Commander coverage tracked, not complete parity**:",
  "",
  `- ${counts.get("migrated") ?? 0} migrated registration(s).`,
  `- ${counts.get("partially-migrated") ?? 0} partially migrated registration(s).`,
  `- ${counts.get("legacy") ?? 0} legacy registration(s) remain Commander-owned.`,
  "",
  ...coverage.commands
    .filter((entry) => entry.status === "migrated" || entry.status === "partially-migrated")
    .map((entry) => {
      const operation = `${entry.operationId}@${entry.operationVersion}`;
      if (entry.status === "migrated") return `- \`${entry.command}\` → \`${operation}\` (migrated).`;
      return `- \`${entry.command}\` → \`${operation}\` (partial; legacy inputs: ${entry.remainingLegacyInputs!.join(", ")}).`;
    }),
  "<!-- END GENERATED TINYCloud operations coverage -->",
].join("\n");

const existing = await readFile(referencePath, "utf8");
const marker = /<!-- BEGIN GENERATED TINYCloud operations coverage -->[\s\S]*?<!-- END GENERATED TINYCloud operations coverage -->/;
if (!marker.test(existing)) throw new Error("CLI reference is missing generated coverage markers.");
const generated = `${existing.replace(marker, generatedBlock).trimEnd()}\n`;

if (process.argv.includes("--check")) {
  if (existing !== generated) {
    console.error("Generated CLI reference coverage is out of date. Run bun run generate.");
    process.exitCode = 1;
  }
} else {
  await writeFile(referencePath, generated, "utf8");
}
