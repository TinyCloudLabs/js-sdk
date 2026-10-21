---
"@tinycloud/cli": patch
---

Clarify in the agent skill that write access to an app includes its table rows, that creating, changing or dropping tables needs a schema grant that only an app's catalog database gets, and that structural changes are confirmed with the owner first. Details: TC-1422
