import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ResolvedSut } from "../src/contracts/lifecycle";
import { exportSutArtifacts } from "../runtime";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("runtime SUT artifact export", () => {
  test("copies the SDK entry when S2 supplies it as a file URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc893-runtime-export-"));
    roots.push(root);
    const source = join(root, "source");
    const output = join(root, "output");
    await mkdir(source, { recursive: true });
    const cliPackage = join(source, "cli-package.json");
    const cliEntry = join(source, "cli-entry.js");
    const sdkPackage = join(source, "sdk-package.json");
    const sdkEntry = join(source, "sdk-entry.js");
    await Promise.all([
      writeFile(cliPackage, "{}"), writeFile(cliEntry, "export const cli = true;"),
      writeFile(sdkPackage, "{}"), writeFile(sdkEntry, "export const sdk = true;"),
    ]);
    const sut = {
      source: "workspace", root, cli: { version: "1.0.0", packageJson: cliPackage, entry: cliEntry },
      nodeSdk: { version: "1.0.0", packageJson: sdkPackage, entry: pathToFileURL(sdkEntry).href, condition: "import" },
    } as ResolvedSut;

    await exportSutArtifacts(output, sut);

    expect(await readFile(join(output, "sut/node-sdk/entry.js"), "utf8")).toBe("export const sdk = true;");
  });
});
