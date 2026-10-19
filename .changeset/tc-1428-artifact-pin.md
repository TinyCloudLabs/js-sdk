---
"@tinycloud/share-envelope": minor
"@tinycloud/share-sdk": minor
"@tinycloud/cli": minor
---

Owner-signed artifact pin for addressed shares (TC-1428). The Policy/v3 envelope gains an optional `artifactPin` field (artifact id, version, sha256 of the version's `manifest.json`, and the sha256 and size of the stored ciphertext file the share reads). It is covered by the envelope signature, so the existing envelope version and the node are unchanged (the node reads the envelope as opaque JSON). `share-sdk` adds a small verification module (`verifyArtifactShare`, `assertArtifactBinding`, `verifyArtifactFileBytes`, `verifyArtifactManifestBytes`, `buildArtifactPin`): a share that reads `artifacts/` without a pin that matches its content source is refused, a pinned share cannot grant edit, and fetched bytes that do not hash to the pinned digest are refused before any decrypt request. `inspectShare` reports `artifact: { id, version }`. `share publish --artifact` signs the pin for addressed shares.

Breaking for old viewers: the envelope schema is strict, so a viewer that predates this release rejects an envelope with `artifactPin` rather than showing it. Update the viewer's `@tinycloud/share-sdk` before publishing pinned addressed shares. The owner is the trusted signer; the node has no write-once ACL, so an owner can still overwrite a version file and recipients then fail closed. Bearer artifact shares have no envelope and carry no pin yet.
