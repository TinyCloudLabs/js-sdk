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

// Publication and share placement are opt-in. Shared helpers use the root's validation-error
// constructors, not another bundled copy. Source imports stay relative for tests and DTS.
const publicationCoreRoot: Plugin = {
  name: "publication-core-root",
  setup(build) {
    build.onResolve({ filter: /^\.\/(registry-publication|share-placement)-helpers$/ }, (args) =>
      args.kind === "import-statement" && /[\\/](registry-publication|share-placement)\.ts$/.test(args.importer)
        ? { path: "@tinycloud/sdk-core", external: true }
        : undefined,
    );
  },
};

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/share-placement.ts",
    "src/bootstrap/index.ts",
    "src/policy/index.ts",
    "src/requester/index.ts",
    "src/delegations/index.ts",
    "src/delegations/issued.ts",
    "src/delegations/renewal.ts",
    "src/held-credentials/index.ts",
    "src/kv-list-matching/index.ts",
    "src/registry-publication.ts",
    "src/registry-verdict-cache.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  esbuildPlugins: [lazyIssued, publicationCoreRoot],
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
