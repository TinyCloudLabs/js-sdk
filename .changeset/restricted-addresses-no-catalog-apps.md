---
"@tinycloud/operations": patch
"@tinycloud/mcp": patch
---

The restricted personal-record addresses (`/chatgpt/mcp`, `/claude/mcp`, `/grok/mcp`, `/muse/mcp`) no longer offer or accept a catalog app. They have no SQL or knowledge tools, so nothing there can work with Health Log or Recipes, yet `tinycloud_apps_context` advertised `healthlog` and `recipes` in its `app` description and answered either with an approval request, for example to read and change "your whole Health Log database".

On those addresses the `app` description now reads "Pass one existing personal app id to request its task access together.", and `app: "healthlog"` or `app: "recipes"` returns `INPUT_INVALID` with `details.reason: "catalog_app_unavailable"`, the app's name and its tiny-app link. No approval is requested and the account is not consulted.

`/mcp` is unchanged: same tool list, and catalog apps are approved there as before. On the restricted addresses nothing else in the tool list changes, and the rules text `tinycloud_apps_context` returns is the same.

Details: TC-2416
