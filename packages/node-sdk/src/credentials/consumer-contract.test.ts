import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const NODE_SDK = resolve(import.meta.dir, "../..");
const WEB_SDK = resolve(NODE_SDK, "../web-sdk");

/**
 * Builtins the browser-target graph of ./credentials may leave external. Both have fallbacks in
 * web-sdk/webpack.config.cjs (`buffer` and `crypto`). Any other external builtin, or any new one,
 * fails this test.
 */
const WEB_SDK_POLYFILLED_BUILTINS = ["buffer", "crypto"];

interface MetaImport { path: string; external?: boolean }

/** Bundles `entry` for the browser target, as a bundler would, and returns its external builtin imports. */
async function browserExternalBuiltins(entry: string): Promise<{ externals: string[]; errors: string[] }> {
  const result = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", write: false, metafile: true });
  const errors = result.logs.filter((log) => log.level === "error").map((log) => log.message);
  const externals = new Set<string>();
  for (const input of Object.values(result.metafile!.inputs) as { imports: MetaImport[] }[]) {
    for (const imp of input.imports) {
      if (!imp.external) continue;
      if (imp.path.startsWith("node:") || builtinModules.includes(imp.path)) externals.add(imp.path);
    }
  }
  return { externals: [...externals].sort(), errors };
}

test("the browser-target graph of ./credentials leaves only web-sdk-polyfilled builtins external", async () => {
  for (const entry of [join(NODE_SDK, "dist/credentials.js"), join(NODE_SDK, "dist/credentials.cjs")]) {
    expect(existsSync(entry)).toBe(true);
    const { externals, errors } = await browserExternalBuiltins(entry);
    expect(errors).toEqual([]);
    expect(externals).toEqual(WEB_SDK_POLYFILLED_BUILTINS);
  }
});

test("positive control: the file-store subpath keeps fs external under the browser target", async () => {
  const { externals, errors } = await browserExternalBuiltins(join(NODE_SDK, "dist/credential-pending-store.js"));
  expect(errors).toEqual([]);
  expect(externals).toEqual(expect.arrayContaining(["fs", "vm"]));
});

test("strict consumer typecheck resolves both credentials subpaths with real declarations", () => {
  for (const d of [join(NODE_SDK, "dist/credentials.d.ts"), join(WEB_SDK, "dist/credentials-subpath.d.ts")]) {
    expect(existsSync(d)).toBe(true);
  }
  const dir = mkdtempSync(join(tmpdir(), "credentials-consumer-"));
  const scope = join(dir, "node_modules", "@tinycloud");
  mkdirSync(scope, { recursive: true });
  symlinkSync(NODE_SDK, join(scope, "node-sdk"), "dir");
  symlinkSync(WEB_SDK, join(scope, "web-sdk"), "dir");
  writeFileSync(join(dir, "consumer.ts"), [
    `import { acquireEmailProof, EmailProofError, type EmailProofResult } from "@tinycloud/node-sdk/credentials";`,
    `import { createFileEmailProofPendingStore, PendingStoreError } from "@tinycloud/node-sdk/credential-pending-store";`,
    `import { acquireEmailProof as webAcquire, EmailProofError as WebError, type EmailProofAcquisition } from "@tinycloud/web-sdk/credentials";`,
    `export const acquire: typeof acquireEmailProof = acquireEmailProof;`,
    `export const err: EmailProofError | undefined = undefined;`,
    `export const result: EmailProofResult | undefined = undefined;`,
    `export const store = createFileEmailProofPendingStore;`,
    `export const storeErr: PendingStoreError | undefined = undefined;`,
    `export const web: typeof webAcquire = webAcquire;`,
    `export const webErr: WebError | undefined = undefined;`,
    `export const acq: EmailProofAcquisition | undefined = undefined;`,
    ``,
  ].join("\n"));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, module: "esnext", moduleResolution: "bundler", target: "es2022", skipLibCheck: true, types: [] },
    files: ["consumer.ts"],
  }));
  const tsc = Bun.resolveSync("typescript/lib/tsc.js", NODE_SDK);
  const run = Bun.spawnSync([process.execPath, tsc, "-p", join(dir, "tsconfig.json")], { stdout: "pipe", stderr: "pipe" });
  const output = `${run.stdout.toString()}${run.stderr.toString()}`;
  expect(output).toBe("");
  expect(run.exitCode).toBe(0);
});
