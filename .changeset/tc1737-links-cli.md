---
"@tinycloud/cli": minor
---

`tc share` creates and reads `v=4` links.

- An addressed share of 120 seconds to 30 days gets a short link from the links API, created with a header signed by the publishing profile's key; the content key stays in the link's fragment and is never sent to the API. Any other lifetime gets the full link, and past 30 days the CLI prints a warning on stderr and `--json` adds `linkNotice`. If the API refuses a request or cannot be reached, the publish still succeeds with the full link and a notice (stderr and `linkNotice`).
- `--full-link` prints the full link. The `--long-link` flag is removed, and `shortLinkError` in `--json` is `linkNotice`.
- One limit for every link: 64 KiB of sealed envelope. The CLI computes the largest the envelope can be before it writes anything (location record, upload, policy registration). A share over the limit stops with `MAX_BYTES_EXCEEDED` (exit 7) and no link of either form is made. If the sealed envelope is over the limit after the policy is registered, the CLI revokes the owner roots, deletes the uploaded file and names what cannot be removed.
- `tc share unlink <id>` deletes a share's short link with a request signed by the publishing key. `tc share revoke <id>` revokes the share only; its JSON no longer has a `shortLink` field.
- Sender history keeps the link text the publish printed, and `tc share show <id> --reveal-link` prints it. The `.short-link.json` records in the owner's space are no longer read or written; existing ones are left in place.
- `tc share receive` and `tc share inspect` read short and full `v=4` links. `#v=3` and inline `#v=2` links are not accepted.
- Invitation emails carry only a short link. `--notify` and `tc share notify` stop with `UNAVAILABLE`, before publishing or sending anything, until the services that send the emails accept short links.

Links made by CLI 1.3.x and inline links stop opening when the Share viewer deploys. Do not release before the deploy window for the links API, witness, node and Share web.

Details: TC-1737
