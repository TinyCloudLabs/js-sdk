---
"@tinycloud/cli": patch
---

`tinycloud auth request --preset apps-agent --write --app xyz.tinycloud.sample.healthlog` now also grants `tinycloud.sql/schema` on that app's catalog database (exact path `xyz.tinycloud.sample.healthlog/healthlog`, no trailing slash), so the agent can create, change and drop its tables. The node refuses CREATE, ALTER and DROP under `sql/write` alone. Other apps get no schema grant, and the scope notice says so. Details: TC-1422
