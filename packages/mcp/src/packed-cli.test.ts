import { expect, test } from "bun:test";

const packageDirectory = new URL("..", import.meta.url).pathname;

test("packed ESM and CJS CLI entrypoints print the metadata version directly", async () => {
  const metadata = await Bun.file(new URL("../package.json", import.meta.url)).json() as { version: string };
  for (const entrypoint of ["dist/cli.js", "dist/cli.cjs"]) {
    const result = Bun.spawnSync(["node", `${packageDirectory}/${entrypoint}`, "--version"]);
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe(`${metadata.version}\n`);
    expect(new TextDecoder().decode(result.stderr)).toBe("");
  }
});
