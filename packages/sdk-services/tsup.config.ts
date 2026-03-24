import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/kv/index.ts', 'src/sql/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  // Externalize all dependencies — don't bundle them into the output
  external: [
    'zod',
  ],
});
