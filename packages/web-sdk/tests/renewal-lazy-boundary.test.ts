import { describe, expect, it } from "bun:test";
import { build, type Plugin } from "esbuild";
import { resolve } from "node:path";

const RENEWAL = "@tinycloud/sdk-core/delegations/renewal";
const packages = resolve(import.meta.dir, "../..");
const nodeEntry = resolve(packages, "node-sdk/src/TinyCloudNode.ts");

const tinycloudExternals: Plugin = {
  name: "tinycloud-package-externals",
  setup(builder) {
    builder.onResolve({ filter: /^@tinycloud\// }, (args) => ({ path: args.path, external: true }));
  },
};

describe("renewal verification loading boundary", () => {
  it("loads the renewal verifier only through a dynamic package import", async () => {
    const result = await build({
      entryPoints: [nodeEntry],
      bundle: true,
      write: false,
      metafile: true,
      format: "esm",
      platform: "node",
      logLevel: "silent",
      plugins: [tinycloudExternals],
    });
    const imports = Object.values(result.metafile!.outputs)
      .flatMap((output) => output.imports)
      .filter((entry) => entry.path === RENEWAL);

    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((entry) => entry.kind === "dynamic-import")).toBe(true);
  });
});
