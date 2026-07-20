import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const exec = promisify(execFile);
const root = resolve(process.cwd());
const nodeBinary = process.env.NODE_BINARY ?? "node";
const packages = [
  { directory: "packages/operations", name: "@tinycloud/operations", required: ["package/dist/index.js", "package/dist/index.cjs", "package/dist/secret-capabilities.js", "package/generated/operations.json", "package/coverage.json"] },
  { directory: "packages/cli", name: "@tinycloud/cli", required: ["package/dist/index.js", "package/bin/tc"] },
  { directory: "packages/mcp", name: "@tinycloud/mcp", required: ["package/dist/index.js", "package/dist/index.cjs", "package/dist/http.js", "package/dist/http-cli.js", "package/bin/tinycloud-mcp-http", "package/generated/mcp-facts.json", "package/skills/tinycloud-delegated-secrets/SKILL.md"] },
] as const;

const working = await mkdtemp(join(tmpdir(), "tinycloud-i5-pack-"));
const packDirectory = join(working, "packs");
const fixture = join(working, "node20-fixture");
const extracted = new Map<string, string>();
await Bun.$`mkdir -p ${packDirectory} ${fixture}`;

try {
  const tarballs = new Map<string, string>();
  const manifests = new Map<string, Record<string, any>>();
  for (const package_ of packages) {
    const { stdout } = await exec("npm", ["pack", "--json", "--pack-destination", packDirectory], {
      cwd: join(root, package_.directory),
    });
    const packed = JSON.parse(stdout) as Array<{ filename: string }>;
    if (packed.length !== 1) throw new Error(`expected one tarball for ${package_.name}`);
    const tarball = join(packDirectory, packed[0]!.filename);
    tarballs.set(package_.name, tarball);
    const manifest = JSON.parse((await exec("tar", ["-xOf", tarball, "package/package.json"])).stdout) as Record<string, any>;
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
      for (const match of source.matchAll(/@tinycloud\/[a-z0-9-]+/g)) {
        if (match[0] === package_.name) continue;
        if (!declaredWorkspacePackages.has(match[0]!)) throw new Error(`${package_.name} uses undeclared ${match[0]}`);
      }
    }
  }

  await writeFile(join(fixture, "package.json"), JSON.stringify({
    name: "tinycloud-i5-node20-pack-consumer",
    private: true,
    type: "module",
    engines: { node: ">=20" },
  }));
  await exec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", ...[...tarballs.values()]], { cwd: fixture });
  const nodeVersion = (await exec(nodeBinary, ["--version"])).stdout.trim();
  const nodeMajor = Number.parseInt(nodeVersion.replace(/^v/, "").split(".")[0]!, 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    throw new Error(`packed fixture requires Node >=20, received ${nodeVersion}`);
  }
  await exec(nodeBinary, ["--input-type=module", "-e", "await import('@tinycloud/operations'); await import('@tinycloud/mcp');"], { cwd: fixture });
  await exec(nodeBinary, [join(fixture, "node_modules/@tinycloud/cli/dist/index.js"), "--version"], { cwd: fixture });
  console.log(`Packed Node 20 fixture verified for operations ${operationsVersion}, CLI, and MCP.`);
} finally {
  await rm(working, { recursive: true, force: true });
}
