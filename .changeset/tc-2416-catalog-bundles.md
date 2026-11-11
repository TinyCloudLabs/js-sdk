---
"@tinycloud/operations": minor
"@tinycloud/mcp": minor
---

The optional personal-app context `app` input accepts `healthlog` and `recipes`. Health Log requests its app-list and database access in one approval, with read-only access when requested. Recipes bundles read access to its notes and requests database reads separately after learning the database name. Tool input descriptions explain `app` and `access`.

Details: TC-2416
