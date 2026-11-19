import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { HEALTHLOG_APP_ID, HEALTHLOG_LINK, RECIPES_LINK, TC_APPS_PREAMBLE, TC_APPS_COPY_PREAMBLE, TC_APPS_CATALOG_PREAMBLE } from "../packages/operations/src/tc-apps/preamble";

const root = new URL("../packages/operations/src/tc-apps/", import.meta.url);
const metadata = JSON.parse(await readFile(new URL("vendor/version.json", root), "utf8")) as {
  version: string; files: Record<string, { sha256: string; size: number }>;
};
async function source(name: string): Promise<string> {
  const bytes = await readFile(new URL(`vendor/${name}`, root));
  const expected = metadata.files[name];
  if (!expected || expected.size !== bytes.length || expected.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
    throw new Error(`Vendored ${name} differs from version.json; rerun the source sync`);
  }
  return bytes.toString("utf8");
}
function anchor(text: string, phrase: string): number {
  const index = text.indexOf(phrase);
  if (index < 0 || text.indexOf(phrase, index + phrase.length) >= 0) {
    throw new Error(`Expected exactly one rules anchor: ${phrase}`);
  }
  return index;
}
function between(text: string, start: string, end: string): string {
  const from = anchor(text, start);
  const to = anchor(text, end);
  if (from >= to) throw new Error(`Reversed rules anchors: ${start} / ${end}`);
  return text.slice(from, to).trim();
}
const skill = await source("SKILL.md");
const sql = await source("SQL.md");
const tinyApps = await source("TINY-APPS.md");
// Use the pinned domain table, with hosted legacy-first routing defined in preamble.ts.
const catalogTable = between(tinyApps, "| Domain (match the owner's words) |", "A domain is owned by a catalog app");
// The procedure in preamble.ts is written for exactly these two apps: fail loudly when the pinned table drifts from it.
const tableRows = catalogTable.split("\n").filter((line) => line.startsWith("|")).length - 2;
if (tableRows !== 2 || ![HEALTHLOG_APP_ID, HEALTHLOG_LINK, RECIPES_LINK].every((value) => catalogTable.includes(value))) {
  throw new Error("The pinned TINY-APPS.md routing table no longer matches the Health Log and Recipes constants in preamble.ts; update the catalog rules before re-pinning");
}
if (TC_APPS_CATALOG_PREAMBLE.split("{{CATALOG_TABLE}}").length !== 2) throw new Error("The catalog rules need exactly one {{CATALOG_TABLE}} placeholder");
const catalog = TC_APPS_CATALOG_PREAMBLE.replace("{{CATALOG_TABLE}}", () => catalogTable);
let organization = between(skill, "## 2. How the records are organised\n", "## 3. Reuse access, find the app and read its catalog\n");
// Adapt the CLI's stored-record examples to MCP write inputs without changing the vendor source.
for (const [sourceLabel, hostedLabel] of [
  ["**A record** is one line of JSON: ", "**A record write value:** "],
  ["**An app record:** ", "**An app catalog write value:** "],
  ["**A kind record:** ", "**A kind catalog write value:** "],
]) {
  const start = anchor(organization, `${sourceLabel}\``);
  const valueStart = start + sourceLabel.length + 1;
  const end = organization.indexOf("`", valueStart);
  if (end < 0) throw new Error(`Missing JSON example terminator: ${sourceLabel}`);
  const value = JSON.parse(organization.slice(valueStart, end)) as Record<string, unknown>;
  delete value.by;
  organization = organization.slice(0, start) + `${hostedLabel}\`${JSON.stringify(value)}\`` + organization.slice(end + 1);
}
const cliByRule = "- `by`: your client: `claude-code`, `codex` or `opencode`.";
anchor(organization, cliByRule);
organization = organization.replace(cliByRule, "- `by`: server-owned attribution on stored/read-back records; omit it from every MCP write value.");
// Keep the pinned new-layout key examples without implying legacy apps must use those paths.
const newLayoutKeys = "Pick the app first: `<APP>` is its name, `<ID>` is `xyz.tinycloud.tinyapps.<APP>`, and every key of that app starts with `<ID>/`.";
anchor(organization, newLayoutKeys);
organization = organization.replace(newLayoutKeys, "For a new-layout app, `<APP>` is its name, `<ID>` is `xyz.tinycloud.tinyapps.<APP>`, and its keys follow the table below. Legacy apps instead use the default-space catalog and record paths given in the hosted instructions above, with the same record shapes and kind rules; they have no discovery entry.");
const readSection = between(skill, "## 5. Read\n", "## 6. Write\n");
const answers = readSection.slice(anchor(readSection, "To answer a question:\n")).trim();
const copySection = between(skill, "## 7. The fast copy (SQL index)\n", "## 8. Errors\n");
const copy = copySection.slice(0, anchor(copySection, "Read `SQL.md` in full")).trim();
const querySection = between(sql, "## 5. Query\n", "## 6. Rebuild a kind\n");
const examples = querySection.slice(anchor(querySection, "Examples.")).trim();
const full = [TC_APPS_PREAMBLE, catalog, TC_APPS_COPY_PREAMBLE, organization, answers, copy, examples]
  .map((section) => section.trim()).join("\n\n").replaceAll("\\$", "$") + "\n";
const generated = `// Generated by scripts/generate-tc-apps-rules.ts from pinned tc-apps ${metadata.version}. Do not edit.\n` +
  `export const TC_APPS_RULES = ${JSON.stringify(full)};\n`;
const target = new URL("rules.generated.ts", root);
if (process.argv.includes("--check")) {
  const current = await readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (current !== generated) throw new Error("tc-apps rules drift: run bun scripts/generate-tc-apps-rules.ts");
} else {
  await writeFile(target, generated);
}
