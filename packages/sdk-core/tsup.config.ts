import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/bootstrap/index.ts",
    "src/policy/index.ts",
    "src/requester/index.ts",
    "src/delegations/index.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
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
