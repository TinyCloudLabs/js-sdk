import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    core: 'src/core.ts',
    'encryption-keys': 'src/encryption-keys.ts',
    'credential-pending-store': 'src/credential-pending-store.ts',
    credentials: 'src/credentials/index.ts',
    'credentials-core': 'src/credentials/core.ts',
    'replication/runtime': 'src/replication/runtime.ts',
    'replication/authority': 'src/replication/authority.ts',
    'replication/gated-network': 'src/replication/gated-network.ts',
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
    '@tinycloud/sdk-services/encryption/named-keys',
    './encryption-keys.js',
    '@tinycloud/node-sdk-wasm',
    '@tinycloud/replica',
    '@tinycloud/replica/sqlite',
    'siwe',
    'events',
    'fs',
    'path',
    './replication/runtime',
    './replication/authority',
    './replication/gated-network',
  ],
});
