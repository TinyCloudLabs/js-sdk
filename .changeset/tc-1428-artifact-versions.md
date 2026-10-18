---
"@tinycloud/share-sdk": minor
"@tinycloud/cli": minor
---

Artifact versions for `share publish` (TC-1428). `share publish --artifact <id|new>` stores the file as a write-once version under `artifacts/<id>/versions/<n>/` (created with `If-None-Match: *`, `manifest.json` written last) in the owner's space and pins the share to that version: bearer and addressed shares read one version file and never carry `put`. The same content returns the same version and changed content makes the next, so an agent retry is safe. `share versions <id>` lists versions and the shares pinned to each. `--action edit` on an artifact share is refused, and `--ongoing` is refused until a later slice. New `share-sdk` exports: `publishArtifactVersion`, `listArtifactVersions`, `parseArtifactManifest` and the layout helpers. No node change.

The built-in `builtin:share-publishing` manifest now also requests `artifacts/` (get, metadata, put, list). Profiles signed in with the older manifest must run `auth login --device --manifest builtin:share-publishing` again before using `--artifact`; other `share publish` use is unchanged. Versions are kept by default and count against the owner's storage; reclaiming bytes depends on history GC (TC-1277).
