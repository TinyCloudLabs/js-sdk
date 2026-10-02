---
"@tinycloud/node-sdk": patch
---

TC-540: restoring a persisted session whose signed ReCap carries caveats no longer fails with "Verified persisted session ReCap contains invalid caveats". The WASM verifier returns caveat objects as `Map`s and JSON `null` as `undefined`; node-sdk now converts exactly those back to JSON (string-keyed `Map`s to plain objects, `undefined` to `null`, recursively) where verifier output enters the SDK (persisted-session restore and the caveat-preserving ReCap parser). Any other non-JSON caveat value is still rejected.
