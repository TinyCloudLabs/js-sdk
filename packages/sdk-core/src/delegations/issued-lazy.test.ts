import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// The issued-delegation code must stay out of the module that DelegationManager's importers load eagerly.
const MANAGER = fileURLToPath(new URL("./DelegationManager.ts", import.meta.url));
// Text that only the issued-delegation implementation contains.
const ISSUED_ONLY = ["delegation-issued-query-v1", "Listing issued delegations needs a session key signer"];

describe("issued-delegation code is a separate module", () => {
  test("DelegationManager's own bundle holds none of it; it loads from a chunk on first use", async () => {
    const build = await Bun.build({
      entrypoints: [MANAGER],
      target: "browser",
      splitting: true,
      packages: "external",
    });
    expect(build.success).toBe(true);
    const entry = build.outputs.filter((output) => output.kind === "entry-point");
    const chunks = build.outputs.filter((output) => output.kind === "chunk");
    expect(entry).toHaveLength(1);
    expect(chunks.length).toBeGreaterThan(0);
    const entryText = await entry[0].text();
    const chunkText = (await Promise.all(chunks.map((chunk) => chunk.text()))).join("\n");
    for (const text of ISSUED_ONLY) {
      expect(entryText).not.toContain(text);
      expect(chunkText).toContain(text);
    }
  });
});
