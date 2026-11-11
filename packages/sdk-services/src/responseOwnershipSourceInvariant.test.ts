import { expect, test } from "bun:test";
import ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const packages = ["sdk-services", "sdk-core", "node-sdk", "web-sdk", "replica", "share-sdk", "share-envelope", "bootstrap", "courier", "vfs", "operations", "sdk-rs"];
// TC-2840 removes this explicit list as the non-lane resource-leak follow-up lands.
const nonLaneFiles = new Set([
  "sdk-core/src/location.ts", "sdk-core/src/registry-publication.ts", "sdk-core/src/registry-policy.ts", "sdk-core/src/manifest.ts",
  "sdk-core/src/delegations/DelegationManager.ts", "sdk-core/src/delegations/issued.ts", "sdk-core/src/delegations/SharingService.ts",
  "sdk-core/src/delegations/portable.ts", "sdk-core/src/delegations/ShareRecipientClient.ts",
  "sdk-core/src/policy/credential-admission.ts", "sdk-core/src/policy/unified.ts",
  "sdk-core/src/authorization/manage-key.ts", "sdk-core/src/authorization/strategies.ts",
  "node-sdk/src/credentials/transport.ts", "node-sdk/src/credentials/email-proof.ts", "node-sdk/src/share-receive-access.ts",
  "web-sdk/src/credentials/service.ts", "web-sdk/src/share/service.ts", "web-sdk/src/openkey-session.ts",
  "share-sdk/src/recipient.ts", "share-sdk/src/receive.ts", "share-sdk/src/credential-invitation.ts", "share-sdk/src/share-root-link.ts",
  "share-sdk/src/share-network.ts", "share-sdk/src/share-control.ts", "share-sdk/src/share-grant.ts",
  "share-envelope/src/links/api.ts", "share-envelope/src/links/approval-client.ts",
  "courier/src/grant.ts", "courier/src/invite-openkey.ts",
]);
// Mixed files retain method-level, count-pinned exceptions; their lane consumers are checked.
const nonLaneFunctions: Record<string, Record<string, number>> = {
  "sdk-core/src/space.ts": { fetchPeerId: 1, submitHostDelegation: 1 },
  "sdk-core/src/TinyCloud.ts": { readPublicSpace: 1 },
  "node-sdk/src/TinyCloudNode.ts": {
    fetchForGraph: 1, fetchNodeId: 1, publishActiveNodeLocation: 1, fetchEncryptionNetworkAt: 1,
    createEncryptionService: 2, registerPolicy: 1, authorizeShareDeliveryV3: 1, createEncryptionNetwork: 1,
  },
  "web-sdk/src/modules/tcw.ts": { receiveShare: 1 },
};
// These exact forwarding sites return caller-owned Responses. Counts forbid widening them.
const callerTransfers: Record<string, Record<string, number>> = {
  "sdk-services/src/base/BaseService.ts": { invokeWithRetry: 2 },
  "sdk-services/src/kv/KVService.ts": { invokeOperation: 1 },
  "sdk-services/src/sql/SQLService.ts": { invokeSQL: 1 },
  "sdk-services/src/duckdb/DuckDbService.ts": { invokeDuckDb: 1 },
  "sdk-services/src/context.ts": { send: 1 },
  "sdk-services/src/backgroundFetch.ts": { backgroundFetch: 1 },
  "sdk-services/src/requestPriority.ts": { dispatchRequest: 1 },
  "sdk-services/src/resolvedDispatch.ts": { fetchResolved: 1 },
  "sdk-services/src/resourceRouting.ts": { createResourceRoutingFetch: 1 },
  "node-sdk/src/recordingServiceContext.ts": { invokeWithRetry: 1, recordCall: 1 },
  "node-sdk/src/TinyCloudNode.ts": { fetch: 1, createResourceTransport: 1, createAccountRegistryServices: 1 },
  "sdk-core/src/spaces/SpaceService.ts": { createSpaceScopedDelegations: 1 },
};
// These named callbacks return decoded Result/RequesterHttpResponse values, not FetchResponse.
const decodedCallbacks: Record<string, Record<string, number>> = {
  "sdk-core/src/requester/index.ts": { readSql: 1, readKv: 1 },
  "web-sdk/src/ui/data/real.ts": { createRealPanelData: 1 },
};
const fetchNames = new Set(["fetch", "fetchFn", "fetchImpl", "fetchFunction", "rawFetch", "sessionSigningFetch", "fetchResolved"]);
function scope(node: ts.Node): string {
  let name = "<module>";
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isMethodDeclaration(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent) || ts.isFunctionDeclaration(parent)) {
      name = parent.name?.getText() ?? name;
    } else if (name === "<module>" && ts.isArrowFunction(parent) && (ts.isVariableDeclaration(parent.parent) || ts.isPropertyDeclaration(parent.parent))) {
      name = parent.parent.name.getText();
    }
  }
  return name;
}
function acquisitionScope(node: ts.Node): ts.CallExpression | undefined {
  for (let part = node; part.parent; part = part.parent) {
    const parent = part.parent;
    if (ts.isCallExpression(parent) && parent.expression.getText() === "usingResponse" && parent.arguments[0] === part) return parent;
  }
  return undefined;
}
function calls(source: ts.SourceFile, includeScoped = false) {
  const aliases = new Set(fetchNames);
  function isFetchReference(node: ts.Node): boolean {
    if (ts.isIdentifier(node)) return aliases.has(node.text);
    if (ts.isPropertyAccessExpression(node)) return aliases.has(node.name.text);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return isFetchReference(node.expression);
    if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      return isFetchReference(node.left) || isFetchReference(node.right);
    }
    if (ts.isConditionalExpression(node)) return isFetchReference(node.whenTrue) || isFetchReference(node.whenFalse);
    return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "bind" && isFetchReference(node.expression.expression);
  }
  function alias(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isFetchReference(node.initializer)) aliases.add(node.name.text);
    ts.forEachChild(node, alias);
  }
  alias(source);
  const found: Array<{ node: ts.CallExpression; owner: string }> = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const name = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : "";
      const curried = ts.isCallExpression(expression) && /fetchForGraph|backgroundFetch/.test(expression.expression.getText());
      const acquire = ts.isIdentifier(expression) && aliases.has(name) || curried ||
        ts.isPropertyAccessExpression(expression) && (aliases.has(name) || ["invokeWithRetry", "invokeOperation", "invokeSQL", "invokeDuckDb", "nativeInvoke"].includes(name) ||
          name === "clone" && /response|reply|\bres\b/i.test(expression.expression.getText()));
      if (acquire && (includeScoped || !acquisitionScope(node))) found.push({ node, owner: scope(node) });
    }
    ts.forEachChild(node, visit);
  }
  visit(source); return found;
}
function scopeViolations(source: ts.SourceFile): string[] {
  const counts = new Map<ts.CallExpression, number>();
  for (const { node } of calls(source, true)) {
    const owner = acquisitionScope(node);
    if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([owner, count]) =>
    `${scope(owner)}: one scope acquires ${count} responses; each response needs its own scope`);
}
function unscoped(file: string, code: string) {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  return [...calls(source).map(({ node, owner }) => `${owner}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}:${node.expression.getText()}`), ...scopeViolations(source)];
}

test("every lane response acquisition uses the single ownership scope", () => {
  const ignored = new Set(["node_modules", "dist", "target", "build", ".git", ".turbo"]);
  function sources(directory: string): string[] {
    return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return ignored.has(entry.name) ? [] : sources(path);
      return entry.isFile() && path.endsWith(".ts") ? [path] : [];
    });
  }
  const files = packages.flatMap((name) => sources(`packages/${name}`))
    .filter((file) => /\/src\//.test(file) && !/(\.test\.|\.spec\.|\.d\.ts$|\/test-support\/|\/fixtures\/|\/tests\/|\/e2e\/)/.test(file));
  const failures: string[] = [];
  for (const path of files) {
    const file = path.slice("packages/".length);
    if (nonLaneFiles.has(file)) continue;
    const code = readFileSync(resolve(root, path), "utf8");
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
    failures.push(...scopeViolations(source).map((message) => `${file}#${message}`));
    const grouped = new Map<string, string[]>();
    for (const { node, owner } of calls(source)) {
      const entries = grouped.get(owner) ?? [];
      entries.push(`${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}:${node.expression.getText()}`);
      grouped.set(owner, entries);
    }
    for (const [owner, entries] of grouped) {
      const expected = nonLaneFunctions[file]?.[owner] ?? callerTransfers[file]?.[owner] ?? decodedCallbacks[file]?.[owner];
      if (expected !== entries.length) failures.push(`${file}#${owner}: ${entries.join(", ")} (expected explicit transfers/non-lane calls: ${expected ?? 0})`);
    }
    function adoption(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText() === "usingResponse") {
        const consume = node.arguments[1];
        if (consume && (ts.isArrowFunction(consume) || ts.isFunctionExpression(consume)) && consume.parameters.length > 1 &&
            !(file === "sdk-services/src/requestPriority.ts" && scope(node) === "sendResponse")) {
          failures.push(`${file}#${scope(node)}: body adoption is reserved for the priority stream wrapper`);
        }
      }
      ts.forEachChild(node, adoption);
    }
    adoption(source);
  }
  expect(failures).toEqual([]);
});

test("the invariant rejects a deliberately added unowned service fetch", () => {
  expect(unscoped("sdk-services/src/kv/KVService.ts", "class KVService { async get() { const response = await this.context.fetch('/invoke'); return response.status; } }")).toHaveLength(1);
  expect(unscoped("service.ts", "async function read() { return usingResponse(() => fetch('/invoke'), async response => response.json()); }")).toEqual([]);
  // An enclosing response scope cannot accidentally protect a second acquisition.
  expect(unscoped("service.ts", "async function read() { return usingResponse(() => fetch('/first'), async first => { const second = await fetch('/second'); return second.status; }); }")).toHaveLength(1);
  expect(unscoped("service.ts", "async function read() { return usingResponse(async () => { await fetch('/first'); return fetch('/second'); }, r => r.json()); }")).toHaveLength(1);
  // Installing the helper after the response has raced an abort is too late.
  expect(unscoped("service.ts", "async function read() { const response = await awaitOwned(signal, () => fetch('/late')); return usingResponse(() => Promise.resolve(response), r => r.json()); }")).toHaveLength(1);
});

test("non-lane exceptions have an explicit tracked retirement issue", () => {
  expect(nonLaneFiles.size).toBe(30);
  expect("TC-2840").toMatch(/^TC-\d+$/);
  expect(nonLaneFiles.has("sdk-services/src/hooks/HooksService.ts")).toBe(false);
  expect(nonLaneFiles.has("node-sdk/src/TinyCloudNode.ts")).toBe(false);
});
