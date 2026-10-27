import { defineConfig } from "tsup";
import type { Plugin } from "esbuild";

// DelegationManager loads ./issued with a dynamic import. In the build that import names the package's own
// `./delegations/issued` export, so every entry that carries the manager loads the same separate file and a
// bundler downstream can keep it out of its root chunk. Source and tests keep the relative path.
const ISSUED_SPECIFIER = "@tinycloud/sdk-core/delegations/issued";
const lazyIssued: Plugin = {
  name: "lazy-issued-delegations",
  setup(build) {
    build.onResolve({ filter: /^\.\/issued$/ }, (args) =>
      args.kind === "dynamic-import" && /[\\/]DelegationManager\.ts$/.test(args.importer)
        ? { path: ISSUED_SPECIFIER, external: true }
        : undefined,
    );
  },
};

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/bootstrap/index.ts",
    "src/policy/index.ts",
    "src/requester/index.ts",
    "src/delegations/index.ts",
    "src/delegations/issued.ts",
    "src/held-credentials/index.ts",
    "src/kv-list-matching/index.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  esbuildPlugins: [lazyIssued],
  // Resolve bundled deps' package.json "exports"/"browser" conditions as a
  // browser platform would. Node 20+ ships a global WebCrypto (globalThis.crypto),
  // so the browser-conditioned code these packages ship also runs correctly under
  // Node — this is what lets us drop the Node-only variants (which pull in
  // crypto-browserify/vm-browserify downstream) without a platform split.
  platform: "browser",
  // Externalize all dependencies — don't bundle them into the output
  external: [
    "@multiformats/multiaddr",
    "@multiformats/multiaddr-to-uri",
    "@multiformats/uri-to-multiaddr",
    "@noble/curves/ed25519",
    "@noble/curves/secp256k1",
    "@noble/hashes/sha3",
    "@noble/hashes/sha256",
    "@noble/hashes/sha512",
    "@tinycloud/bootstrap",
    "@tinycloud/sdk-services",
    "ms",
    "siwe",
    "viem",
    "zod",
    "zod-to-json-schema",
  ],
  // multiformats is ESM-only. Bundle every reached subpath so the published
  // CommonJS entrypoints do not emit unsupported require() calls for cid,
  // hashes/digest, or basics.
  noExternal: [
    "multiformats",
    "@multiformats/multiaddr",
    "@multiformats/multiaddr-to-uri",
    "@multiformats/uri-to-multiaddr",
  ],
});
