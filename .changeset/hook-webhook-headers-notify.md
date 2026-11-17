---
"@tinycloud/cli": minor
"@tinycloud/sdk-services": minor
---

Webhooks can carry custom headers, so a receiver that needs its own credential (for example a Grok Bot routine webhook's `Authorization: Bearer`) can be woken by an owner's answer or comment. `HooksService.register` takes `headers`, refuses reserved ones (Host, Content-Length, Content-Type, Cookie, `X-TinyCloud-*` and other transport headers) before any request, and `HookWebhookRecord.headerNames` lists names only; values are write-only. `HookEvent` carries optional `responseId` and `cardId`. `tinycloud feed connect` adds `--notify-url`, `--notify-header` and `--notify-header-env`: it registers one webhook on the agent's response database, replaces an earlier one for the same URL, and withdraws the webhook if the node does not confirm the stored header names.

Needs a node that stores and encrypts webhook headers and puts the response and card IDs in the event body.

Details: TC-3123
