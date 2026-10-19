---
"@tinycloud/replica": patch
---

Guard the published tarball: a pack check (`scripts/check-pack-exports.ts`, run in CI) fails when any `exports` target (`types`, `import`, `require`) is missing from `npm pack`. 0.2.3 shipped without `dist/browser.d.ts`, leaving `@tinycloud/replica/browser` untyped; the build no longer lets one tsup config's `clean` race another config's declaration output (the build script cleans `dist` once).
