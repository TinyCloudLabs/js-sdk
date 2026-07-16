import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/bootstrap/index.ts",
    "src/policy/index.ts",
    "src/requester/index.ts",
  ],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
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
