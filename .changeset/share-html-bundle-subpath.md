---
"@tinycloud/share-sdk": minor
---

New subpath `@tinycloud/share-sdk/html-bundle`: the HTML folder rewriter the Share viewer carries (`prepareHtmlArtifact`, `canonicalArtifactPath`, `detectHtmlArtifact`, ...), moved here so the Share app and `tc share publish ./site/` use one implementation. Additive: the package root does not re-export it, so browser bundles that import the root do not grow.

Changes against the viewer's reviewed `bundle.ts`, all stricter or additive: `prepareHtmlArtifact(files, { parseHtml, singlePage })` (`parseHtml` supplies the HTML5 parser outside a browser; `singlePage` transforms only `index.html` and refuses links to other pages); an `ArtifactBundleError` now carries `path` and `reference` (untrusted text: escape before printing); inline SVG elements whose `href` / `xlink:href` is not a same-document `#fragment` are refused; the module-script check reads the `type` attribute so it behaves the same in every DOM. New: `inlineHtmlFolder(files)` inlines a folder into one self-contained document, and `isPassiveArtifactPath` / `InlinedHtmlFolder.passive` keep `manifest.json` and `knowledge/**` out of the page and return them untouched (the extension point for publishing an app manifest and knowledge bundle as sidecars).
