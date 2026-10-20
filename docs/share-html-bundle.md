# HTML folder bundling (`@tinycloud/share-sdk/html-bundle`)

The rewriter that turns a folder (a root `index.html` and the files it uses) into pages that reference nothing outside themselves. It is the source of truth for what an HTML artifact folder may contain. Consumers: `tc share publish ./site/` (one self-contained `.html`, published over the bearer path) and the Share web composer (folder detection and path rules).

It is a subpath, not part of the package root, so browser bundles that import `@tinycloud/share-sdk` do not carry it.

## API

- `prepareHtmlArtifact(files, { parseHtml?, singlePage? })`: every `.html` page of the bundle, rewritten. `files` are `{ path, bytes, mediaType? }` with `/`-separated paths relative to the folder. Without `parseHtml` the browser's `DOMParser` is used; elsewhere pass an HTML5 parser (the CLI passes jsdom's, built on parse5, so the rewriter sees the tree a browser builds). `singlePage: true` transforms only `index.html` and refuses links to other pages.
- `inlineHtmlFolder(files, { parseHtml? })`: `prepareHtmlArtifact` with `singlePage`, returned as `{ html, passive, fileCount, sourceBytes }`.
- `canonicalArtifactPath`, `resolveArtifactReference`, `detectHtmlArtifact`, `artifactMediaType`, and the limits (`MAX_ARTIFACT_*`).
- `ArtifactBundleError { kind: "malformed" | "missing" | "unsupported" | "limit", path?, reference? }`. `path` is the bundle file being processed and `reference` the reference text that was refused; both are untrusted text from the folder, so escape them before printing.

## Rules (anything else is refused, never passed through)

- Every reference is resolved inside the folder: no `../` out of it, no absolute or protocol-relative URL, no scheme (`http:`, `data:`, `javascript:`, `mailto:`), no backslash, no percent-encoded `/`, `\` or `.`, no control or direction-changing code point. Names are NFC-normalized; two names equal after lowercasing collide; lookups are case-sensitive. A query string or fragment on a reference is ignored for the lookup.
- Inlined: `<link rel=stylesheet>` (with `media`), `<link rel=icon>`, `<style>`, `style=""`, CSS `@import` and `url()` (bounded depth, cycles refused), classic `<script src>`, `img`/`source`/`video`/`audio`/`track`/`input[type=image]` sources, `poster`, `srcset`.
- Refused: `<base>`, `<form>`, `<iframe>`, `<frame>`, `<frameset>`, `<object>`, `<embed>`, `<portal>`, event-handler attributes, module/`async`/`defer` scripts, scripts that call `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, workers, `sendBeacon`, `window.open`, `location`, dynamic `import()`, `eval`, `WebAssembly`; any `<link rel>` other than stylesheet and icon (`preload`, `prefetch`, `preconnect`, ...); inline SVG elements with an `href` / `xlink:href` that is not a `#fragment`; a link to anything but a page in the folder (and, with `singlePage`, to any other page).
- Dropped: `<meta http-equiv=refresh>` and an author `<meta http-equiv=Content-Security-Policy>`. The output carries its own strict CSP meta.
- Limits: 1,000 files, 100 MiB of source, 10 MiB per inlined resource and for the rendered output, 5 MiB per text file, 10,000 references, CSS import depth 16.
- An SVG file referenced from `<img>` or CSS becomes an `image/svg+xml` data URL: it is an image there, so its own scripts and external references do not run or load.

## Passive files (the extension point for artifact-to-app, T8)

`manifest.json` at the root and anything under `knowledge/` (case-insensitive, by canonical path) are passive: `inlineHtmlFolder` never inlines them, never lets the page reference one (the reference is refused as missing), does not parse them, and returns them unchanged and sorted in `passive`. They still count against the file and source limits. The function only separates them; a publisher that can store sidecar files next to the page takes `passive` from the result. `tc share publish` has no sidecar transport yet: it names them on stderr and does not publish them.

## CLI notes

The CLI reads the folder itself: symbolic links and special files are refused (never followed or read), entries starting with `.` are skipped and reported, nesting deeper than 16 folders is refused, and a file is read through a descriptor opened without following links and bounded by the byte limit. Echoed paths and references are escaped (`\u{..}`) and clipped.
