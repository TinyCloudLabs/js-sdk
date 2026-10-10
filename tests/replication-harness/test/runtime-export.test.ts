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
  test("exports the published lockfile required by leg installs", async () => {
    const root = await mkdtemp(join(tmpdir(), "tc893-runtime-published-"));
    roots.push(root);
    const source = join(root, "source");
    const output = join(root, "output");
    await mkdir(source, { recursive: true });
    const files = ["cli-package.json", "cli-entry.js", "sdk-package.json", "sdk-entry.js", "package.json", "package-lock.json"];
    await Promise.all(files.map((name) => writeFile(join(source, name), name)));
    const sut = {
      source: "published", root: source, lockfileSha256: "a".repeat(64),
      cli: { version: "1.0.0", packageJson: join(source, files[0]!), entry: join(source, files[1]!), integrity: "sha512-cli" },
      nodeSdk: { version: "1.0.0", packageJson: join(source, files[2]!), entry: pathToFileURL(join(source, files[3]!)).href, condition: "import", integrity: "sha512-sdk" },
    } as ResolvedSut;

    await exportSutArtifacts(output, sut);

    expect(await readFile(join(output, "sut/published/package.json"), "utf8")).toBe("package.json");
    expect(await readFile(join(output, "sut/published/package-lock.json"), "utf8")).toBe("package-lock.json");
  });
});
