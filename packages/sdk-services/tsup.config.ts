import { defineConfig } from "tsup";

const canonicalDecryptTransportError =
  "@tinycloud/sdk-services/internal/decrypt-transport-response-error";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "kv/index": "src/kv/index.ts",
    context: "src/context.ts",
    "telemetry/requestLog": "src/telemetry/requestLog.ts",
    "kv/replication/index": "src/kv/replication/index.ts",
    "kv/replication/prefix": "src/kv/replication/prefix.ts",
    "kv/replication/contractConstants": "src/kv/replication/contractConstants.ts",
    "kv/replication/grantPolicyConstants": "src/kv/replication/grantPolicyConstants.ts",
    "kv/replication/grantPolicyTypes": "src/kv/replication/grantPolicyTypes.ts",
    "kv/replication/grantPolicy": "src/kv/replication/grantPolicy.ts",
    "sql/index": "src/sql/index.ts",
    "feed/index": "src/feed/index.ts",
    "encryption/index": "src/encryption/index.ts",
    "encryption/resource": "src/encryption/resource.ts",
    "encryption/named-keys": "src/encryption/namedKeys.ts",
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
