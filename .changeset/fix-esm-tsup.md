---
"@tinycloud/sdk-core": patch
"@tinycloud/sdk-services": patch
---

Fix ESM compatibility by migrating sdk-core and sdk-services from tsc to tsup. Resolves extensionless import errors in Node's strict ESM resolver (e.g. Next.js instrumentation hooks).
