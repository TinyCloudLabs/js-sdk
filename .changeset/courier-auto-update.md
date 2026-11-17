---
"@tinycloud/courier": minor
---

The standalone `courier` command now updates itself. When it starts (including a `courier watch` restart), at most once every 24 hours per install, it reads npm's `latest` dist-tag; if that is a stable release newer than the running one, it installs it with the package manager and in the place that installed the running copy (npm, pnpm, yarn classic or bun; a global install or an app directory), then runs the same command on the new version. It never downgrades and never follows `beta`, `next` or a prerelease on `latest`.

Before switching it checks the downloaded tarball against the registry's sha512 `dist.integrity`, requires an npm provenance attestation that names that tarball and the `TinyCloudLabs/js-sdk` repository, and runs `npm audit signatures` on a staged install. A release that fails a check, or has no provenance, is not installed. A skip is one line on stderr and never fails the command: registry unreachable (3 s timeout), no write permission to the install, under CI, or a woken agent's own `courier` calls (they now carry `COURIER_WAKE_CHILD=1`). Set `COURIER_NO_AUTO_UPDATE=1` or pass `--no-auto-update` to pin the version; `tinycloud courier` is not affected. Details are in the README's "Updates" section.

Details: TC-3160
