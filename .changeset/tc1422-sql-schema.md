---
"@tinycloud/cli": patch
---

`tinycloud auth request --preset apps-agent --write --app xyz.tinycloud.sample.healthlog` now also grants `tinycloud.sql/schema` on that app's catalog database (exact path `xyz.tinycloud.sample.healthlog/healthlog`, no trailing slash), so the agent can create, change and drop its tables. CREATE, ALTER and DROP need `tinycloud.sql/schema`, which SQL write alone does not carry; nodes before 1.21.6 do not enforce that split. Other apps get no schema grant, and the scope notice says so. Details: TC-1422
