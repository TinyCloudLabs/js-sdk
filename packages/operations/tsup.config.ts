import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/state.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  external: [
    '@tinycloud/node-sdk',
    '@tinycloud/sdk-core',
    'zod',
    'zod-to-json-schema',
  ],
});
