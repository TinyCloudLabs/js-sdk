// Refresh skills/tc-apps from a TinyCloudLabs/prompts checkout, the skill's source:
//   bun run sync:tc-apps-skill ../../../prompts
// Copies the regular files of <checkout>/skills/tc-apps and writes SHA256SUMS the
// way the agents.tinycloud.xyz build does ("<sha256>  <file>", sorted), so
// `tc setup apps` installs byte for byte what /skills/apps serves for that commit.
import { createHash } from "node:crypto";
import { chmodSync, cpSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const checkout = process.argv[2];
if (!checkout) {
  console.error("usage: node scripts/sync-tc-apps-skill.mjs <TinyCloudLabs/prompts checkout>");
  process.exit(2);
}
const source = resolve(checkout, "skills/tc-apps");
const target = resolve("skills/tc-apps");
const files = readdirSync(source).filter((name) => statSync(join(source, name)).isFile()).sort();
if (!files.includes("SKILL.md")) throw new Error(`${source} has no SKILL.md`);
rmSync(target, { recursive: true, force: true });
for (const name of files) {
  cpSync(join(source, name), join(target, name));
  chmodSync(join(target, name), name.endsWith(".sh") ? 0o755 : 0o644);
}
const sums = files.map((name) => `${createHash("sha256").update(readFileSync(join(target, name))).digest("hex")}  ${name}\n`).join("");
writeFileSync(join(target, "SHA256SUMS"), sums);
chmodSync(join(target, "SHA256SUMS"), 0o644);
const version = /^\s+version:\s*["']?([^"'\n]+)/m.exec(readFileSync(join(target, "SKILL.md"), "utf8"))?.[1] ?? "unknown";
console.log(`tc-apps ${version}: ${files.length} files from ${source}`);
