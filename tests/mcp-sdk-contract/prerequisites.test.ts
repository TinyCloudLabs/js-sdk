import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

type AuditStatus = "pass" | "blocker";

export type I0SdkPrerequisiteReport = {
  capabilitySubsetHelper: { status: AuditStatus; evidence: string };
  cidValidatedDelegationBinding: { status: AuditStatus; evidence: string };
  encryptionNetworkIdRuntime: { status: AuditStatus; evidence: string };
  hermeticEncryptedNodeActivation: { status: AuditStatus; evidence: string };
};

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function namedExports(source: string, filename: string): Set<string> {
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const exports = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) exports.add(element.name.text);
  }

  return exports;
}

export async function collectI0SdkPrerequisiteReport(root = REPOSITORY_ROOT): Promise<I0SdkPrerequisiteReport> {
  const sdkCoreIndex = await readFile(join(root, "packages/sdk-core/src/index.ts"), "utf8");
  const nodeIndex = await readFile(join(root, "packages/node-sdk/src/index.ts"), "utf8");
  const nodeSource = await readFile(join(root, "packages/node-sdk/src/TinyCloudNode.ts"), "utf8");
  const nodeFixtureSetup = await readFile(join(root, "tests/node-sdk/setup.ts"), "utf8");

  const sdkCoreExports = namedExports(sdkCoreIndex, "packages/sdk-core/src/index.ts");
  const nodeExports = namedExports(nodeIndex, "packages/node-sdk/src/index.ts");
  const capabilitySubsetPublic = sdkCoreExports.has("isCapabilitySubset") && nodeExports.has("isCapabilitySubset");
  const hasValidatedCidBinding = ["bindValidatedDelegation", "bindDelegationCid", "validateDelegationCid"]
    .some((name) => nodeExports.has(name));
  const hasLocalEncryptedFixture = /localhost|127\.0\.0\.1/.test(nodeFixtureSetup) &&
    /encrypted|encryption/i.test(nodeFixtureSetup) &&
    /useRuntimeDelegation|chain validation|validateDelegation/i.test(nodeFixtureSetup);

  return {
    capabilitySubsetHelper: {
      status: capabilitySubsetPublic ? "pass" : "blocker",
      evidence: capabilitySubsetPublic
        ? "sdk-core and node-sdk public indexes export isCapabilitySubset"
        : "isCapabilitySubset is not present in both public indexes",
    },
    cidValidatedDelegationBinding: {
      status: hasValidatedCidBinding ? "pass" : "blocker",
      evidence: hasValidatedCidBinding
        ? "node-sdk public index exposes a validated delegation/CID binding helper"
        : "no public helper binds a CID to a validated PortableDelegation; computeDelegationCid only hashes authorization bytes",
    },
    encryptionNetworkIdRuntime: {
      status: nodeSource.includes("getEncryptionNetworkIdForSpace(") ? "pass" : "blocker",
      evidence: nodeSource.includes("getEncryptionNetworkIdForSpace(")
        ? "TinyCloudNode exposes getEncryptionNetworkIdForSpace"
        : "TinyCloudNode does not expose getEncryptionNetworkIdForSpace",
    },
    hermeticEncryptedNodeActivation: {
      status: hasLocalEncryptedFixture ? "pass" : "blocker",
      evidence: hasLocalEncryptedFixture
        ? "tests/node-sdk/setup.ts contains a local encrypted-node activation and chain-validation fixture"
        : "existing node-sdk fixture setup is not a hermetic encrypted-node activation/chain-validation proof",
    },
  };
}

test("reports the SDK prerequisites before I2", async () => {
  const report = await collectI0SdkPrerequisiteReport();

  expect(report.capabilitySubsetHelper.status).toBe("pass");
  expect(report.encryptionNetworkIdRuntime.status).toBe("pass");
  expect(report.cidValidatedDelegationBinding.status).toBe("blocker");
  expect(report.hermeticEncryptedNodeActivation.status).toBe("blocker");
});
