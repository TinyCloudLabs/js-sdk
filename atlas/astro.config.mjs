// astro.config.mjs
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import mdx from '@astrojs/mdx';

// Output is built to ../docs/atlas/ so GitHub Pages can serve from /docs.
// site + base set up so that all internal links resolve as
// https://tinycloudlabs.github.io/js-sdk/atlas/...
export default defineConfig({
  site: 'https://tinycloudlabs.github.io',
  base: '/js-sdk/atlas',
  outDir: '../docs/atlas',
  integrations: [react(), mdx()],
  build: {
    // Copy public/data/*.json files into docs/atlas/data/ so they're
    // curl-able at /js-sdk/atlas/data/inventory.json etc.
    assets: '_assets',
  },
  vite: {
    server: { fs: { allow: ['..'] } },
  },
});
