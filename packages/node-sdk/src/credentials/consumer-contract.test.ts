import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const NODE_SDK = resolve(import.meta.dir, "../..");
const WEB_SDK = resolve(NODE_SDK, "../web-sdk");
const SDK_CORE = resolve(NODE_SDK, "../sdk-core");
const SDK_CORE_INDEX = join(SDK_CORE, "dist/index.js");
if (!existsSync(SDK_CORE_INDEX)) {
  // Bun's bundler fails with "Unexpected reading file" when a workspace dist is missing. Build it, or
  // throw with the build output. Never skip.
  const build = Bun.spawnSync([process.execPath, "run", "build"], { cwd: SDK_CORE, stdout: "pipe", stderr: "pipe", timeout: 300_000 });
  if (build.exitCode !== 0 || !existsSync(SDK_CORE_INDEX)) {
    throw new Error(`sdk-core dist missing and build failed (exit ${build.exitCode}): ${build.stderr.toString()}`);
  }
}

/**
 * web-sdk webpack config: `resolve.fallback` keys whose value is `require.resolve(...)`. `false` entries are disabled, not polyfilled.
 * A bare name and its `node:` spelling are treated as the same builtin here, so removing only one of the two spellings from the
 * config is not detected by this test; the webpack build itself is what proves each spelling resolves.
 */
const WEB_SDK_WEBPACK_CONFIG = join(WEB_SDK, "webpack.config.cjs");

function webSdkPolyfilledBuiltins(): string[] {
  const names = new Set<string>();
  for (const m of readFileSync(WEB_SDK_WEBPACK_CONFIG, "utf8").matchAll(/^\s*"?([\w:/.-]+?)"?\s*:\s*require\.resolve\(/gm)) {
    names.add(m[1]!.replace(/^node:/, ""));
  }
  return [...names].sort();
}

async function unpolyfilledBuiltins(entry: string): Promise<{ errors: string[]; unpolyfilled: string[] }> {
  const polyfilled = webSdkPolyfilledBuiltins();
  const { externals, errors } = await browserExternalBuiltins(entry);
  return { errors, unpolyfilled: externals.filter((b) => !polyfilled.includes(b)) };
}

interface MetaImport { path: string; external?: boolean }

/** Bundles `entry` for the browser target, as a bundler would, and returns its external builtin imports. */
async function browserExternalBuiltins(entry: string): Promise<{ externals: string[]; errors: string[] }> {
  // Bundle in a child process. In-process Bun.build fails with "Unexpected reading file" once another
  // test file in the same `bun test` run has loaded @tinycloud/sdk-core at runtime (email-proof.test.ts).
  const script = `(async () => {
    const result = await Bun.build({ entrypoints: [process.env.TC712_ENTRY], target: "browser", format: "esm", write: false, metafile: true });
    const errors = result.logs.filter((log) => log.level === "error").map((log) => log.message);
    const imports = Object.values(result.metafile.inputs).flatMap((input) => input.imports);
    console.log(JSON.stringify({ errors, imports }));
  })();`;
  const child = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, TC712_ENTRY: entry },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
  if (child.exitCode !== 0) throw new Error(`browser bundle of ${entry} failed (exit ${child.exitCode}): ${child.stderr.toString()}`);
  const lines = child.stdout.toString().trim().split("\n");
  const { errors, imports } = JSON.parse(lines[lines.length - 1]!) as { errors: string[]; imports: MetaImport[] };
  const externals = new Set<string>();
  for (const imp of imports) {
    if (!imp.external) continue;
    if (imp.path.startsWith("node:") || builtinModules.includes(imp.path)) externals.add(imp.path.replace(/^node:/, ""));
  }
  return { externals: [...externals].sort(), errors };
}

test("the browser-target graph of ./credentials leaves only web-sdk-polyfilled builtins external", async () => {
  expect(webSdkPolyfilledBuiltins()).toEqual(expect.arrayContaining(["buffer", "crypto", "vm"]));
  expect(webSdkPolyfilledBuiltins()).not.toContain("fs");
  for (const entry of [join(NODE_SDK, "dist/credentials.js"), join(NODE_SDK, "dist/credentials.cjs")]) {
    expect(existsSync(entry)).toBe(true);
    const { errors, unpolyfilled } = await unpolyfilledBuiltins(entry);
    expect(errors).toEqual([]);
    expect(unpolyfilled).toEqual([]);
  }
});

test("positive control: the file-store subpath keeps fs external under the browser target", async () => {
  const { externals, errors } = await browserExternalBuiltins(join(NODE_SDK, "dist/credential-pending-store.js"));
  expect(errors).toEqual([]);
  expect(externals).toEqual(expect.arrayContaining(["fs", "vm"]));
});

test("negative control: a node:fs import is external under the browser target and not polyfilled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "browser-negative-"));
  try {
    const entry = join(dir, "entry.ts");
    writeFileSync(entry, `import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n`);
    const { errors, unpolyfilled } = await unpolyfilledBuiltins(entry);
    expect(errors).toEqual([]);
    expect(unpolyfilled).toEqual(["fs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no credentials source file imports a Node builtin directly", () => {
  const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
  const srcDir = join(NODE_SDK, "src/credentials");
  const offenders: string[] = [];
  for (const file of readdirSync(srcDir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    // Static and dynamic imports and require() calls; a bare child_process-style import is only visible to this source scan, not to the bundle check above.
    for (const m of readFileSync(join(srcDir, file), "utf8").matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)) {
      if (builtins.has(m[1]!)) offenders.push(`${file}: ${m[1]}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("strict consumer typecheck resolves both credentials subpaths with real declarations", () => {
  // node-sdk declarations come from its build (the authority job builds node-sdk before this suite).
  const nodeDeclarations = join(NODE_SDK, "dist/credentials.d.ts");
  if (!existsSync(nodeDeclarations)) {
    throw new Error(`node-sdk declarations missing: ${nodeDeclarations}. Build @tinycloud/node-sdk before this suite.`);
  }
  // The web-sdk subpath declaration is emitted here from its source, not read from a webpack build. The mapping is the one package.json names.
  expect(JSON.parse(readFileSync(join(WEB_SDK, "package.json"), "utf8")).exports["./credentials"]?.types).toBe("./dist/credentials-subpath.d.ts");
  const tsc = Bun.resolveSync("typescript/lib/tsc.js", NODE_SDK);
  const dir = mkdtempSync(join(tmpdir(), "credentials-consumer-"));
  try {
    const emitDir = join(dir, "web-sdk-types");
    writeFileSync(join(dir, "emit.tsconfig.json"), JSON.stringify({
      extends: join(WEB_SDK, "tsconfig.json"),
      // Explicit typeRoots: this tsconfig lives in the OS tmpdir, where `types: ["node"]` (web-sdk's base config) cannot be found by walking up from the config.
      compilerOptions: {
        noEmit: false, declaration: true, emitDeclarationOnly: true, declarationMap: false, sourceMap: false, outDir: emitDir,
        typeRoots: [join(WEB_SDK, "node_modules/@types"), resolve(NODE_SDK, "../../node_modules/@types")],
      },
      files: [join(WEB_SDK, "src/credentials-subpath.ts")],
      include: [],
    }));
    const emit = Bun.spawnSync([process.execPath, tsc, "-p", join(dir, "emit.tsconfig.json")], { stdout: "pipe", stderr: "pipe" });
    const emitted = join(emitDir, "credentials-subpath.d.ts");
    if (emit.exitCode !== 0 || !existsSync(emitted)) {
      throw new Error(`web-sdk credentials declarations did not emit (exit ${emit.exitCode}, expected ${emitted}):\n${emit.stdout.toString()}${emit.stderr.toString()}`);
    }
    const scope = join(dir, "node_modules", "@tinycloud");
    mkdirSync(scope, { recursive: true });
    symlinkSync(NODE_SDK, join(scope, "node-sdk"), "dir");
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
      compilerOptions: { strict: true, noEmit: true, module: "esnext", moduleResolution: "bundler", target: "es2022", skipLibCheck: true, types: [],
        paths: { "@tinycloud/web-sdk/credentials": [emitted] } },
      files: ["consumer.ts"],
    }));
    const run = Bun.spawnSync([process.execPath, tsc, "-p", join(dir, "tsconfig.json")], { stdout: "pipe", stderr: "pipe" });
    const output = `${run.stdout.toString()}${run.stderr.toString()}`;
    expect(output).toBe("");
    expect(run.exitCode).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
