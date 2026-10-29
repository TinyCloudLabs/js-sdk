---
"@tinycloud/node-sdk": minor
---

Include `siweConfig.resources` metadata URIs in ordinary, external/OpenKey and bootstrap SIWE preparation. The original ReCap stays last and unchanged, and completion retains the exact signed message. Resource values must be absolute URIs without literal controls and must not be ReCap URIs. An absent or empty resource list leaves preparation unchanged.

Details: TC-2230
