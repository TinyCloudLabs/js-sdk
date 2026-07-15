import { defineConfig } from "tsup";

const canonicalDecryptTransportError =
  "@tinycloud/sdk-services/internal/decrypt-transport-response-error";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "kv/index": "src/kv/index.ts",
    "sql/index": "src/sql/index.ts",
    "encryption/index": "src/encryption/index.ts",
    "internal/decrypt-transport-response-error":
      "src/encryption/DecryptTransportResponseError.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  // The public entrypoints share this one CJS module. Node's CJS cache is
  // common to require() and import(), so the error retains normal identity
  // across root and `/encryption` in both module systems.
  external: ["zod", canonicalDecryptTransportError],
});
