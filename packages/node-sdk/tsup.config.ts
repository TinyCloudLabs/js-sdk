import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/core.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  // Externalize workspace packages and node_modules
  external: [
    '@tinycloud/sdk-core',
    '@tinycloud/sdk-services',
    '@tinycloud/node-sdk-wasm',
    '@tinycloud/replica',
    '@tinycloud/replica/sqlite',
    'siwe',
    'events',
    'fs',
    'path',
  ],
});
