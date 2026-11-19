import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliNameFor } from "./cli-name.js";

// TC-3278: the command that hints and Next: lines name. Under npx, neither `tc` nor `tinycloud` is on the PATH,
// so naming the bin would send the reader to a command that does not exist (or, for `tc`, to Ubuntu's iproute2).
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The folder layout npx makes: `<root>/_npx/<hash>/node_modules/.bin/tc` next to `node_modules/@tinycloud/cli`. */
function npxLayout(version: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "tc-cli-name-"));
  made.push(root);
  const modules = join(root, ".npm", "_npx", "abc123", "node_modules");
  mkdirSync(join(modules, ".bin"), { recursive: true });
  if (version !== null) {
    mkdirSync(join(modules, "@tinycloud", "cli"), { recursive: true });
    writeFileSync(join(modules, "@tinycloud", "cli", "package.json"), JSON.stringify({ name: "@tinycloud/cli", version }));
  }
  return join(modules, ".bin", "tc");
}

describe("cliNameFor", () => {
  test("a global install names the bin that was run", () => {
    expect(cliNameFor("/home/me/.local/bin/tinycloud", {})).toBe("tinycloud");
    expect(cliNameFor("/home/me/.local/bin/tc", {})).toBe("tc");
  });

  test("another host process gets tc", () => {
    expect(cliNameFor("/usr/bin/node", {})).toBe("tc");
    expect(cliNameFor("", {})).toBe("tc");
  });

  test("under npx the name is the npx command, pinned to the version that is running", () => {
    const bin = npxLayout("1.8.0");
    expect(cliNameFor(bin, { npm_command: "exec" })).toBe("npx -y @tinycloud/cli@1.8.0");
  });

  test("a prerelease version is kept whole", () => {
    const bin = npxLayout("1.8.0-beta.9");
    expect(cliNameFor(bin, { npm_command: "exec" })).toBe("npx -y @tinycloud/cli@1.8.0-beta.9");
  });

  test("when the CLI's version cannot be read, the name is the bin's, as for any other host process", () => {
    const bin = npxLayout(null);
    expect(cliNameFor(bin, { npm_command: "exec" })).toBe("tc");
  });

  test("a version that is not a plain version string is not echoed", () => {
    const bin = npxLayout("1.0.0; rm -rf /");
    expect(cliNameFor(bin, { npm_command: "exec" })).toBe("tc");
  });

  test("the CLI's own bin rewrites argv[1] to its real path inside the package; the version is read from there", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-cli-name-"));
    made.push(root);
    const pkg = join(root, ".npm", "_npx", "abc123", "node_modules", "@tinycloud", "cli");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@tinycloud/cli", version: "1.6.6" }));
    expect(cliNameFor(join(pkg, "bin", "tinycloud"), { npm_command: "exec" })).toBe("npx -y @tinycloud/cli@1.6.6");
  });

  test("a package.json that is not the CLI's is not used for the pin", () => {
    const root = mkdtempSync(join(tmpdir(), "tc-cli-name-"));
    made.push(root);
    const pkg = join(root, ".npm", "_npx", "abc123", "node_modules", "other");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "other", version: "6.6.6" }));
    expect(cliNameFor(join(pkg, "bin", "tinycloud"), { npm_command: "exec" })).toBe("tinycloud");
  });

  test("the npx cache path alone is not enough: npm must say it is exec", () => {
    const bin = npxLayout("1.8.0");
    expect(cliNameFor(bin, {})).toBe("tc");
    expect(cliNameFor(bin, { npm_command: "run-script" })).toBe("tc");
  });

  test("npm exec outside the npx cache is not npx", () => {
    expect(cliNameFor("/home/me/project/node_modules/.bin/tinycloud", { npm_command: "exec" })).toBe("tinycloud");
  });
});
