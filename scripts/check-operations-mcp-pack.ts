import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const exec = promisify(execFile);
const root = resolve(process.cwd());
const nodeBinary = process.env.NODE_BINARY ?? "node";
const packages = [
  { directory: "packages/bootstrap", name: "@tinycloud/bootstrap", required: [] },
  { directory: "packages/node-sdk", name: "@tinycloud/node-sdk", required: ["package/dist/index.js", "package/dist/index.cjs"] },
  { directory: "packages/sdk-rs/packages/node", name: "@tinycloud/node-sdk-wasm", required: [] },
  { directory: "packages/sdk-core", name: "@tinycloud/sdk-core", required: ["package/dist/index.js", "package/dist/index.cjs"] },
  { directory: "packages/sdk-services", name: "@tinycloud/sdk-services", required: ["package/dist/index.js", "package/dist/index.cjs"] },
  { directory: "packages/share-envelope", name: "@tinycloud/share-envelope", required: ["package/dist/index.js", "package/dist/index.cjs"] },
  { directory: "packages/share-sdk", name: "@tinycloud/share-sdk", required: ["package/dist/index.js", "package/dist/index.cjs"] },
  { directory: "packages/operations", name: "@tinycloud/operations", required: ["package/dist/index.js", "package/dist/index.cjs", "package/dist/secret-capabilities.js", "package/generated/operations.json", "package/coverage.json"] },
  { directory: "packages/cli", name: "@tinycloud/cli", required: ["package/dist/index.js", "package/bin/tc"] },
  { directory: "packages/mcp", name: "@tinycloud/mcp", required: ["package/dist/index.js", "package/dist/index.cjs", "package/dist/http.js", "package/dist/http-cli.js", "package/bin/tinycloud-mcp-http", "package/generated/mcp-facts.json", "package/skills/tinycloud-delegated-secrets/SKILL.md"] },
] as const;

type PublishedPackage = { manifest: Record<string, any>; bytes: Buffer; filename: string };

async function startNpmRegistry(packagesToPublish: PublishedPackage[]): Promise<{ origin: string; close: () => Promise<void> }> {
  const byName = new Map(packagesToPublish.map((package_) => [package_.manifest.name as string, package_]));
  const server = createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      const separator = pathname.indexOf("/-/");
      const name = separator < 0 ? pathname.slice(1) : pathname.slice(1, separator);
      const package_ = byName.get(name);
      if (!package_) { response.writeHead(404).end(); return; }
      if (separator < 0) {
        const integrity = `sha512-${createHash("sha512").update(package_.bytes).digest("base64")}`;
        const body = JSON.stringify({
          name,
          "dist-tags": { latest: package_.manifest.version },
          versions: {
            [package_.manifest.version]: {
              ...package_.manifest,
              dist: { tarball: `${origin}/${encodeURIComponent(name)}/-/${package_.filename}`, integrity },
            },
          },
        });
        response.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }).end(body);
        return;
      }
      if (pathname !== `/${name}/-/${package_.filename}`) { response.writeHead(404).end(); return; }
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(package_.bytes.length) }).end(package_.bytes);
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("hermetic npm registry did not bind");
  const origin = `http://127.0.0.1:${address.port}`;
  return { origin, close: () => new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())) };
}

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
      const executableSource = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const match of executableSource.matchAll(/@tinycloud\/[a-z0-9-]+/g)) {
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
  const publishedPackages = await Promise.all([...tarballs.entries()].map(async ([name, tarball]) => ({
    manifest: manifests.get(name)!,
    bytes: await readFile(tarball),
    filename: tarball.split("/").pop()!,
  })));
  const npmRegistry = await startNpmRegistry(publishedPackages);
  try {
    const cliVersion = manifests.get("@tinycloud/cli")!.version;
    const mcpVersion = manifests.get("@tinycloud/mcp")!.version;
    await exec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--registry=https://registry.npmjs.org", `--@tinycloud:registry=${npmRegistry.origin}`, `@tinycloud/cli@${cliVersion}`, `@tinycloud/mcp@${mcpVersion}`], { cwd: fixture });
  } finally {
    await npmRegistry.close();
  }
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
