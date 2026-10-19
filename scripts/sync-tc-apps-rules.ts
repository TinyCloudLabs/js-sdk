import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const origin = "https://agents.tinycloud.xyz";
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 4 || args[0] !== "--local-site"
  || args[2] !== "--source-commit" || !/^[a-f0-9]{40}$/.test(args[3]!))) {
  throw new Error("Usage: bun scripts/sync-tc-apps-rules.ts [--local-site SITE --source-commit SHA]");
}
const localSite = args.length === 0 ? undefined : pathToFileURL(`${resolve(args[1]!)}/`);
const source = localSite === undefined ? origin : `https://github.com/TinyCloudLabs/prompts/tree/${args[3]}`;
const vendor = new URL("../packages/operations/src/tc-apps/vendor/", import.meta.url);
async function download(path: string): Promise<Buffer> {
  if (localSite !== undefined) return readFile(new URL(`.${path}`, localSite));
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Download ${path}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

type PublishedFile = { path: string; url: string; size: number; sha256: string };
type PublishedSkill = { name: string; version: string; files: PublishedFile[] };
const index = JSON.parse((await download("/skills/index.json")).toString("utf8")) as { skills: PublishedSkill[] };
const skill = index.skills.find((entry) => entry.name === "tc-apps");
if (!skill?.version) throw new Error("Published index has no tc-apps version");
const files = await Promise.all(["SKILL.md", "SQL.md"].map(async (name) => {
  const entry = skill.files.find((file) => file.path === name);
  if (!entry || entry.url !== `/skills/apps/${name}` || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
    throw new Error(`Missing or invalid published metadata for ${name}`);
  }
  const bytes = await download(entry.url);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== entry.size || sha256 !== entry.sha256) {
    throw new Error(`Published bytes do not match index for ${name}; no vendor files updated`);
  }
  return { name, bytes, sha256, size: bytes.length };
}));
// Fetch and verify everything before changing the pinned source.
await mkdir(vendor, { recursive: true });
for (const file of files) await writeFile(new URL(file.name, vendor), file.bytes);
await writeFile(new URL("version.json", vendor), JSON.stringify({
  name: "tc-apps", version: skill.version, source,
  files: Object.fromEntries(files.map(({ name, sha256, size }) => [name, { sha256, size }])),
}, null, 2) + "\n");
console.log(`Pinned tc-apps ${skill.version}`);
