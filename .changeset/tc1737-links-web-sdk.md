---
"@tinycloud/web-sdk": patch
---

The root, `credentials` and `replica` bundles do not carry the share links reader. `@tinycloud/share-envelope/links` is a package import that the bundles load with `import()` the first time a share link is resolved or published; it resolves to the installed `@tinycloud/share-envelope` dependency (`dist/links.js`). The CommonJS bundle sets `output.environment.dynamicImport` so that import is a real `import()` there too.

A test bundles the web-sdk root and the share-sdk entries it can reach and checks that every import of the links module is a dynamic one.

Details: TC-1737
