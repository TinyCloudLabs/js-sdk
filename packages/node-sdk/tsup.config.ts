import { defineConfig } from 'tsup';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    core: 'src/core.ts',
    'encryption-keys': 'src/encryption-keys.ts',
    'space-hosting': 'src/space-hosting.ts',
    'credential-pending-store': 'src/credential-pending-store.ts',
    credentials: 'src/credentials/index.ts',
    'credentials-core': 'src/credentials/core.ts',
    'share-receive': 'src/share-receive.ts',
    'share-publish': 'src/share-publish.ts',
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
    './space-hosting.js',
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
  esbuildPlugins: [{
    // NodeUserAuthorization lives one directory down; both loaders share the one dist file.
    name: 'lazy-space-hosting',
    setup(build) {
      build.onResolve({ filter: /^\.\.\/space-hosting\.js$/ }, () => ({ path: './space-hosting.js', external: true }));
    },
  }],
  async onSuccess() {
    // tsup preserves these external dynamic imports in both formats. Point CJS
    // entrypoints at the CJS subpath so they share its exports.
    for (const entry of ['index.cjs', 'core.cjs']) {
      const path = fileURLToPath(new URL(`./dist/${entry}`, import.meta.url));
      let source = await readFile(path, 'utf8');
      for (const lazy of ['encryption-keys', 'space-hosting']) {
        const esmImport = `import("./${lazy}.js")`;
        if (!source.includes(esmImport)) throw new Error(`${entry} has no ${lazy} import`);
        source = source.replaceAll(esmImport, `import("./${lazy}.cjs")`);
      }
      await writeFile(path, source);
    }
  },
});
