import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { verifyInstalledDiagnostics, verifyInstalledDiagnosticReproduction } from "../tests/packed-runtime/diagnostics.js";
import { verifyInstalledDiagnosticFailures } from "../tests/packed-runtime/diagnostics-failures.js";

const exec = promisify(execFile);
const root = resolve(process.cwd());
const nodeBinary = process.env.NODE_BINARY ?? "node";
import { alphaPackage, bundledManifest, installLockedGraph, packedPackages as packages, writeJson } from "./packed-packages.mjs";
import { assertPackagePath, inventory, json } from "./preview-files.mjs";

interface PublishedManifest {
  [key: string]: unknown;
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function assertPublishedManifest(value: unknown): asserts value is PublishedManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || !("name" in value) || typeof value.name !== "string"
    || !("version" in value) || typeof value.version !== "string") {
    throw new Error("Invalid packed package manifest");
  }
  for (const [key, dependencies] of Object.entries(value)) {
    if (key !== "dependencies" && key !== "optionalDependencies" && key !== "peerDependencies") continue;
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)
      || Object.values(dependencies).some((version) => typeof version !== "string")) {
      throw new Error("Invalid packed dependency manifest");
    }
  }
}


// Exact release-candidate mode never repacks or resolves registry dependencies.
if (process.argv.includes("--alpha-tarball")) {
  if (process.argv.length !== 4 || process.argv[2] !== "--alpha-tarball") throw new Error("Usage: bun scripts/check-operations-mcp-pack.ts --alpha-tarball EXACT.tgz");
  await verifyAlphaTarball(resolve(process.argv[3]!));
  process.exit(0);
}

export async function verifyAlphaTarball(tarball: string): Promise<void> {
  const working = await mkdtemp(join(tmpdir(), "tinycloud-alpha-acceptance-"));
  const original = join(working, "installed");
  const relocated = join(working, "relocated");
  const home = join(working, "home");
  const env = {
    PATH: process.env.PATH, HOME: home, TC_HOME: join(home, "tc"),
    TC_APPS_STATE: join(home, "apps"), TC_DIAGNOSTICS_HOME: join(home, "diagnostics"),
    XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
    npm_config_cache: join(working, "empty-cache"), npm_config_userconfig: join(working, "user.npmrc"),
    npm_config_globalconfig: join(working, "global.npmrc"), NO_COLOR: "1",
  };
  try {
    await Promise.all([original, home].map((path) => mkdir(path, { mode: 0o700 })));
    await Promise.all([env.npm_config_userconfig, env.npm_config_globalconfig].map((path) => writeFile(path, "")));
    const listing = (await exec("tar", ["-tzf", tarball], { maxBuffer: 32 * 1024 * 1024 })).stdout.trim().split("\n");
    for (const path of listing) assertPackagePath(path);
    await writeJson(join(original, "package.json"), { name: "alpha-private-consumer", private: true });
    await exec("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: original, env, maxBuffer: 32 * 1024 * 1024 });
    await rename(original, relocated);
    const fixture = join(relocated, "node_modules", alphaPackage.name);
    // npm inherits the caller's umask; diagnostic homes require non-writable ancestors.
    await Promise.all([join(relocated, "node_modules"), join(relocated, "node_modules/@tinycloud"), fixture].map((path) => chmod(path, 0o700)));
    await inventory(fixture);
    const manifest = await json(join(fixture, "package.json"));
    const identity = await json(join(fixture, "identity.json"));
    if (manifest.name !== alphaPackage.name || manifest.version !== alphaPackage.version
      || identity.name !== manifest.name || identity.version !== manifest.version) throw new Error("Installed alpha identity mismatch");
    await exec(nodeBinary, ["--input-type=module", "-e", `import {assertPlatform} from './lib/preview-files.mjs'; assertPlatform(); await import('@tinycloud/operations'); await import('@tinycloud/mcp');`], { cwd: fixture, env });
    for (const bin of ["tc-apps-alpha", "tc-apps-alpha-mcp"]) {
      const result = await exec(nodeBinary, [join(fixture, "bin", bin), "--alpha-identity"], { cwd: home, env });
      if (JSON.stringify(JSON.parse(result.stdout)) !== JSON.stringify(identity)) throw new Error(`${bin} identity mismatch after relocation`);
      await exec(nodeBinary, [join(fixture, "bin", bin), "--help"], { cwd: home, env });
    }
    const smoke = join(fixture, "alpha-smoke.mjs");
    await writeFile(smoke, `
import assert from 'node:assert/strict';
import {spawn,execFile as callbackExec} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import {access} from 'node:fs/promises';
import {resolve} from 'node:path';
const exec=promisify(callbackExec);
const cli=resolve('bin/tc-apps-alpha'),mcp=resolve('bin/tc-apps-alpha-mcp');
const status=await exec(process.execPath,[cli,'diagnostics','status','--json']);
assert.equal(JSON.parse(status.stdout).enabled,false);
const child=spawn(process.execPath,[mcp],{stdio:['pipe','pipe','pipe']});
const pending=new Map();
let stderr='';
child.stderr.on('data',chunk=>stderr+=chunk);
const {promise:exited,resolve:resolveExit,reject:rejectExit}=Promise.withResolvers();
child.once('exit',(code,signal)=>resolveExit({code,signal}));
child.once('error',rejectExit);
const lines=createInterface({input:child.stdout});
lines.on('line',line=>{
  const message=JSON.parse(line);
  const settle=pending.get(message.id);
  if(settle){pending.delete(message.id);settle(message);}
});
const timeout=setTimeout(()=>child.kill('SIGKILL'),15000);
const rpc=(id,method,params)=>{
  const {promise,resolve:resolveReply}=Promise.withResolvers();
  pending.set(id,resolveReply);
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\\n');
  return Promise.race([promise,exited.then(result=>{throw new Error('MCP exited before reply: '+JSON.stringify({result,stderr}));})]);
};
try{
  const initialized=await rpc(1,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'alpha-synthetic-smoke',version:'0.0.0'}});
  assert(initialized.result?.serverInfo);
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\\n');
  const listed=await rpc(2,'tools/list',{});
  assert(listed.result.tools.some(tool=>tool.name==='tinycloud_kv_get'));
  const called=await rpc(3,'tools/call',{name:'tinycloud_kv_get',arguments:{space:'default',key:'xyz.tinycloud.agent-data/synthetic/readback'}});
  assert.equal(called.result.structuredContent.status,'error');
  assert.equal(called.result.structuredContent.error.code,'PROFILE_NOT_FOUND');
  child.stdin.end();
  assert.deepEqual(await exited,{code:0,signal:null});
  assert.equal(await access(process.env.TC_DIAGNOSTICS_HOME).then(()=>true,()=>false),false);
  console.log('Relocated alpha CLI default-off status and real MCP initialize/list/KV refusal passed; no diagnostic root created.');
}finally{
  clearTimeout(timeout);lines.close();child.kill();
}
`, { mode: 0o600 });
    console.log((await exec(nodeBinary, [smoke], { cwd: fixture, env, timeout: 25_000 })).stdout.trim());
    await rm(smoke);
    await verifyInstalledDiagnostics(fixture, nodeBinary);
    await verifyInstalledDiagnosticReproduction(fixture, nodeBinary);
    await verifyInstalledDiagnosticFailures(fixture, nodeBinary);
    console.log(`Exact ${manifest.name}@${manifest.version} passed offline fresh install, relocation, CLI/MCP entrypoints and native packed diagnostics acceptance.`);
  } finally {
    await rm(working, { recursive: true, force: true });
  }
}

const working = await mkdtemp(join(tmpdir(), "tinycloud-i5-pack-"));
const packDirectory = join(working, "packs");
const fixture = join(working, "node20-fixture");
const extracted = new Map<string, string>();
// Diagnostic fixtures reject group-writable ancestors even inside a private temp root.
await Promise.all([packDirectory, fixture].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));

try {
  const tarballs = new Map<string, string>();
  const manifests = new Map<string, PublishedManifest>();
  for (const package_ of packages) {
    const { stdout } = await exec("npm", ["pack", "--json", "--pack-destination", packDirectory], {
      cwd: join(root, package_.directory),
    });
    const packed = JSON.parse(stdout) as Array<{ filename: string }>;
    if (packed.length !== 1) throw new Error(`expected one tarball for ${package_.name}`);
    const tarball = join(packDirectory, packed[0]!.filename);
    tarballs.set(package_.name, tarball);
    const manifest: unknown = JSON.parse((await exec("tar", ["-xOf", tarball, "package/package.json"])).stdout);
    assertPublishedManifest(manifest);
    manifests.set(package_.name, manifest);
    const listing = (await exec("tar", ["-tzf", tarball])).stdout.split("\n").filter(Boolean);
    for (const required of package_.required) {
      if (!listing.includes(required)) throw new Error(`${package_.name} tarball is missing ${required}`);
    }
    const extractionRoot = join(working, package_.name.replaceAll("/", "-"));
    await mkdir(extractionRoot, { recursive: true });
    await exec("tar", ["-xzf", tarball, "-C", extractionRoot]);
    extracted.set(package_.name, join(extractionRoot, "package"));
  }

  const operationsVersion = manifests.get("@tinycloud/operations")!.version;
  for (const packageName of ["@tinycloud/cli", "@tinycloud/mcp"] as const) {
    const dependency = manifests.get(packageName)!.dependencies?.["@tinycloud/operations"];
    if (dependency !== operationsVersion) throw new Error(`${packageName} does not pin operations to ${operationsVersion}`);
  }

  async function javascriptFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return javascriptFiles(path);
      return entry.name.endsWith(".js") || entry.name.endsWith(".cjs") ? [path] : [];
    }));
    return nested.flat();
  }

  for (const package_ of packages) {
    const packageRoot = extracted.get(package_.name)!;
    const manifest = manifests.get(package_.name)!;
    const declaredWorkspacePackages = new Set<string>();
    for (const dependencies of [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
      for (const dependency of Object.keys(dependencies ?? {})) {
        if (dependency.startsWith("@tinycloud/")) declaredWorkspacePackages.add(dependency);
      }
    }
    const dist = join(packageRoot, "dist");
    for (const file of await javascriptFiles(dist)) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/(?:from\s*|import\s*\(|require\s*\()(['"])(\.[^'"]+)\1/g)) {
        const resolved = resolve(join(packageRoot, file.slice(packageRoot.length + 1)), "..", match[2]!);
        if (!resolved.startsWith(packageRoot)) throw new Error(`${package_.name} has an escaping relative import in ${file}`);
      }
      const executableSource = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      // Package names also occur as safe provenance data; only module
      // specifiers create a dependency, not an allowlisted descriptor label.
      for (const match of executableSource.matchAll(/(?:from\s*|import\s*\(|require(?:\.resolve)?\s*\()\s*(['"])(@tinycloud\/[a-z0-9-]+)(?:\/[^'"]*)?\1/g)) {
        if (match[2] === package_.name) continue;
        if (!declaredWorkspacePackages.has(match[2]!)) throw new Error(`${package_.name} uses undeclared ${match[2]}`);
      }
    }
  }

  const internal = new Map([...tarballs].map(([name, tarball]) => [name, {
    manifest: manifests.get(name)!,
    filename: tarball.split("/").pop()!,
    integrity: "",
  }]));
  await mkdir(join(fixture, "packs"), { mode: 0o700 });
  for (const [name, tarball] of tarballs) {
    internal.get(name)!.integrity = `sha512-${createHash("sha512").update(await readFile(tarball)).digest("base64")}`;
    await copyFile(tarball, join(fixture, "packs", internal.get(name)!.filename));
  }
  await writeJson(join(fixture, "package.json"), bundledManifest(internal, {
    name: "tinycloud-i5-node20-pack-consumer", private: true, type: "module", engines: { node: ">=20" },
  }));
  const run = async (command: string, args: string[], cwd: string) => (await exec(command, args, { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout.trim();
  await installLockedGraph(fixture, internal, run);
  const nodeVersion = (await exec(nodeBinary, ["--version"])).stdout.trim();
  const nodeMajor = Number.parseInt(nodeVersion.replace(/^v/, "").split(".")[0]!, 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    throw new Error(`packed fixture requires Node >=20, received ${nodeVersion}`);
  }
  await exec(nodeBinary, ["--input-type=module", "-e", "await import('@tinycloud/operations'); await import('@tinycloud/mcp');"], { cwd: fixture });
  await exec(nodeBinary, [join(fixture, "node_modules/@tinycloud/cli/bin/tc"), "--version"], { cwd: fixture });
  await verifyInstalledDiagnostics(fixture, nodeBinary);
  await verifyInstalledDiagnosticReproduction(fixture, nodeBinary);
  await verifyInstalledDiagnosticFailures(fixture, nodeBinary);
  console.log(`Packed ${nodeVersion} fixture verified for operations ${operationsVersion}, CLI, and MCP.`);
} finally {
  await rm(working, { recursive: true, force: true });
}
