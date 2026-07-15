import { defineConfig } from 'tsup';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: ['src/index.ts', 'src/state.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  external: [
    '@tinycloud/node-sdk',
    'zod',
    'zod-to-json-schema',
  ],
  noExternal: ['@tinycloud/sdk-core/policy'],
  // Keep the source import on sdk-core's supported policy boundary, but bundle
  // only its canonicalizer implementation. This avoids loading sdk-core's
  // broader CJS entrypoint (and its ESM-only multiformats subpaths).
  esbuildOptions(options) {
    options.alias = {
      ...options.alias,
      '@tinycloud/sdk-core/policy': resolve(
        packageDirectory,
        '../sdk-core/src/policy/jcs.ts',
      ),
    };
  },
});
