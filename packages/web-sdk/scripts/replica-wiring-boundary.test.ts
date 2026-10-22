import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { replicaOwnedPath } from "./replica-owned-path";

/*
 * The replica size boundary is a FILE boundary: all replication wiring in the web-sdk root bundle
 * lives in src/modules/replica-wiring.ts (replica-owned, charged to the replica allowance).
 * tcw.ts and index.ts are not replica-owned, so no replication code may live in them. The check
 * parses the real files with the TypeScript compiler; it never matches text in a diff.
 */
const REPLICA_NAME = /replica|replication/i;
const FORBIDDEN_NAMES = ["registerNodeReplicationLoaders", "registeredBrowserReplica"];

type Kind = "tcw" | "index";
type Rule = {
  /** The only module either file may import or re-export replica names from. */
  wiring: string;
  /** Replica-named identifiers allowed in the file, and where. */
  allowed: Record<string, "property" | "wiring-import-or-call" | "wiring-reexport">;
};
const RULES: Record<Kind, Rule> = {
  tcw: {
    wiring: "./replica-wiring",
    allowed: {
      // The public `replication` Config field, the `replication` getter, and the node config field.
      replication: "property",
      // Thin calls into the wiring module.
      validateReplicationConfig: "wiring-import-or-call",
      resolveReplicationConfig: "wiring-import-or-call",
    },
  },
  index: {
    wiring: "./modules/replica-wiring",
    allowed: {
      registerBrowserReplica: "wiring-reexport",
      BrowserReplicaPlugin: "wiring-reexport",
      __replicaActionContains: "wiring-reexport",
      __replicaKV: "wiring-reexport",
      __replicaCanonicalizeRecapCaveats: "wiring-reexport",
      __replicaIsCapabilitySubset: "wiring-reexport",
      __replicaParsePkhDid: "wiring-reexport",
      __replicaParseSpaceUri: "wiring-reexport",
      __replicaPkhDid: "wiring-reexport",
      __replicaPrincipalDid: "wiring-reexport",
      __replicaSiweMessage: "wiring-reexport",
    },
  },
};

function moduleOf(decl: ts.Node | undefined): string | undefined {
  if (!decl) return undefined;
  const specifier = ts.isImportDeclaration(decl) || ts.isExportDeclaration(decl) ? decl.moduleSpecifier : undefined;
  return specifier && ts.isStringLiteral(specifier) ? specifier.text : undefined;
}

function allowedUse(id: ts.Identifier, rule: Rule): boolean {
  const use = Object.hasOwn(rule.allowed, id.text) ? rule.allowed[id.text] : undefined;
  const parent = id.parent;
  switch (use) {
    case "property":
      return (
        ((ts.isPropertySignature(parent) || ts.isGetAccessorDeclaration(parent) || ts.isPropertyAssignment(parent) ||
          ts.isPropertyAccessExpression(parent)) && parent.name === id)
      );
    case "wiring-import-or-call":
      return (ts.isImportSpecifier(parent) && moduleOf(parent.parent.parent.parent) === rule.wiring) ||
        (ts.isCallExpression(parent) && parent.expression === id);
    case "wiring-reexport":
      return ts.isExportSpecifier(parent) && moduleOf(parent.parent.parent) === rule.wiring;
    default:
      return false;
  }
}

/** Every way `source` (parsed as the given file) breaks the boundary; empty means it holds. */
export function replicaWiringViolations(kind: Kind, source: string): string[] {
  const rule = RULES[kind];
  const file = ts.createSourceFile(`${kind}.ts`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: string[] = [];
  const report = (node: ts.Node, why: string) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    violations.push(`${kind}.ts:${line + 1}: ${why}`);
  };
  const visit = (node: ts.Node): void => {
    // (a) Replica imports come from the wiring module only.
    const from = moduleOf(node);
    if (from !== undefined && from !== rule.wiring) {
      const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
      const bound: string[] = [];
      if (clause?.name) bound.push(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) bound.push(clause.namedBindings.name.text);
        else for (const el of clause.namedBindings.elements) bound.push(el.name.text, el.propertyName?.text ?? "");
      }
      if (REPLICA_NAME.test(from) || bound.some((name) => REPLICA_NAME.test(name))) {
        report(node, `replica import from "${from}"; only ${rule.wiring} may supply replica names`);
      }
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression;
      const loads = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
      const target = node.arguments[0];
      if (loads && ts.isStringLiteralLike(target) && REPLICA_NAME.test(target.text) && target.text !== rule.wiring) {
        report(node, `replica module loaded from "${target.text}"`);
      }
    }
    // (c) The wiring's private state and the Node loader registration never appear here.
    const literal = ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
    if (literal !== undefined && FORBIDDEN_NAMES.some((name) => literal.includes(name))) {
      report(node, `"${literal}" belongs to replica-wiring`);
    }
    // (b) Replica-named identifiers outside the explicit allow-list.
    if (ts.isIdentifier(node) && REPLICA_NAME.test(node.text) && !allowedUse(node, rule)) {
      report(node, `replica identifier "${node.text}" is not allow-listed in this position`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}

const read = (path: string) => readFileSync(resolve(import.meta.dir, path), "utf8");

describe("replica wiring is a file boundary", () => {
  it("keeps replica code out of tcw.ts", () => {
    expect(replicaWiringViolations("tcw", read("../src/modules/tcw.ts"))).toEqual([]);
  });

  it("keeps replica code out of index.ts", () => {
    expect(replicaWiringViolations("index", read("../src/index.ts"))).toEqual([]);
  });

  it("charges only the wiring module to the replica allowance", () => {
    expect(replicaOwnedPath("packages/web-sdk/src/modules/replica-wiring.ts")).toBe(true);
    expect(replicaOwnedPath("packages/web-sdk/src/modules/tcw.ts")).toBe(false);
    expect(replicaOwnedPath("packages/web-sdk/src/index.ts")).toBe(false);
    expect(replicaOwnedPath("packages/web-sdk/src/replica.ts")).toBe(true);
    expect(replicaOwnedPath("packages/web-sdk/src/modules/replica-wiring.test.ts")).toBe(false);
  });

  describe("tcw.ts", () => {
    const allowListedOnly = `
      import { TinyCloudNode, type TinyCloudNodeConfig } from "@tinycloud/node-sdk/core";
      import { resolveReplicationConfig, validateReplicationConfig } from "./replica-wiring";
      export interface Config { replication?: TinyCloudNodeConfig["replication"]; }
      export class TinyCloudWeb {
        constructor(config: Config = {}) { validateReplicationConfig(config); }
        async init(nodeConfig: TinyCloudNodeConfig) {
          const resolved = await resolveReplicationConfig(this.config, this.walletSigner);
          if (resolved) nodeConfig.replication = resolved;
        }
        get replication(): TinyCloudNode["replication"] { return this.node.replication; }
      }
    `;

    it("passes when only the allow-listed names appear", () => {
      expect(replicaWiringViolations("tcw", allowListedOnly)).toEqual([]);
    });

    it("fails on a replication import from the node SDK", () => {
      const source = `import { TinyCloudNode, registerReplicationLoaders as registerNodeReplicationLoaders } from "@tinycloud/node-sdk/core";\n${allowListedOnly}`;
      const violations = replicaWiringViolations("tcw", source);
      expect(violations.some((v) => v.includes("replica import"))).toBe(true);
      expect(violations.some((v) => v.includes("registerNodeReplicationLoaders"))).toBe(true);
    });

    it("fails on a type-only replication import", () => {
      const source = `import type { ReplicationModuleLoaders } from "@tinycloud/node-sdk/core";\n${allowListedOnly}`;
      expect(replicaWiringViolations("tcw", source).some((v) => v.includes("replica import"))).toBe(true);
    });

    it("fails on an import of the optional replica entry", () => {
      expect(replicaWiringViolations("tcw", `import "../replica";\n${allowListedOnly}`)).not.toEqual([]);
      expect(replicaWiringViolations("tcw", `const m = await import("../replica");\n${allowListedOnly}`)).not.toEqual([]);
    });

    it("fails on an import of a non-allow-listed name from the wiring module", () => {
      const source = `import { registerBrowserReplica } from "./replica-wiring";\n${allowListedOnly}`;
      expect(replicaWiringViolations("tcw", source)).not.toEqual([]);
    });

    it("fails on replica state or functions declared in the file", () => {
      expect(replicaWiringViolations("tcw", `${allowListedOnly}\nlet registeredBrowserReplica: unknown;`)).not.toEqual([]);
      expect(replicaWiringViolations("tcw", `${allowListedOnly}\nexport function registerBrowserReplica() {}`)).not.toEqual([]);
      expect(replicaWiringViolations("tcw", `${allowListedOnly}\nfunction resolveReplicationConfig() {}`)).not.toEqual([]);
      expect(replicaWiringViolations("tcw", `${allowListedOnly}\nexport interface BrowserReplicaPlugin {}`)).not.toEqual([]);
    });

    it("fails on a replica call or property that is not allow-listed", () => {
      expect(replicaWiringViolations("tcw", `${allowListedOnly}\nthis.replicaStatus();`)).not.toEqual([]);
      expect(replicaWiringViolations("tcw", `${allowListedOnly}\nrecoverReplica(config);`)).not.toEqual([]);
    });

    it("fails on `replication` used as a binding rather than a property", () => {
      expect(replicaWiringViolations("tcw", `${allowListedOnly}\nconst replication = config.replication;`)).not.toEqual([]);
    });

    it("fails on the wiring's private names even inside strings", () => {
      expect(replicaWiringViolations("tcw", `${allowListedOnly}\nconst s = "registeredBrowserReplica";`)).not.toEqual([]);
    });
  });

  describe("index.ts", () => {
    const allowListedOnly = `
      export { TinyCloudWeb, type Config } from "./modules/tcw";
      export {
        registerBrowserReplica,
        type BrowserReplicaPlugin,
        __replicaKV,
        __replicaSiweMessage,
      } from "./modules/replica-wiring";
    `;

    it("passes when only the wiring re-exports appear", () => {
      expect(replicaWiringViolations("index", allowListedOnly)).toEqual([]);
    });

    it("fails on the shared-core __replica* block re-exported from sdk-core", () => {
      const source = `${allowListedOnly}\nexport { KV as __replicaKV2 } from "@tinycloud/sdk-core";`;
      expect(replicaWiringViolations("index", source)).not.toEqual([]);
    });

    it("fails on a replica re-export from tcw.ts or another module", () => {
      expect(replicaWiringViolations("index", `${allowListedOnly}\nexport { registerBrowserReplica as r } from "./modules/tcw";`))
        .not.toEqual([]);
      expect(replicaWiringViolations("index", `${allowListedOnly}\nexport * from "./replica";`)).not.toEqual([]);
    });

    it("fails on a replica re-export from the wiring module that is not allow-listed", () => {
      expect(replicaWiringViolations("index", `${allowListedOnly}\nexport { validateReplicationConfig } from "./modules/replica-wiring";`))
        .not.toEqual([]);
    });

    it("fails on a replica declaration in the file", () => {
      expect(replicaWiringViolations("index", `${allowListedOnly}\nexport const replicaOptions = {};`)).not.toEqual([]);
    });
  });
});
