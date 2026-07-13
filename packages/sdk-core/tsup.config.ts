import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/bootstrap/index.ts', 'src/policy/index.ts', 'src/requester/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  // Externalize all dependencies — don't bundle them into the output
  external: [
    '@multiformats/multiaddr',
    '@multiformats/multiaddr-to-uri',
    '@multiformats/uri-to-multiaddr',
    '@noble/curves/ed25519',
    '@tinycloud/bootstrap',
    '@tinycloud/sdk-services',
    'multiformats/basics',
    'ms',
    'siwe',
    'viem',
    'zod',
    'zod-to-json-schema',
  ],
});
