---
"@tinycloud/cli": minor
---

The CLI now tells you when you sign in with an OpenKey key that is not your account's primary key (TC-705). An OpenKey account can hold several keys, and each key is a separate owner with its own spaces and data.

- **Record.** After a verified OpenKey login (browser, paste or device), the profile records OpenKey's `primary` flag as `ownerKeyPrimary`. `tc auth status` shows it as `Primary Key` (JSON `ownerKeyPrimary`, `null` when OpenKey did not say). A re-login replaces it, and it is only recorded beside a verified owner. It is unsigned metadata, never authority.
- **Warn.** A login approved by another key succeeds, but prints a warning on stderr that names the owner and explains that its data is separate. stdout and JSON output are unchanged. OpenKey deployments that do not report the flag produce no warning.
- **`--owner` on plain login.** `tc auth login --owner <did>` no longer requires `--manifest`. It asks OpenKey for the same default abilities on that owner's `default` space, so OpenKey preselects that key, and an approval by any other identity is still refused with `OPENKEY_OWNER_MISMATCH`.
