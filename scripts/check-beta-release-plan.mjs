import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const changesetDirectory = resolve(process.argv[2] ?? ".changeset");
const allowMajor = process.env.ALLOW_MAJOR_BETA === "true";
const majorPackages = new Set();
const admittedChangesets = new Set();

try {
  const pre = JSON.parse(await readFile(resolve(changesetDirectory, "pre.json"), "utf8"));
  if (Array.isArray(pre.changesets)) {
    for (const id of pre.changesets) {
      if (typeof id === "string") admittedChangesets.add(id);
    }
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

for (const name of await readdir(changesetDirectory)) {
  if (!name.endsWith(".md") || name === "README.md") continue;
  if (admittedChangesets.has(name.slice(0, -3))) continue;
  const source = await readFile(resolve(changesetDirectory, name), "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1];
  if (frontmatter === undefined) continue;
  for (const line of frontmatter.split(/\r?\n/)) {
    const entry = /^\s*["']?([^"':]+)["']?\s*:\s*major\s*$/.exec(line);
    if (entry?.[1] !== undefined) majorPackages.add(entry[1]);
  }
}

if (majorPackages.size > 0 && !allowMajor) {
  throw new Error(`Automatic beta release refuses unconfirmed major bumps: ${[...majorPackages].sort().join(", ")}. Use an explicitly reviewed major-release workflow.`);
}

console.log(majorPackages.size === 0
  ? "Beta release plan contains no major bumps."
  : `Explicit major beta release confirmed for: ${[...majorPackages].sort().join(", ")}`);
