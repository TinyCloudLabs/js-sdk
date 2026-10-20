# HTML folder bundling (`@tinycloud/share-sdk/html-bundle`)

The rewriter that turns a folder (a root `index.html` and the files it uses) into pages that are self-contained (defined below). It is the source of truth for what an HTML artifact folder may contain. Consumers: `tc share publish ./site/` (one self-contained `.html`, published over the bearer path) and the Share web composer (folder detection and path rules).

It is a subpath, not part of the package root, so browser bundles that import `@tinycloud/share-sdk` do not carry it.

## What "self-contained" means

At render time the page fetches nothing and offers no navigation: the only references left in it are `data:` URLs the rewriter wrote and `#fragment`s within the page. External URLs, links to other pages and links out are refused, not rewritten. This is checked, not assumed: after rewriting, the produced HTML is parsed again and refused if any URL-bearing attribute, CSS `url()` or `@import` holds anything but a `data:` URL or a `#fragment`. It is not a claim about what the page's own script does: scripts are scanned for a list of blocked capabilities, and the viewer's sandbox and CSP are what stop the rest.

## API

- `prepareHtmlArtifact(files, { parseHtml?, singlePage? })`: every `.html` page of the bundle, rewritten. `files` are `{ path, bytes, mediaType? }` with `/`-separated paths relative to the folder. Without `parseHtml` the browser's `DOMParser` is used; elsewhere pass an HTML5 parser (the CLI passes jsdom's, built on parse5, so the rewriter sees the tree a browser builds). `singlePage: true` transforms only `index.html` and refuses links to other pages.
- `inlineHtmlFolder(files, { parseHtml? })`: `prepareHtmlArtifact` with `singlePage`, returned as `{ html, passive, fileCount, sourceBytes }`.
- `canonicalArtifactPath`, `resolveArtifactReference`, `detectHtmlArtifact`, `artifactMediaType`, and the limits (`MAX_ARTIFACT_*`).
- `ArtifactBundleError { kind: "malformed" | "missing" | "unsupported" | "limit", path?, reference? }`. `path` is the bundle file being processed and `reference` the reference text that was refused; both are untrusted text from the folder, so escape them before printing.

## Rules (anything else is refused, never passed through)

- Every reference is resolved inside the folder: no `../` out of it, no absolute or protocol-relative URL, no scheme (`http:`, `data:`, `javascript:`, `mailto:`), no backslash, no percent-encoded `/`, `\` or `.`, no control or direction-changing code point. Names are NFC-normalized; two names equal after lowercasing collide; lookups are case-sensitive. A query string or fragment on a reference is ignored for the lookup.
- Inlined: `<link rel=stylesheet>` (with `media`), `<link rel=icon>`, `<style>`, `style=""`, CSS `@import` and `url()` (bounded depth, cycles refused), classic `<script src>`, `img`/`source`/`video`/`audio`/`track`/`input[type=image]` sources, `poster`, `srcset`.
- Refused: `<noscript>` (a parser with scripting off and the viewer's frame read it differently), `<area href>`, any `ping` attribute, a `<link>` without `href`, `<base>`, `<form>`, `<iframe>`, `<frame>`, `<frameset>`, `<object>`, `<embed>`, `<portal>`, event-handler attributes, module/`async`/`defer` scripts, scripts that call `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, workers, `sendBeacon`, `window.open`, `location`, dynamic `import()`, `eval`, `WebAssembly`; any `<link rel>` other than stylesheet and icon (`preload`, `prefetch`, `preconnect`, ...); inline SVG elements with an `href` / `xlink:href` that is not a `#fragment`, SVG animation of an `href`, SVG attributes (`fill`, `filter`, `mask`, `style`, ...) with a `url()` that is not a `#fragment`; CSS `image-set()`, `src()` and an `@import` that is not inlined; CSS backslash escapes in `url`, `@import`, `image-set` and `src` are decoded before this is checked; a link to anything but a page in the folder (and, with `singlePage`, to any other page).
- `<template>` content (including declarative shadow roots) is examined and rewritten like the rest of the page.
- Dropped: `<meta http-equiv=refresh>` and an author `<meta http-equiv=Content-Security-Policy>`. The output carries its own strict CSP meta.
- Limits: 1,000 files, 100 MiB of source, 10 MiB per inlined resource and for the rendered output, 5 MiB per text file, 2,000 references, CSS import depth 16. The inlined bytes are counted per reference, against the 10 MiB output cap, as they are added: a page that refers to one large file many times is refused at the reference that passes the cap (`limit`), before the copy is built.
- An SVG file referenced from `<img>` or CSS becomes an `image/svg+xml` data URL: it is an image there, so its own scripts and external references do not run or load.

## Passive files (the extension point for artifact-to-app, T8)

`manifest.json` at the root and anything under `knowledge/` (case-insensitive, by canonical path) are passive: `inlineHtmlFolder` never inlines them, never lets the page reference one (the reference is refused as missing), does not parse them, and returns them unchanged and sorted in `passive`. They still count against the file and source limits. The function only separates them; a publisher that can store sidecar files next to the page takes `passive` from the result. `tc share publish` has no sidecar transport yet: it names them on stderr and does not publish them.

## CLI notes

The CLI reads the folder itself: symbolic links and special files are refused (never followed or read), entries starting with `.` are skipped and reported, nesting deeper than 16 folders is refused, and a file is read through a descriptor opened without following links, bounded by the byte limit, and tied to its path afterwards: the path must resolve to itself inside the folder's real path (no link in any parent directory) and be the very file that was opened, so a subfolder swapped for a link while the folder is read cannot get an outside file read. Hard links to outside files are indistinguishable from files and are read. Echoed paths and references are escaped (`\u{..}`) and clipped.

A folder is published only to an anyone-with-the-link target. For an addressed target, `--prefix`, or a folder next to other inputs the CLI refuses with `MAX_BYTES_EXCEEDED` (exit 7, the code a directory has always had) and a message that says folders need `--to anyone`.
