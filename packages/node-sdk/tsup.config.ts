import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    core: 'src/core.ts',
    'replication/runtime': 'src/replication/runtime.ts',
    'replication/authority': 'src/replication/authority.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  // Externalize workspace packages and node_modules
  external: [
    '@tinycloud/sdk-core',
    '@tinycloud/sdk-services',
    '@tinycloud/sdk-services/kv/replication',
    '@tinycloud/node-sdk-wasm',
    '@tinycloud/replica',
    '@tinycloud/replica/sqlite',
    'siwe',
    'events',
    'fs',
    'path',
    './replication/runtime',
    './replication/authority',
  ],
});
