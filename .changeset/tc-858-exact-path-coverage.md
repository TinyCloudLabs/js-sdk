---
"@tinycloud/cli": patch
"@tinycloud/node-sdk": patch
"@tinycloud/replica": patch
"@tinycloud/sdk-services": patch
"@tinycloud/sdk-core": minor
---

Keep published segment-aware replica selection unchanged while using sdk-core capability containment only for authority. Bare selectors now request get/sync grants for the exact path and slash descendants through the shared public `grantPathsForSelector` helper; root and trailing-slash selectors remain single-path grants. LIST local serving requires complete selection coverage, and nested LIST pending writes force network fallback or cursor restart.
