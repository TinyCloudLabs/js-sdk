import { defineConfig } from 'tsup';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: ['src/index.ts', 'src/state.ts', 'src/cli-runtime.ts', 'src/profile.ts'],
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
  noExternal: ['@tinycloud/sdk-core/policy', '@tinycloud/sdk-core'],
  // Keep source imports on supported sdk-core boundaries while bundling only
  // the policy canonicalizer and capability-subset implementation. This avoids
  // loading sdk-core's broader CJS entrypoint (and its ESM-only subpaths).
  esbuildOptions(options) {
    options.alias = {
      ...options.alias,
      '@tinycloud/sdk-core/policy': resolve(
        packageDirectory,
        '../sdk-core/src/policy/jcs.ts',
      ),
      '@tinycloud/sdk-core': resolve(
        packageDirectory,
        '../sdk-core/src/capabilities.ts',
      ),
    };
  },
});
