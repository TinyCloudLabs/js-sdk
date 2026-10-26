---
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
---

The settings panel's background reads only go out when the session holds the ability they need. The account index read, the delegation query (account space, then the session's own space) and the storage status read are each checked against the session's ReCap first; a read the session cannot make is not sent and shows as unavailable or needing permission. An account read refused with 401 or 403 is not retried; other failures keep their single retry. `DelegationManager.query` takes an optional second argument `{ spaces }` that sets which spaces the query is signed for. Sessions that hold the abilities make the same requests as before.

Details: TC-2038
