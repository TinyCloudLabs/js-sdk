---
"@tinycloud/node-sdk": patch
---

Account bootstrap signs two sessions, one for the account space and one for the secrets space, and each carries only what its steps write: the account registry keys, the completion marker, the account index database and network creation for the account space; the `secret_records` schema for the secrets space. Each session lasts 10 minutes, is installed only while the bootstrap steps and the completion marker run, and is removed when they finish or fail. App invocations are signed only by the grants the app's manifest session covers. The other four bootstrap spaces are still hosted by their wallet-signed host steps.

Details: TC-2038
