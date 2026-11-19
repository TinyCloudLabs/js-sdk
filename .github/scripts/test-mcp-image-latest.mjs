// Runs the real "Pick the image to deploy" script from mcp-image.yml and checks which builds may move the
// `:latest` image tag, which the self-hosting docs tell users to run (so it must always be a stable release).
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const workflow = (await readFile(join(root, ".github/workflows/mcp-image.yml"), "utf8")).split("\n");

const fail = (message) => { throw new Error(message); };

const start = workflow.findIndex((line) => line.trim() === "id: pick");
const runLine = workflow.findIndex((line, i) => i > start && line.trim() === "run: |");
if (start < 0 || runLine < 0) fail("The pick step's run script was not found in mcp-image.yml.");
const indent = workflow[runLine + 1].match(/^ */)[0].length;
const body = [];
for (const line of workflow.slice(runLine + 1)) {
  if (line.trim() !== "" && !line.startsWith(" ".repeat(indent))) break;
  body.push(line.slice(indent));
}
const script = body.join("\n");

// The image job's tags list must gate :latest on the pick step's `stable` output.
const workflowText = workflow.join("\n");
if (!/needs\.resolve\.outputs\.stable == 'true' && 'ghcr\.io\/tinycloudlabs\/tinycloud-mcp:latest'/.test(workflowText)
  || (workflowText.match(/tinycloud-mcp:latest/g) ?? []).length !== 1) {
  fail("mcp-image.yml must tag :latest only when the resolve job's stable output is true.");
}

const dir = await mkdtemp(join(tmpdir(), "mcp-image-latest-"));
try {
  const pick = async (inputs) => {
    const output = join(dir, "output");
    await writeFile(output, "");
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, PACKAGE_VERSION: "", IMAGE_DIGEST: "", PREFLIGHT_ONLY: "false", ...inputs, GITHUB_OUTPUT: output },
    });
    const outputs = Object.fromEntries((await readFile(output, "utf8")).split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
    return { status: result.status, outputs };
  };
  const digest = `sha256:${"a".repeat(64)}`;
  const cases = [
    ["stable 0.8.7", { PACKAGE_VERSION: "0.8.7" }, "true"],
    ["stable 10.20.30", { PACKAGE_VERSION: "10.20.30" }, "true"],
    ["prerelease 0.9.0-beta.5", { PACKAGE_VERSION: "0.9.0-beta.5" }, "false"],
    ["prerelease 1.0.0-rc.1", { PACKAGE_VERSION: "1.0.0-rc.1" }, "false"],
    ["image_digest rollback", { IMAGE_DIGEST: digest }, undefined],
    ["preflight only", { PREFLIGHT_ONLY: "true" }, undefined],
  ];
  for (const [name, inputs, stable] of cases) {
    const { status, outputs } = await pick(inputs);
    if (status !== 0) fail(`${name}: pick step failed`);
    if (outputs.stable !== stable) fail(`${name}: stable=${outputs.stable}, expected ${stable}`);
    const tagsLatest = outputs.build === "true" && outputs.stable === "true";
    console.log(`ok  ${name}: build=${outputs.build} stable=${outputs.stable} -> ${tagsLatest ? "tags :latest" : "no :latest"}`);
  }
  process.stdout.write("MCP image :latest regression passed: only stable package_version builds tag :latest.\n");
} finally {
  await rm(dir, { recursive: true, force: true });
}
