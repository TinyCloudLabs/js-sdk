import { defineConfig } from 'tsup';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    core: 'src/core.ts',
    'encryption-keys': 'src/encryption-keys.ts',
    'credential-pending-store': 'src/credential-pending-store.ts',
    credentials: 'src/credentials/index.ts',
    'credentials-core': 'src/credentials/core.ts',
    'share-receive': 'src/share-receive.ts',
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
  async onSuccess() {
    // tsup preserves this external dynamic import in both formats. Point CJS
    // entrypoints at the CJS subpath so they share its exported error class.
    for (const entry of ['index.cjs', 'core.cjs']) {
      const path = fileURLToPath(new URL(`./dist/${entry}`, import.meta.url));
      const source = await readFile(path, 'utf8');
      const esmImport = 'import("./encryption-keys.js")';
      if (!source.includes(esmImport)) throw new Error(`${entry} has no named-key import`);
      await writeFile(path, source.replaceAll(esmImport, 'import("./encryption-keys.cjs")'));
    }
  },
});
