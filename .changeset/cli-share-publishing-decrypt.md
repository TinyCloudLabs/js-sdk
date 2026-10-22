---
"@tinycloud/cli": patch
---

`tc enable share` and `tc auth login --device --manifest builtin:share-publishing` no longer request decrypt on the device login. Publishing a share to an addressed recipient asks for a one-hour decrypt approval when the session does not already hold decrypt. Device login refuses manifests that request encryption or secrets with `DEVICE_AUTH_UNSUPPORTED_SCOPE`; those manifests should use browser or `--paste` login. Details: TC-1778
