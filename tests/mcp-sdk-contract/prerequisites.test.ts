import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import ts from "typescript";

type AuditStatus = "pass" | "blocker";

export type I0SdkPrerequisiteReport = {
  capabilitySubsetHelper: { status: AuditStatus; evidence: string };
  cidValidatedDelegationBinding: { status: AuditStatus; evidence: string };
  encryptionNetworkIdRuntime: { status: AuditStatus; evidence: string };
  hermeticEncryptedNodeActivation: { status: AuditStatus; evidence: string };
};

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function publicImportDiagnostics(root: string): string[] {
  const contractFilename = join(root, "tests/mcp-sdk-contract/.i0-public-import-contract.ts");
  const source = `
    import { isCapabilitySubset as coreCapabilitySubset } from "../../packages/sdk-core/src/index";
    import { activateValidatedRuntimeDelegation, isCapabilitySubset as nodeCapabilitySubset, TinyCloudNode } from "../../packages/node-sdk/src/index";

    declare const node: TinyCloudNode;
    void coreCapabilitySubset;
    void nodeCapabilitySubset;
    void activateValidatedRuntimeDelegation;
    node.getEncryptionNetworkIdForSpace("tinycloud:did:key:i0-contract:space");
  `;
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: ["node"],
  };
  const host = ts.createCompilerHost(options, true);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);

  host.fileExists = (filename) => filename === contractFilename || originalFileExists(filename);
  host.readFile = (filename) => filename === contractFilename ? source : originalReadFile(filename);
  host.getSourceFile = (filename, languageVersion, onError, shouldCreateNewSourceFile) =>
    filename === contractFilename
      ? ts.createSourceFile(filename, source, languageVersion, true)
      : originalGetSourceFile(filename, languageVersion, onError, shouldCreateNewSourceFile);

  const program = ts.createProgram([contractFilename], options, host);
  return ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === contractFilename)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

export function collectI0SdkPrerequisiteReport(root = REPOSITORY_ROOT): I0SdkPrerequisiteReport {
  const importDiagnostics = publicImportDiagnostics(root);
  const publicImportsCompile = importDiagnostics.length === 0;

  return {
    capabilitySubsetHelper: {
      status: publicImportsCompile ? "pass" : "blocker",
      evidence: publicImportsCompile
        ? "TypeScript compiles imports of isCapabilitySubset through both source public indexes"
        : `public import contract failed to compile: ${importDiagnostics.join("; ")}`,
    },
    cidValidatedDelegationBinding: {
      status: publicImportsCompile ? "pass" : "blocker",
      evidence: publicImportsCompile
        ? "The public import contract compiles activateValidatedRuntimeDelegation through the node-sdk source public index"
        : "The validated runtime delegation helper is unavailable through the checked public import contract",
    },
    encryptionNetworkIdRuntime: {
      status: publicImportsCompile ? "pass" : "blocker",
      evidence: publicImportsCompile
        ? "The public import contract type-checks TinyCloudNode.getEncryptionNetworkIdForSpace through the node-sdk source public index"
        : "TinyCloudNode.getEncryptionNetworkIdForSpace is unavailable through the checked public import contract",
    },
    hermeticEncryptedNodeActivation: {
      status: existsSync(join(root, "packages/node-sdk/src/test-support/hermetic-encrypted-node.ts"))
        ? "pass"
        : "blocker",
      evidence: existsSync(join(root, "packages/node-sdk/src/test-support/hermetic-encrypted-node.ts"))
        ? "The reviewed hermetic encrypted-node fixture is present for real delegation activation and chain-validation tests"
        : "The reviewed hermetic encrypted-node fixture is unavailable",
    },
  };
}

test("records executable public SDK evidence and closed I2 prerequisites", () => {
  const report = collectI0SdkPrerequisiteReport();

  expect(report.capabilitySubsetHelper.status).toBe("pass");
  expect(report.encryptionNetworkIdRuntime.status).toBe("pass");
  expect(report.cidValidatedDelegationBinding.status).toBe("pass");
  expect(report.hermeticEncryptedNodeActivation.status).toBe("pass");
});

test("executes the built public SDK exports used by operations", async () => {
  const [coreSdk, nodeSdk] = await Promise.all([
    import("@tinycloud/sdk-core"),
    import("@tinycloud/node-sdk"),
  ]);

  expect(coreSdk.isCapabilitySubset([], [])).toEqual({ subset: true, missing: [] });
  expect(nodeSdk.isCapabilitySubset([], [])).toEqual({ subset: true, missing: [] });
  expect(typeof nodeSdk.activateValidatedRuntimeDelegation).toBe("function");

  const prototype = nodeSdk.TinyCloudNode.prototype as unknown as {
    ownerDidFromSpaceId(spaceId: string): string | undefined;
    getEncryptionNetworkIdForSpace(spaceId: string, name?: string): string;
  };
  const runtime = {
    did: "did:key:z6MkFallback",
    ownerDidFromSpaceId: prototype.ownerDidFromSpaceId,
  };
  expect(prototype.getEncryptionNetworkIdForSpace.call(
    runtime,
    "tinycloud:did:key:z6MkOwner:secrets",
  )).toBe("urn:tinycloud:encryption:did:key:z6MkOwner:default");
});
