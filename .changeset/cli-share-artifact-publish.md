---
"@tinycloud/cli": patch
---

`share publish`: `.jsx` and `.tsx` files are published as `text/jsx` and `text/tsx` instead of `application/octet-stream`. `--to anyone --action edit` now exits 2 with `INVALID_ARGUMENT` instead of silently publishing a read-only link. `--json --reveal-link` adds the complete link to the JSON as `url`; `--json` alone still omits it. The tc-cli skill documents publishing Markdown, single-file HTML and JSX artifacts.
