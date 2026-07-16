import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Command } from "commander";

import { registerTinyCloudCommands } from "../src/command-registry.js";

type CoverageStatus = "legacy" | "partially-migrated" | "migrated" | "excluded";
type CoverageEntry = {
  command: string;
  status: CoverageStatus;
  operationId?: string;
  operationVersion?: number;
  remainingLegacyInputs?: readonly string[];
  reason?: string;
};

const coveragePath = resolve(process.cwd(), "../operations/coverage.json");
const ledger = JSON.parse(await readFile(coveragePath, "utf8")) as {
  schemaVersion: number;
  source: string;
  commands: CoverageEntry[];
};

function argumentSyntax(command: Command): string {
  return command.registeredArguments
    .map((argument) => argument.required ? `<${argument.name()}>` : `[${argument.name()}]`)
    .join(" ");
}

function registrations(command: Command, parents: readonly string[] = []): string[] {
  return command.commands.flatMap((child) => {
    const path = [...parents, child.name()].join(" ");
    const syntax = argumentSyntax(child);
    return [
      `${path}${syntax === "" ? "" : ` ${syntax}`}`,
      ...registrations(child, [...parents, child.name()]),
    ];
  });
}

if (ledger.schemaVersion !== 1 || ledger.source !== "packages/cli/src/command-registry.ts") {
  throw new Error("Operations coverage ledger metadata is invalid.");
}

const program = new Command("tc");
registerTinyCloudCommands(program);
const actual = registrations(program).sort();
const listed = ledger.commands.map((entry) => entry.command).sort();
const missing = actual.filter((command) => !listed.includes(command));
const stale = listed.filter((command) => !actual.includes(command));
const duplicates = listed.filter((command, index) => index > 0 && command === listed[index - 1]);
const invalid = ledger.commands.filter((entry) => {
  if (!["legacy", "partially-migrated", "migrated", "excluded"].includes(entry.status)) return true;
  if (entry.status === "legacy" && (entry.operationId !== undefined || entry.remainingLegacyInputs !== undefined)) return true;
  if (entry.status === "excluded" && (!entry.reason || entry.operationId !== undefined)) return true;
  if (entry.status === "migrated" && (!entry.operationId || entry.operationVersion === undefined)) return true;
  if (entry.status === "partially-migrated" && (
    !entry.operationId ||
    entry.operationVersion === undefined ||
    entry.remainingLegacyInputs === undefined ||
    entry.remainingLegacyInputs.length === 0
  )) return true;
  return false;
});
const migratedSecrets = ledger.commands.find((entry) => entry.command === "secrets get <name>");
const partialAuthImport = ledger.commands.find((entry) => entry.command === "auth import [source]");
const expectedLegacyInputs = [
  "v1 delegation artifact",
  "v1 permission artifact without command",
  "bare portable delegation",
  "stored delegation wrapper",
  "cross-user delegation persisted with activated=false",
];
if (
  migratedSecrets?.status !== "migrated" ||
  migratedSecrets.operationId !== "tinycloud.secrets.get" ||
  migratedSecrets.operationVersion !== 1 ||
  partialAuthImport?.status !== "partially-migrated" ||
  partialAuthImport.operationId !== "tinycloud.auth.import" ||
  partialAuthImport.operationVersion !== 1 ||
  JSON.stringify(partialAuthImport.remainingLegacyInputs) !== JSON.stringify(expectedLegacyInputs)
) {
  throw new Error("Commander coverage ledger must preserve the reviewed secrets get/auth import migration boundary.");
}

if (missing.length || stale.length || duplicates.length || invalid.length) {
  const details = [
    missing.length ? `missing registrations: ${missing.join(", ")}` : "",
    stale.length ? `stale ledger entries: ${stale.join(", ")}` : "",
    duplicates.length ? `duplicate ledger entries: ${duplicates.join(", ")}` : "",
    invalid.length ? `invalid coverage metadata: ${invalid.map((entry) => entry.command).join(", ")}` : "",
  ].filter(Boolean).join("; ");
  throw new Error(`Commander coverage ledger check failed: ${details}`);
}

console.log(`Commander coverage ledger is complete (${actual.length} registrations).`);
