# @tinycloud/cli

## 1.5.0-beta.16

### Patch Changes

- Updated dependencies [5d9d314]
  - @tinycloud/node-sdk@3.8.0-beta.11
  - @tinycloud/operations@0.7.7-beta.11

## 1.5.0-beta.15

### Patch Changes

- Updated dependencies [20a872e]
  - @tinycloud/node-sdk@3.8.0-beta.10
  - @tinycloud/operations@0.7.7-beta.10

## 1.5.0-beta.14

### Patch Changes

- Updated dependencies [92e4bd0]
  - @tinycloud/sdk-services@3.8.0-beta.9
  - @tinycloud/node-sdk@3.8.0-beta.9
  - @tinycloud/operations@0.7.7-beta.9
  - @tinycloud/sdk-core@3.8.0-beta.9

## 1.5.0-beta.13

### Minor Changes

- 8398c72: Add `tc secrets run NAME... [--map NAME=ENV_VAR] -- <command> [args...]`: it reads the named secrets as `tc secrets get` does and starts the command directly, without a shell, with the values only in its environment. If a secret cannot be read, the command does not start and tc exits as `get` would. tc exits with the command's exit code or signal, passes SIGINT, SIGTERM, SIGHUP and SIGQUIT on to it (except SIGINT, SIGQUIT and SIGHUP when tc runs in a terminal's foreground, since the terminal sends those to the command already), and exits 127 or 126 when the command isn't found or can't be run. tc doesn't pass its own `TC_PRIVATE_KEY` to the command. The command, and anything it starts, still receives the values and can print or pass them on.

  Details: TC-2093

## 1.5.0-beta.12

### Patch Changes

- @tinycloud/node-sdk@3.8.0-beta.7
- @tinycloud/operations@0.7.7-beta.8

## 1.5.0-beta.11

### Patch Changes

- Updated dependencies [479205d]
  - @tinycloud/node-sdk@3.8.0-beta.6
  - @tinycloud/operations@0.7.7-beta.7

## 1.5.0-beta.10

### Patch Changes

- Updated dependencies [44c439a]
  - @tinycloud/sdk-core@3.8.0-beta.5
  - @tinycloud/node-sdk@3.8.0-beta.5
  - @tinycloud/operations@0.7.7-beta.6

## 1.5.0-beta.9

### Patch Changes

- Updated dependencies [c541786]
  - @tinycloud/sdk-core@3.8.0-beta.4
  - @tinycloud/node-sdk@3.8.0-beta.4
  - @tinycloud/operations@0.7.7-beta.5

## 1.5.0-beta.8

### Patch Changes

- Updated dependencies [1fc87b6]
  - @tinycloud/operations@0.7.7-beta.4

## 1.5.0-beta.7

### Patch Changes

- Updated dependencies [7b22f61]
  - @tinycloud/share-envelope@1.3.1-beta.0
  - @tinycloud/sdk-core@3.8.0-beta.3
  - @tinycloud/share-sdk@1.4.1-beta.0
  - @tinycloud/node-sdk@3.8.0-beta.3
  - @tinycloud/operations@0.7.7-beta.3

## 1.5.0-beta.6

### Patch Changes

- Updated dependencies [4a19c47]
  - @tinycloud/sdk-services@3.8.0-beta.2
  - @tinycloud/sdk-core@3.8.0-beta.2
  - @tinycloud/node-sdk@3.8.0-beta.2
  - @tinycloud/operations@0.7.7-beta.2

## 1.5.0-beta.5

### Patch Changes

- ac50932: Show the account site delegation page when an OpenKey profile cannot complete a CLI revocation.

  Details: TC-2005

## 1.5.0-beta.4

### Patch Changes

- 30da240: Share publishing can create a short link from the signed full policy link when the publish result has no separate delivery material. JSON output keeps link details redacted.

  Details: TC-1737

## 1.5.0-beta.3

### Patch Changes

- Updated dependencies [2789240]
  - @tinycloud/sdk-services@3.8.0-beta.1
  - @tinycloud/sdk-core@3.8.0-beta.1
  - @tinycloud/node-sdk@3.8.0-beta.1
  - @tinycloud/operations@0.7.7-beta.1

## 1.5.0-beta.2

### Minor Changes

- 0f7a069: `tc kv put --if-none-match '*'` creates a key only when it is absent and reports an existing key as a refused write.

  Details: TC-2049

## 1.5.0-beta.1

### Patch Changes

- 90941f8: `tc auth login --method openkey --keys <folder>` works together with replication prefixes: one OpenKey approval covers the replica request and the folder's key row.

  Details: TC-2034

## 1.5.0-beta.0

### Minor Changes

- 15080ed: `tc auth login --keys <folder>` (local-key or OpenKey sign-in) also grants named-key create and decrypt on keys below the folder, and `tc keys ensure|encrypt|decrypt` use them. Node SDK: `additionalRawAbilities` adds top-level resource abilities to the sign-in request.

  Details: TC-2034

### Patch Changes

- Updated dependencies [15080ed]
  - @tinycloud/node-sdk@3.8.0-beta.0
  - @tinycloud/operations@0.7.7-beta.0

## 1.4.0

### Minor Changes

- a0d8b94: `tc share` creates and reads `v=4` links.
  - An addressed share of 120 seconds to 30 days gets a short link from the links API, created with a header signed by the publishing profile's key; the content key stays in the link's fragment and is never sent to the API. Any other lifetime gets the full link, and past 30 days the CLI prints a warning on stderr and `--json` adds `linkNotice`. If the API refuses a request or cannot be reached, the publish still succeeds with the full link and a notice (stderr and `linkNotice`).
  - `--full-link` prints the full link. The `--long-link` flag is removed, and `shortLinkError` in `--json` is `linkNotice`.
  - One limit for every link: 64 KiB of sealed envelope. The CLI computes the largest the envelope can be before it writes anything (location record, upload, policy registration). A share over the limit stops with `MAX_BYTES_EXCEEDED` (exit 7) and no link of either form is made. If the sealed envelope is over the limit after the policy is registered, the CLI revokes the owner roots, deletes the uploaded file and names what cannot be removed.
  - `tc share unlink <id>` deletes a share's short link with a request signed by the publishing key. `tc share revoke <id>` revokes the share only; its JSON no longer has a `shortLink` field.
  - Sender history keeps the link text the publish printed, and `tc share show <id> --reveal-link` prints it. The `.short-link.json` records in the owner's space are no longer read or written; existing ones are left in place.
  - `tc share receive` and `tc share inspect` read short and full `v=4` links. `#v=3` and inline `#v=2` links are not accepted.
  - Invitation emails carry only a short link. `--notify` and `tc share notify` stop with `UNAVAILABLE`, before publishing or sending anything, until the services that send the emails accept short links.

  Links made by CLI 1.3.x and inline links stop opening when the Share viewer deploys. Do not release before the deploy window for the links API, witness, node and Share web.

  Details: TC-1737

### Patch Changes

- Updated dependencies [c142537]
- Updated dependencies [4c3d073]
- Updated dependencies [279c8e9]
- Updated dependencies [71fa087]
- Updated dependencies [60b79d0]
- Updated dependencies [60b79d0]
- Updated dependencies [20bc8d1]
- Updated dependencies [147bb78]
  - @tinycloud/sdk-services@3.7.0
  - @tinycloud/node-sdk@3.7.0
  - @tinycloud/sdk-core@3.7.0
  - @tinycloud/share-envelope@1.3.0
  - @tinycloud/share-sdk@1.4.0
  - @tinycloud/operations@0.7.6

## 1.4.0-beta.4

### Patch Changes

- Updated dependencies [c142537]
- Updated dependencies [4c3d073]
  - @tinycloud/sdk-services@3.7.0-beta.4
  - @tinycloud/node-sdk@3.7.0-beta.4
  - @tinycloud/operations@0.7.6-beta.4
  - @tinycloud/sdk-core@3.7.0-beta.4

## 1.4.0-beta.3

### Patch Changes

- Updated dependencies [279c8e9]
  - @tinycloud/node-sdk@3.7.0-beta.3
  - @tinycloud/sdk-services@3.7.0-beta.3
  - @tinycloud/operations@0.7.6-beta.3
  - @tinycloud/sdk-core@3.7.0-beta.3

## 1.4.0-beta.2

### Patch Changes

- Updated dependencies [147bb78]
  - @tinycloud/node-sdk@3.7.0-beta.2
  - @tinycloud/sdk-services@3.7.0-beta.2
  - @tinycloud/operations@0.7.6-beta.2
  - @tinycloud/sdk-core@3.7.0-beta.2

## 1.4.0-beta.1

### Minor Changes

- a0d8b94: `tc share` creates and reads `v=4` links.
  - An addressed share of 120 seconds to 30 days gets a short link from the links API, created with a header signed by the publishing profile's key; the content key stays in the link's fragment and is never sent to the API. Any other lifetime gets the full link, and past 30 days the CLI prints a warning on stderr and `--json` adds `linkNotice`. If the API refuses a request or cannot be reached, the publish still succeeds with the full link and a notice (stderr and `linkNotice`).
  - `--full-link` prints the full link. The `--long-link` flag is removed, and `shortLinkError` in `--json` is `linkNotice`.
  - One limit for every link: 64 KiB of sealed envelope. The CLI computes the largest the envelope can be before it writes anything (location record, upload, policy registration). A share over the limit stops with `MAX_BYTES_EXCEEDED` (exit 7) and no link of either form is made. If the sealed envelope is over the limit after the policy is registered, the CLI revokes the owner roots, deletes the uploaded file and names what cannot be removed.
  - `tc share unlink <id>` deletes a share's short link with a request signed by the publishing key. `tc share revoke <id>` revokes the share only; its JSON no longer has a `shortLink` field.
  - Sender history keeps the link text the publish printed, and `tc share show <id> --reveal-link` prints it. The `.short-link.json` records in the owner's space are no longer read or written; existing ones are left in place.
  - `tc share receive` and `tc share inspect` read short and full `v=4` links. `#v=3` and inline `#v=2` links are not accepted.
  - Invitation emails carry only a short link. `--notify` and `tc share notify` stop with `UNAVAILABLE`, before publishing or sending anything, until the services that send the emails accept short links.

  Links made by CLI 1.3.x and inline links stop opening when the Share viewer deploys. Do not release before the deploy window for the links API, witness, node and Share web.

  Details: TC-1737

### Patch Changes

- Updated dependencies [71fa087]
- Updated dependencies [60b79d0]
- Updated dependencies [60b79d0]
- Updated dependencies [20bc8d1]
  - @tinycloud/node-sdk@3.7.0-beta.1
  - @tinycloud/sdk-core@3.7.0-beta.1
  - @tinycloud/share-envelope@1.3.0-beta.0
  - @tinycloud/share-sdk@1.4.0-beta.0
  - @tinycloud/operations@0.7.6-beta.1

## 1.3.7-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.6.2-beta.0
- @tinycloud/operations@0.7.6-beta.0

## 1.3.6

### Patch Changes

- 3d814e8: `tc init` and other spinner steps print one plain progress line per step, with no animation, when the terminal reports 0 columns. Terminals with a normal size keep the animated spinner.

  Details: TC-1893

- 09b7dc0: Document that `tinycloud.delegation/revoke` on a space is space-wide, and that the CLI's own fallback asks for 5 minutes and stores nothing. Added to the tc-cli skill docs and the node-sdk README.

  Details: TC-1923

- Updated dependencies [271155a]
- Updated dependencies [09b7dc0]
  - @tinycloud/node-sdk@3.6.1
  - @tinycloud/operations@0.7.5
  - @tinycloud/sdk-core@3.6.1
  - @tinycloud/sdk-services@3.6.1

## 1.3.6-beta.2

### Patch Changes

- 3d814e8: `tc init` and other spinner steps print one plain progress line per step, with no animation, when the terminal reports 0 columns. Terminals with a normal size keep the animated spinner.

  Details: TC-1893

## 1.3.6-beta.1

### Patch Changes

- 09b7dc0: Document that `tinycloud.delegation/revoke` on a space is space-wide, and that the CLI's own fallback asks for 5 minutes and stores nothing. Added to the tc-cli skill docs and the node-sdk README.

  Details: TC-1923

- Updated dependencies [09b7dc0]
  - @tinycloud/node-sdk@3.6.1-beta.1
  - @tinycloud/operations@0.7.5-beta.1

## 1.3.6-beta.0

### Patch Changes

- Updated dependencies [271155a]
  - @tinycloud/node-sdk@3.6.1-beta.0
  - @tinycloud/operations@0.7.5-beta.0

## 1.3.5

### Patch Changes

- 217d82c: A manifest, grant or login permission that carries a limit (any `caveats` other than absent, `[]` or `[{}]`) is refused with `CAVEATS_UNSUPPORTED` (exit 2) before any OpenKey URL, device authorization or request is made. The check uses the same `recapCaveatsEqual` comparison as the SDK.

  Details: TC-1856

- Updated dependencies [e18946e]
- Updated dependencies [e600a1a]
- Updated dependencies [0c09d7b]
- Updated dependencies [82cbd43]
- Updated dependencies [dc61583]
- Updated dependencies [1f831e3]
- Updated dependencies [7bd4ae6]
- Updated dependencies [7bd4ae6]
- Updated dependencies [e32bc41]
- Updated dependencies [c0acb86]
  - @tinycloud/operations@0.7.4
  - @tinycloud/node-sdk@3.6.0
  - @tinycloud/sdk-core@3.6.0
  - @tinycloud/sdk-services@3.6.0

## 1.3.5-beta.9

### Patch Changes

- Updated dependencies [1f831e3]
  - @tinycloud/sdk-core@3.6.0-beta.8
  - @tinycloud/node-sdk@3.6.0-beta.8
  - @tinycloud/operations@0.7.4-beta.8

## 1.3.5-beta.8

### Patch Changes

- Updated dependencies [7bd4ae6]
- Updated dependencies [7bd4ae6]
  - @tinycloud/node-sdk@3.6.0-beta.7
  - @tinycloud/operations@0.7.4-beta.7

## 1.3.5-beta.7

### Patch Changes

- 217d82c: A manifest, grant or login permission that carries a limit (any `caveats` other than absent, `[]` or `[{}]`) is refused with `CAVEATS_UNSUPPORTED` (exit 2) before any OpenKey URL, device authorization or request is made. The check uses the same `recapCaveatsEqual` comparison as the SDK.

  Details: TC-1856

## 1.3.5-beta.6

### Patch Changes

- Updated dependencies [e600a1a]
  - @tinycloud/node-sdk@3.6.0-beta.6
  - @tinycloud/operations@0.7.4-beta.6

## 1.3.5-beta.5

### Patch Changes

- Updated dependencies [c0acb86]
  - @tinycloud/node-sdk@3.6.0-beta.5
  - @tinycloud/operations@0.7.4-beta.5

## 1.3.5-beta.4

### Patch Changes

- Updated dependencies [e32bc41]
  - @tinycloud/sdk-core@3.6.0-beta.4
  - @tinycloud/node-sdk@3.6.0-beta.4
  - @tinycloud/operations@0.7.4-beta.4

## 1.3.5-beta.3

### Patch Changes

- Updated dependencies [82cbd43]
  - @tinycloud/sdk-services@3.6.0-beta.3
  - @tinycloud/operations@0.7.4-beta.3
  - @tinycloud/node-sdk@3.6.0-beta.3
  - @tinycloud/sdk-core@3.6.0-beta.3

## 1.3.5-beta.2

### Patch Changes

- Updated dependencies [e18946e]
  - @tinycloud/operations@0.7.4-beta.2

## 1.3.5-beta.1

### Patch Changes

- Updated dependencies [dc61583]
  - @tinycloud/sdk-services@3.6.0-beta.2
  - @tinycloud/node-sdk@3.6.0-beta.2
  - @tinycloud/operations@0.7.4-beta.1
  - @tinycloud/sdk-core@3.6.0-beta.2

## 1.3.5-beta.0

### Patch Changes

- Updated dependencies [0c09d7b]
  - @tinycloud/sdk-core@3.6.0-beta.0
  - @tinycloud/node-sdk@3.6.0-beta.0
  - @tinycloud/operations@0.7.4-beta.0

## 1.3.4

### Patch Changes

- Updated dependencies [d60f81d]
- Updated dependencies [7b92156]
- Updated dependencies [7b92156]
  - @tinycloud/sdk-services@3.5.0
  - @tinycloud/node-sdk@3.5.0
  - @tinycloud/operations@0.7.3
  - @tinycloud/sdk-core@3.5.0

## 1.3.4-beta.1

### Patch Changes

- Updated dependencies [7b92156]
- Updated dependencies [7b92156]
  - @tinycloud/node-sdk@3.5.0-beta.1
  - @tinycloud/operations@0.7.3-beta.1

## 1.3.4-beta.0

### Patch Changes

- Updated dependencies [d60f81d]
  - @tinycloud/sdk-services@3.5.0-beta.0
  - @tinycloud/node-sdk@3.5.0-beta.0
  - @tinycloud/operations@0.7.3-beta.0
  - @tinycloud/sdk-core@3.5.0-beta.0

## 1.3.3

### Patch Changes

- b8ce8a9: `tc delegation revoke` now asks OpenKey for its one-use revoke authority with a 5-minute lifetime, so that authority expires a few minutes after the revoke instead of lasting OpenKey's default 7 days. Local-key owners get the same bounded lifetime. The command also refuses to request one-use OpenKey authority without an explicit lifetime.

  Details: TC-1785

- Updated dependencies [666f60b]
  - @tinycloud/share-sdk@1.3.0
  - @tinycloud/node-sdk@3.4.0
  - @tinycloud/sdk-core@3.4.0
  - @tinycloud/operations@0.7.2
  - @tinycloud/sdk-services@3.3.2

## 1.3.3-beta.2

### Patch Changes

- Updated dependencies [666f60b]
  - @tinycloud/share-sdk@1.3.0-beta.0
  - @tinycloud/sdk-core@3.3.2-beta.1
  - @tinycloud/node-sdk@3.3.2-beta.1
  - @tinycloud/operations@0.7.2-beta.1

## 1.3.3-beta.1

### Patch Changes

- b8ce8a9: `tc delegation revoke` now asks OpenKey for its one-use revoke authority with a 5-minute lifetime, so that authority expires a few minutes after the revoke instead of lasting OpenKey's default 7 days. Local-key owners get the same bounded lifetime. The command also refuses to request one-use OpenKey authority without an explicit lifetime.

  Details: TC-1785

## 1.3.3-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.3.2-beta.0
- @tinycloud/operations@0.7.2-beta.0

## 1.3.2

### Patch Changes

- ac47cd9: `tc share publish --to email:...` (and other addressed targets) from a sign-in that cannot decrypt with the account's key, such as one made with `builtin:share-publishing`, now stops before any upload, registry write or network call. It exits 5 with `PERMISSION_DENIED`, "this sign-in can't create email-addressed shares: it has no permission to decrypt with the account's key. Nothing was shared.", and a hint to share from share.tinycloud.xyz as the account owner or use `--to anyone`. Previously the file was uploaded first and the command failed later with a generic error. Local-key owners are unchanged.

  `tc share list` now prints a fourth tab-separated column, `status`: `revoked`, `expired` or `active`. Scripts that split rows on tabs will see the extra column. `--json` output is unchanged.

  `tc share receive` and `tc share inspect` now report a share link whose origin is not the trusted Share origin (`--viewer-origin`) as `ORIGIN_MISMATCH` (exit 5) before any request, matching short links. Before, an inline link at another origin was `INVALID_LINK` (exit 2). A link that is not a URL is still `INVALID_LINK`. The SDKs are unchanged.

  Details: TC-1753, TC-1754, TC-1737

- f8c2967: `tc share publish` prints addressed shares as a short link, `https://share.tinycloud.xyz/s/<id>#v=3&k=<key>&c=<cid>`, instead of a link of about 17,000 characters. Share's short-link service stores only the sealed envelope bytes. The read key and the CID of those bytes stay in the link's fragment: the service never receives the key, and `share receive`/`share inspect` refuse bytes that do not hash to the link's CID.
  - `--long-link` prints the long self-contained link instead.
  - If the short-link service is unavailable, publishing still succeeds. The CLI prints the long link and warns that it is long, and `--json` adds `shortLinkError`.
  - That includes refused connections, timeouts (10 seconds per request) and broken answers.
  - When the Share host itself can't be reached, publishing stops before anything is shared with `SHARE_SERVICE_UNAVAILABLE` (exit 4), instead of a message blaming the TinyCloud node.
  - `share show <id> --reveal-link` prints the same short link.
  - `share revoke` deletes the stored envelope after the node confirms the revocation. A failed delete only warns; the envelope expires with the share.
  - Sender history and the `--notify` invitation still carry the long link. Bearer links are unchanged.

  `@tinycloud/share-envelope` adds a `@tinycloud/share-envelope/short-link` subpath export with `parseShortShareUrl`, `splitInlineToShort` and `rebuildInlineFromShort`, tested against the vectors Share's own codec uses. They are not in the package root, so bundles that import the root (such as `@tinycloud/web-sdk`) do not grow. Details: TC-1737

- Updated dependencies [f8c2967]
  - @tinycloud/share-envelope@1.2.1
  - @tinycloud/sdk-core@3.3.1
  - @tinycloud/share-sdk@1.2.1
  - @tinycloud/node-sdk@3.3.1
  - @tinycloud/operations@0.7.1
  - @tinycloud/sdk-services@3.3.1

## 1.3.2-beta.1

### Patch Changes

- ac47cd9: `tc share publish --to email:...` (and other addressed targets) from a sign-in that cannot decrypt with the account's key, such as one made with `builtin:share-publishing`, now stops before any upload, registry write or network call. It exits 5 with `PERMISSION_DENIED`, "this sign-in can't create email-addressed shares: it has no permission to decrypt with the account's key. Nothing was shared.", and a hint to share from share.tinycloud.xyz as the account owner or use `--to anyone`. Previously the file was uploaded first and the command failed later with a generic error. Local-key owners are unchanged.

  `tc share list` now prints a fourth tab-separated column, `status`: `revoked`, `expired` or `active`. Scripts that split rows on tabs will see the extra column. `--json` output is unchanged.

  `tc share receive` and `tc share inspect` now report a share link whose origin is not the trusted Share origin (`--viewer-origin`) as `ORIGIN_MISMATCH` (exit 5) before any request, matching short links. Before, an inline link at another origin was `INVALID_LINK` (exit 2). A link that is not a URL is still `INVALID_LINK`. The SDKs are unchanged.

  Details: TC-1753, TC-1754, TC-1737

## 1.3.2-beta.0

### Patch Changes

- f8c2967: `tc share publish` prints addressed shares as a short link, `https://share.tinycloud.xyz/s/<id>#v=3&k=<key>&c=<cid>`, instead of a link of about 17,000 characters. Share's short-link service stores only the sealed envelope bytes. The read key and the CID of those bytes stay in the link's fragment: the service never receives the key, and `share receive`/`share inspect` refuse bytes that do not hash to the link's CID.
  - `--long-link` prints the long self-contained link instead.
  - If the short-link service is unavailable, publishing still succeeds. The CLI prints the long link and warns that it is long, and `--json` adds `shortLinkError`.
  - That includes refused connections, timeouts (10 seconds per request) and broken answers.
  - When the Share host itself can't be reached, publishing stops before anything is shared with `SHARE_SERVICE_UNAVAILABLE` (exit 4), instead of a message blaming the TinyCloud node.
  - `share show <id> --reveal-link` prints the same short link.
  - `share revoke` deletes the stored envelope after the node confirms the revocation. A failed delete only warns; the envelope expires with the share.
  - Sender history and the `--notify` invitation still carry the long link. Bearer links are unchanged.

  `@tinycloud/share-envelope` adds a `@tinycloud/share-envelope/short-link` subpath export with `parseShortShareUrl`, `splitInlineToShort` and `rebuildInlineFromShort`, tested against the vectors Share's own codec uses. They are not in the package root, so bundles that import the root (such as `@tinycloud/web-sdk`) do not grow. Details: TC-1737

- Updated dependencies [f8c2967]
  - @tinycloud/share-envelope@1.2.1-beta.0
  - @tinycloud/sdk-core@3.3.1-beta.0
  - @tinycloud/share-sdk@1.2.1-beta.0
  - @tinycloud/node-sdk@3.3.1-beta.0
  - @tinycloud/operations@0.7.1-beta.0

## 1.3.1

### Patch Changes

- 8b640ae: `tc auth grant` asks the owner to confirm entries marked `!` whenever stdin and stderr are a terminal, even when stdout is redirected to a file (as a script that captures the grant does). Before, a redirected stdout made it refuse with `CONFIRMATION_REQUIRED`. Without a terminal on stdin and stderr it still exits 2 with `CONFIRMATION_REQUIRED` and signs nothing, and an answer piped into stdin is no longer read as the confirmation. `--yes` is unchanged.

## 1.3.1-beta.0

### Patch Changes

- 8b640ae: `tc auth grant` asks the owner to confirm entries marked `!` whenever stdin and stderr are a terminal, even when stdout is redirected to a file (as a script that captures the grant does). Before, a redirected stdout made it refuse with `CONFIRMATION_REQUIRED`. Without a terminal on stdin and stderr it still exits 2 with `CONFIRMATION_REQUIRED` and signs nothing, and an answer piped into stdin is no longer read as the confirmation. `--yes` is unchanged.

## 1.3.0

### Minor Changes

- 74b42c9: `tinycloud auth grant` on an OpenKey owner profile now sends every agent request to OpenKey, including `--preset apps-agent` requests with no extra entries, so the owner approves each one. `--yes` no longer skips that approval; it skips only the extras confirmation. The grant lasts as long as the approval allows, and requests are capped at 7 days. An approval that unchecks any requested ability is refused with `OPENKEY_APPROVAL_NARROWER`, and nothing is stored.

  The agent grant is now signed by a fresh node restored from the verified approval session, not by the owner's node. A grant therefore no longer changes the owner's in-process runtime authority.

  Without a terminal, the grant prints the OpenKey approval URL and waits for the callback; it does not open a browser.

- 9459b5b: `auth logout`, `auth rotate`, and replica-enabled `auth login` check the sender share history before they replace the profile's share-history key. If the history holds unexpired shares, or cannot be read, the command refuses with `SHARE_HISTORY_UNEXPIRED` or `SHARE_HISTORY_UNAVAILABLE` (exit 5) and changes nothing. `--force` proceeds anyway on each of these commands, and `auth logout --revoke` skips the check. The new `share history recover` command moves an unreadable history file aside to `share-history-v2.json.unreadable-<timestamp>`: it links the file to that name without overwriting, then removes the original, under the profile lock. It never deletes or overwrites a file. If the history file exists but cannot be read, recover exits 1 with `SHARE_HISTORY_RECOVER_FAILED` and moves nothing. Plain re-login and local-owner profiles are not checked.

  Details: TC-1669

- 9067edd: `tc share publish ./site/` publishes a folder with a top-level `index.html` as one self-contained `.html` page over the anyone-with-the-link path. The folder's stylesheets, scripts, images and fonts are inlined as `<style>`, `<script>` and `data:` URLs by the share-sdk `html-bundle` rewriter (HTML parsed with jsdom, loaded only for a folder publish); the page is named `<folder>.html` or `--name`. A folder the rewriter cannot make self-contained is refused with a typed error that names the file and the offending reference (up to 5 paths, escaped for the terminal): `UNSUPPORTED_HTML` (external URLs, frames, forms, `<base>`, module scripts, links to other pages, ...), `HTML_RESOURCE_MISSING`, `UNSAFE_PATH` (exit 8: `../`, backslashes, control or direction-changing characters, case collisions), `UNSUPPORTED_FOLDER_ENTRY` (symbolic links, special files, nesting deeper than 16), `MAX_BYTES_EXCEEDED` (exit 7), and `INVALID_ARGUMENT` for a folder without a top-level `index.html`. Symbolic links are never followed, including a parent folder swapped for a link while the folder is read (on Linux each file and directory is checked through its open descriptor; on other platforms the checks are best effort and the race is narrowed, not closed); entries starting with `.` are skipped and reported. `manifest.json` and `knowledge/**` are never inlined and are named on stderr; they are not published (sidecar publishing is not available yet). Addressed, `--prefix` and multi-input folder publishing is still refused with `MAX_BYTES_EXCEEDED` (exit 7), now with a message that says folders can only be published as a single page for an anyone-with-the-link share.
- d2ad845: `tc delegation create` now signs and activates the delegation through `delegateTo`, reads it back through the node's account delegation query, and prints its CID only once the node lists it as active (`DELEGATION_NOT_CONFIRMED` otherwise). `tc delegation list` and `tc delegation info` use that query (`POST /delegation/query`) via `account.delegations.query()`, which includes delegations signed by the session key; `list` gains `--space`, and `--to` accepts a `did:key` with a `#fragment`. Previously `create` and `list` sent `tinycloud.delegation/create` and `tinycloud.delegation/list` invocations that the node does not handle (it answered an empty 200, surfaced as a JSON parse error), and `info` called a method that did not exist.

  A plain `tc auth login` now also requests `tinycloud.delegation/list` on the default space (OpenKey's default grant omits it). A session that lacks it, on the account space and its own space, gets a `PERMISSION_DENIED` error saying to run `tc auth login` again. `DelegationManager.query()` signs for the account space and falls back to the session's own space when the node refuses (403).

  Breaking: removed `DelegationManager.create()` (use `TinyCloudNode.delegateTo()`), `DelegationManager.list()` (use `account.delegations.query()`), `TinyCloudNode.delegate()` (use `delegateTo()`), `TinyCloudNode.listDelegations()` (use `account.delegations.query()`), and the web-sdk `TinyCloudWeb.delegate()` (use `delegateTo()`) and `TinyCloudWeb.listDelegations()` (use `account.delegations.query()`). They sent invocations the node never handled, so they never worked. `account.delegations.list()` is not a replacement: it reads the SQL index and omits session-signed delegations. Also removed the `delegationManager` option from `SharingService` config; sharing uses `createDelegation` or `createDelegationWasm`.

  `TinyCloudNode.delegateTo()` takes a new `requireActivation` option: when set, it throws when the node answers 200 but lists a target space under `skipped` (a space it does not host), naming that space; this used to look like success. It is off by default, since grants to a not-yet-hosted space (e.g. secrets) are valid. `tc delegation create` sets it. `DelegationManager.getChain()` and `checkPermission()` now return an `UNSUPPORTED_OPERATION` error when the node answers with an empty body.

- a553392: Agents can pick up the apps a user installed, from their `applications` space.
  - `tinycloud knowledge list` lists the apps that have a knowledge bundle (`<app_id>/knowledge/index.md`) with their concept files, merging the account application registry when the session can read it. `tinycloud knowledge read <app_id> [concept]` returns the index (with its links) or one concept with its frontmatter parsed. A grant that does not cover the request exits 5 and the hint lists the requests to make, with the real app id; a mistyped app id or concept exits 2 with the reason. Operations `tinycloud.knowledge.list@1` and `tinycloud.knowledge.read@1`; MCP tools `tinycloud_knowledge_list` and `tinycloud_knowledge_read` (local and hosted). Files and names come from the user's space, so they are marked untrusted in the tool result and escaped in terminal output (`--json` stays exact).
  - `tinycloud auth request --preset apps-agent` asks for **read-only** access: KV get and list, SQL read, on the `applications` space, up to 7 days. `--app <app_id>` (repeatable, up to 5) limits it to those apps' `<app_id>/` prefixes, which is the recommended ask. `--preset apps-agent --write --app <app_id>` is a separate opt-in for the named apps: KV put only in each app's `knowledge/` and `prefs/` folders (the folders the sample apps' manifests write to) plus SQL write, which adds, changes and deletes rows. Creating, changing and dropping tables also needs `tinycloud.sql/schema`, which the preset grants only on an app's catalog database (`xyz.tinycloud.sample.healthlog` gets `healthlog`, at the exact path `<app_id>/healthlog`). Everything else under `<app_id>/` stays read-only, so the app's code and its stored `<app_id>/app/manifest.json` and `<app_id>/app/install.json` cannot be changed through it (the root-level `<app_id>/manifest.json` and `<app_id>/install.json` are refused too) (TC-1620); it is refused without `--app`. Neither variant carries KV delete, SQL admin, schema on any other database, another service or space. The preset cannot be combined with `--cap`, `--permission`, `--manifest` or `--expiry`, and `--device` is refused because device approval cannot grant SQL.
  - `tinycloud auth grant` now resolves the request file once, the way the signer reads it (an entry with no `space` is in the owner's `applications` space; an empty space is refused; entries with the same service, space and path are merged), and prints, gates and signs that one list. Before signing it prints every permission in plain words (service, space, path, actions; delegation abilities as "can give other people or agents access on your behalf" and "can cancel access you gave"; unknown services and actions raw and marked unrecognised), once each, with the requested lifetime. The preset wording appears only when the permissions, the owner's own `applications` space and the 7-day lifetime all match. For a request that touches an `applications` space, anything the preset could never grant is marked `!`, listed first under "MORE than the apps-agent preset" and signed only after `--yes` or an interactive confirmation; without a terminal it exits 2 and signs nothing. A request with the `tinycloud.vault` shorthand, a service the signer cannot sign, or more than one space is refused with exit 2 before anything is printed or signed. The request's `sessionDid` and `requestedExpiry` are checked before anything is printed. Text from the request is escaped in the listing, the interactive prompt and every error message: on a terminal, `outputError` now escapes control characters, ANSI, bidi and zero-width characters (U+200B-200F, U+202A-202E, U+2066-2069, U+2028/2029, C1, U+FEFF) in every message and hint for every command. JSON output (stdout and the JSON error form on stderr, which a redirected `auth grant req.json > grant.json` still prints to a terminal) writes those characters as `\uXXXX` escapes: it parses to the same text. Refusal messages echo at most 5 items of 80 characters.
  - The `tc-cli` skill has a "Pick up a user's apps" section.
  - Fix: a delegation signed with an empty path (`tinycloud.kv:applications::get,list`, the whole service in a space) was rejected on import by the runtime validator, and `delegation revoke` could not bind its space. Both now accept it; other malformed resources are still refused. The validator now uses one pattern for both resource forms and drops an unreachable branch, so the web-sdk root bundle does not grow.

- 87a137e: Retry node `NODE_BUSY` and `REQUEST_TIMEOUT` answers automatically. Both mean nothing was applied, so the services now retry them under the existing `retryPolicy` through the new `ServiceContext.invokeWithRetry(url, build)`, which calls `build` once per attempt so every attempt carries a freshly signed invocation (the node answers a repeated invocation with 409, so re-sending one could never succeed). `ServiceContext.fetch` itself no longer retries. A context without `invokeWithRetry` sends once. The policy: at most 4 attempts in about 12 s, honouring the node's `Retry-After` (capped at the remaining budget) and otherwise backing off exponentially with full jitter (250 ms base, 4 s cap). Aborts and per-request timeouts end the wait at once, and `OUTCOME_UNKNOWN` is never retried. `defaultRetryPolicy` changes accordingly (its retryable codes are now `NODE_BUSY` and `REQUEST_TIMEOUT`; `NETWORK_ERROR` and `TIMEOUT` are no longer listed because no service read them), and `RetryPolicy` gains an optional `maxTotalMs`. Opt out with `retryPolicy: { maxAttempts: 1 }`.

  The CLI gains `--no-retry` and `TINYCLOUD_RETRY=0` for monitors and probes that must see the node's honest `NODE_BUSY`. KV responses (and `tc kv get|put|delete --json`) report `attempts` and `backoffMs`.

- 02c0a44: Owner-signed artifact pin for addressed shares (TC-1428). The Policy/v3 envelope gains an optional `artifactPin` field (artifact id, version, sha256 of the version's `manifest.json`, and the sha256 and size of the stored ciphertext file the share reads). It is covered by the envelope signature, so the existing envelope version and the node are unchanged (the node reads the envelope as opaque JSON). `share-sdk` adds a small verification module (`verifyArtifactShare`, `assertArtifactBinding`, `verifyArtifactFileBytes`, `verifyArtifactManifestBytes`, `buildArtifactPin`): a share that reads `artifacts/` without a pin that matches its content source is refused, a pinned share cannot grant edit, and fetched bytes that do not hash to the pinned digest are refused before any decrypt request. `inspectShare` reports `artifact: { id, version }`. `share publish --artifact` signs the pin for addressed shares.

  Breaking for old viewers: the envelope schema is strict, so a viewer that predates this release rejects an envelope with `artifactPin` rather than showing it. Update the viewer's `@tinycloud/share-sdk` before publishing pinned addressed shares. The owner is the trusted signer; the node has no write-once ACL, so an owner can still overwrite a version file and recipients then fail closed. Bearer artifact shares have no envelope and carry no pin yet.

- 116b214: Artifact versions for `share publish` (TC-1428). `share publish --artifact <id|new>` stores the file as a write-once version under `artifacts/<id>/versions/<n>/` (created with `If-None-Match: *`, `manifest.json` written last) in the owner's space and pins the share to that version: bearer and addressed shares read one version file and never carry `put`. Re-publishing the same bytes to a bearer link returns the same version and changed content makes the next, so an agent retry is safe. An addressed share is a fresh encryption each time, so each is its own version; the manifest records only the sha256 of the stored bytes, never of the plaintext. `share versions <id>` lists versions and the shares pinned to each. `--action edit` on an artifact share is refused; every artifact share pins one version. The layout helpers (`publishArtifactVersion`, `listArtifactVersions`, `parseArtifactManifest`, path helpers) are a new `@tinycloud/share-sdk/artifact` entry point, kept out of the main barrel so browser bundles do not carry them. No node change.

  The built-in `builtin:share-publishing` manifest now also requests `artifacts/` (get, metadata, put, list). Profiles signed in before this version must sign in again to use `--artifact` (`auth login --device --manifest builtin:share-publishing`); other `share publish` use is unchanged. Versions are kept by default and count against the owner's storage; reclaiming bytes depends on history GC (TC-1277).

- baca422: Pin profile and replica directories before SQLite opens during reset and sync, and for local report reads and logout cleanup. Reject whole-profile aliases, symlinked replica roots, entries, database files and persisted report descendants, changed SQLite identities, and expired profile descriptors before access. Gate legacy replica reads on pending logout, including aliases and in-flight reads. Resume cleanup of verified empty legacy replica directories after an interrupted purge without deleting unknown files.

  `@tinycloud/operations` resolves user-owned symlinked TinyCloud home directories to a pinned real directory while refusing aliases inside a profile; profile JSON reads verify leaf identity. `@tinycloud/replica` creates SQLite database files exclusively for concurrent openers and checks their identity before migration; on macOS and Windows, replica removal checks each known file and directory before nonrecursive deletion and stops on a changed or unknown entry.

  Breaking change (beta feature): `tc replica report` now reads persisted events and identity partitions without starting a replication runtime. `--purge` and `--clear-pending` refuse with exit 2 `REPORT_READ_ONLY`. Use `tc replica reset --replica <name> --purge` only as a partial alternative for named local replicas. Flag-owned purge and pending clearing have no equivalent yet; TC-1309 tracks safe replacement commands.

- ec13a60: New `tinycloud apps install <app_id>` installs a pinned catalog app (currently `xyz.tinycloud.sample.healthlog`) into the applications space of the profile it runs under (the owner's space, for a delegate profile, through the grant). It fetches each file from Share by its pinned bundle digest and checks its size and sha256 before anything is written. It then checks the pinned DDL: only `CREATE TABLE/INDEX/VIEW IF NOT EXISTS` and `DROP VIEW IF EXISTS` for the pinned views are allowed, and any other statement, including `DROP TABLE`, aborts before any write. It reads every knowledge file under `<app_id>/knowledge/` first, then creates the missing ones create-only, with `index.md` last. Then it applies the schema and re-creates the pinned views on every run.

  If `<app_id>/app/install.json` names a different bundle digest than this CLI pins, or is not a valid install record, the command refuses with `INSTALL_RECORD_MISMATCH` or `INSTALL_RECORD_INVALID` before writing anything. A missing record is not an error.

  Existing knowledge files whose bytes differ from the pinned version are left as you edited them and reported; they are not overwritten. The command exits 0 in that case, and the remaining files are still installed. JSON output lists them under `conflicts`.

  If the schema fails after notes were written, the command says "notes saved; tables not set up: run again" and exits non-zero. Re-running is safe: it reports `already` when nothing needed writing.

  Node-version note: the schema-scope grant is the same on every node. Nodes before 1.21.6 do not enforce the schema/data split for `ddl_requires_schema`. On those nodes the allowlist covers only the installer's own statements; the grant itself does not limit the agent's SQL to data statements.

  Details: TC-1422

### Patch Changes

- b6d0b9f: `tc account` commands now exit with `ACCOUNT_ACCESS_REQUIRED` (exit 5) before calling the node when the session lacks the account-space abilities that command invokes, as with a plain OpenKey login. Each command checks its own set (registry reads and writes, `kv/del` for removals, `space/list` and `capabilities/read` on the primary space for the commands that list spaces or delegations). `account delegations revoke` needs no session ability on a local-key profile (it signs with the owner wallet) and is refused with the `tc delegation revoke` command on an OpenKey profile, which cannot carry the raw-CID revoke ability, and the error prints the `tc auth request --grant --cap ...` command that grants exactly those, with a `--paste` variant. `tc auth request --grant` gains `--paste` (OpenKey owner profiles) for browsers that cannot reach the CLI's loopback callback, and a grant that spans several spaces now says up front how many OpenKey approvals it takes (one per space) and numbers each prompt. The account registry sync skip is recorded once per process as a debug event only (`TinyCloud_debug=true`).
- 94566db: `auth logout` denies the profile's replica gate durably before it removes `session.json` and `key.json`, then erases local replicas. If the gate cannot be denied, credentials and replicas stay in place and the command exits with a retryable error. Fence unchanged inactive replica gates across online logout, reject changed gates before local credential removal, and give an actionable retry path for an interrupted orphan logout marker. A plain `auth logout` retry now resumes a committed local logout whose credential removal failed, instead of asking to discard local changes. Logout and startup recovery refuse without changes when the pending logout belongs to a different principal than the current session.
- fff4c72: Add the node release pin and verified downloader that `tc node install` will use. The CLI embeds SHA-256 pins for the TinyCloud node tarballs and checks the download against them before unpacking. No command uses them yet.
- b22a88d: A plain OpenKey `auth login` on a profile that already belongs to an owner now names that owner's space, so OpenKey preselects the owner's key without `--owner`. The signed owner is still verified after approval.
- 3d24566: Cancelling a prepared OpenKey login before approval now takes one path whether it comes from terminal Ctrl-C or a SIGINT/SIGTERM sent to a non-interactive process: the CLI asks OpenKey to cancel the handoff (best effort, two-second timeout), saves nothing and exits 130 `CANCELLED`, as the exit-code table documents. Previously a non-interactive signal never reached OpenKey, and terminal Ctrl-C exited 3.
- 1289240: A completed prepared OpenKey login now exits promptly under Node even when the browser opened a connection to the loopback callback and never sent a request, as Chromium does when Local Network Access refuses the callback. Closing the callback listener now also drops connections that never sent a request; the ACK's own connection closes after its response.
- d2c1e10: A failed or cancelled replica-enabled OpenKey login (interrupt, expiry, invalid signature, paste EOF or a failed commit) no longer signs out the profile's existing session: it never denies an already-active replica gate, so the live session's unsynced writes are kept. Only a gate that the failed attempt itself bound, and that no saved session holds, is denied again.
- 8332bc6: Classify replica storage-budget failures as storage-full exits and expired consent as permission-denied with sign-in renewal guidance.
- 72ff62a: `share publish`: `.jsx` and `.tsx` files are published as `text/jsx` and `text/tsx` instead of `application/octet-stream`. `--to anyone --action edit` now exits 2 with `INVALID_ARGUMENT` instead of silently publishing a read-only link. The tc-cli skill documents publishing Markdown, single-file HTML and JSX artifacts, and getting the link with `share show <id> --reveal-link`.
- 270c284: Clarify the share link fragment wording in the tc-cli skill reference.
- bba15a4: `tc share publish --json` now reports the sender-history write as `history`: `{"recorded": true}`, or `{"recorded": false, "reason": "HISTORY_UNREADABLE" | "HISTORY_READ_FAILED" | "HISTORY_WRITE_FAILED" | "HISTORY_UNAVAILABLE"}`. The exit status stays 0. The stderr warning names the reason. When a publish with `--notify` delivers but its confirmation cannot be saved, the warning also names the share id and CID to keep, and `history` stays `{"recorded": true}`. A failed delivery-confirmation write on `share notify` names its reason too.
- 5bbc05c: `tinycloud auth login` keeps its browser callback open for the full five-minute sign-in window, so the browser can finish a slow local-network permission prompt. Interactive sign-in also prints a one-time how-to line on stderr after 15 seconds while it waits. JSON output is unchanged.

  Details: TC-1675

- a05cfe5: `tc auth login` (`--device`, `--paste` and browser) and `tc init` now wait for OpenKey to host the account's space before reporting success (TC-1608). OpenKey hands the CLI its delegation while it is still hosting the space in the background, so the first storage command could fail with `404 Space not found`. When OpenKey reports `spacePending`, the login shows "Setting up your space…" and re-reads the space with the saved session (read-only, no new signature, ability or delegation) for up to 150 seconds. The wait follows OpenKey's readiness: `spaceReady: null` with `spacePending: true` keeps waiting, with or without a `spaceError` (a timeout or a failure OpenKey is retrying; the error is shown as progress), and a transient read failure does not end it. Only `spaceReady: false` with a `spaceError` is final and fails with `SPACE_SETUP_FAILED`, carrying OpenKey's error text and code. If the 150 seconds pass, the login fails with `SPACE_SETUP_PENDING` and OpenKey's last report. Both exit 1 and keep the saved session, so retrying or approving again in OpenKey re-runs the setup. `spaceReady: false` alone (OpenKey will not host it) and a session with no kv grant to read with print a warning. Logins whose delegation says nothing about the space, or says it is ready, do not wait.

  An OpenKey profile's `SPACE_NOT_HOSTED` error, including one on the primary space when no `--space` is given (which previously got no `SPACE_NOT_HOSTED` error at all), no longer tells you to run `tc space host`, which cannot work without a signer. It says: "OpenKey is still setting up your space. Wait a minute and retry; approving again in OpenKey re-runs the setup." Local-key owners keep the `tc space host` hint.

- c06c304: Courier profile permission errors use code profile-permissions; documentation wording updates.
- e8448a4: `tinycloud auth request --preset apps-agent --write --app <app_id>` no longer lets the agent change an app's own code or manifest (TC-1620). KV put is now granted only on `<app_id>/knowledge/` and `<app_id>/prefs/` (the two folders the sample apps' manifests write to), and KV get and list stay on all of `<app_id>/`; SQL read and write are unchanged. A put on `<app_id>/app/` (which holds the code and the stored `app/manifest.json` and `app/install.json`), on the root-level `<app_id>/manifest.json` or `<app_id>/install.json`, or on any other folder is refused by the node. The scope printed to the agent and to the owner says so ("write knowledge and data files ... cannot change the app's code, manifest or install record"; SQL write adds, changes and deletes rows, and creating, changing or dropping tables is granted only on an app's catalog database), and a request file that still asks for a put on the whole app, or on any path outside those folders, is listed under "MORE than the apps-agent preset" and needs the owner's explicit confirmation. Grants issued with the earlier wide write shape keep working until they expire (7 days) or are revoked.
- dc67c26: Breaking change to `tc replica report --json` (beta feature, from #551 / TC-841): the report is now read-only and never starts a replication runtime, so `replicas` is always `[]` and `replicasUnavailable` is always `true`. Per-partition pinned counts moved from `replicas[].pinned` to `partitions[].pinned` (each partition has `idHash`, `host`, `space`, `pinned`). Scripts reading `.replicas[].pinned` should read `.partitions[].pinned` instead. Live replica status returns with TC-1309.
- 9891ed9: Replication: add the shared replica contract for browser and node/CLI storage adapters: the lifecycle gate (`ReplicaGateTx.run`, session stamps, scoped deny), the grant-lifetime policy, the quota seams, the options `grantTtlMs`, `maxBytes` and `minFreeBytes`, and new status fields and events. It adds `@tinycloud/sdk-services/kv/replication/contractConstants`, `/grantPolicyConstants` (numeric policy constants only, with the original names re-exported from `/contractConstants`) and `/grantPolicyTypes`. Diagnostics allowlists, `TelemetryEvents` and CLI debug output cover the new values.

  Source-breaking for exhaustive consumers (replication is beta): switches over these types must now handle `ReplicaState` `gated`, `ReplicationReason` `replica_gated`, the `replication.grant` and `replication.lifecycle` events, sync `trigger: "peer"` and sync `class: "lifecycle"`. Browser ungated `inspectStatus` now returns a discriminated `ReplicaInspectedStatus { redacted: true }` branch without grant, authority or errors; consumers must narrow before reading those fields. Browser `admitPage` takes the exact signed ciphertext-row `deltaBytes` instead of plaintext `blobBytes`/entry count; node's admission hook retains its existing shape.

  `ReplicaGateAccess` now carries a prederived `principalHash` instead of a raw principal; browser `run` requires gate/account key IDs and derives hashes outside IDB transactions. `ReplicaBrowserGateTx` returns a typed private-key snapshot for this derivation, and `ReplicaGatedStorage.open` no longer inherits the unstamped Phase 1 overload. Browser partition-index entries add private-HMAC `lookupId` and nonsecret `ownerDevice` for owner status and scoped purge without decrypting the sealed owner device.

  Phase 2 `ReplicaGatedHandle` requires the opaque `replicaId` supplied by the adapter. Consent-deadline grant events are emitted only for already opened handles with that id; pre-open expiry is reported by lifecycle/recovery, never a raw-prefix or unsalted identifier. `ReplicaLifecycleGate.consentDeadline(stamp)` exposes only the immutable persisted deadline to the main-thread timer, including compact session restore without a fresh anchor; it never derives one from first install.

  The browser contract also defines the origin-wide deny tombstone outside the deletable IndexedDB database, its fail-closed gate semantics, and the lock requirement across lifecycle mutations.

  Browser schema v2 destructively replaces legacy plaintext replica-owned v1 stores only after preserving the origin denial floor; pre-v2 persisted stamps cannot restore. The RC1 per-partition databases remain untouched.

  Establishment takes `{ consentAnchor }`, not `{ siweIssuedAt }`: validated signed SIWE or an independently verified **owner-authorizing** delegation proof supplies finite recency, never a new child minted from old consent. With only a compact leaf or no owner proof timestamp, establishment refuses `not_established` and KV uses the network; matching persisted stamps may restore. Node `pending.json` operations require the profile lock across gate check and file access; deny records a durable identity generation with the pending intent. `activationAllowed` returns false for a null gate principal. Browser replica identifiers use private nonextractable gate-HMAC keys, and account KV metadata/content is sealed with separate account keys; denial or seven-day consent expiry shreds both key records before purge. This limits replica-owned storage plaintext but does not claim confidentiality against a raw browser-profile reader with a valid signed-in session (CONTRACT.md).

  Replica consent from full SIWE requires verified signed `issuedAt`, finite signed `expirationTime` and an exact-space uncaveated KV get+sync witness. Expirationless or otherwise unanchored SIWE can remain network-valid but cannot establish, mint or renew a replica; refused stamps never fail network sign-in/restore, and restore never establishes. A same-principal fresh SIWE does not extend the persisted deadline: controller mint and adapter effective expiry are capped by the gate's durable deadline.

  The browser origin-wide encoded-row budget includes a reserved device bucket for sealed owner-device and grant/first-install rows, admitted with partition rows before any put and released on deny. Native CryptoKey serialization and IndexedDB allocation remain unobservable; node admission is unchanged.

  Compact `sessionOnly` restore requires both a matching stamp/active installed grant **and the current session's own uncaveated get authority** for the requested key or list prefix. A `sessionGrant` refusal cannot be overridden by a stored device grant; compact sessions never mint or renew. Plain logout still ends the network session, while `logout --revoke` keeps it if online revocation fails and leaves the replica denied for retry.

  Browser erase retains a keyless opaque/numeric `purged: true` meta tombstone to fence stale handles. Its measured bytes remain charged until deletion or same-partition replacement; replay releases zero and cannot double-subtract quota.

- f2cb165: `tc delegation revoke <cid>` now revokes an owner-signed grant (such as one from `tc auth grant`) from a profile that has no local record of it, for example another CLI profile or machine of the same owner. When the profile has no matching record, the CLI reads the owner's delegation records from the node and uses that record's space only if the grant was issued by the signed-in owner, directly or through a chain of delegations recorded on the node that ends at the owner or the signed-in session key, and every space it covers is one plain space id that belongs to that owner; a CID the node does not list, an issuer or space that does not match, or an ambiguous record keeps the existing `RAW_RECAP_RESOURCE_UNSUPPORTED` refusal, now saying "this CLI profile has no record of this grant and the node's record does not match the signed-in owner". A locally recorded grant still resolves first and unchanged. An agent that presents a revoked grant now gets "This grant was revoked. Ask the owner for a new grant" instead of a bare authentication error: the CLI reports it as `GRANT_REVOKED` (exit 5, the same code and exit as `tc replica`), and operations (including `knowledge list|read` and the MCP tools) keep `AUTH_REQUIRED` with that message, only when the node's 401 says the delegation (or one it derives from) was revoked; any other 401 is unchanged.
- ef9653b: Sign the share delivery authorization with the primary session key. The node records the signer as the delivery's sender key, and the SDK binds and countersigns the receipt with the primary session key; when a runtime grant held by another key covered the shared file, `tc share publish --to <email> --notify` rejected its own receipt and the recipient was never emailed (exit 9, `partial-failure`).
- 9b46aa1: `tc share` now names a failure by class instead of a bare `INVALID_ARGUMENT` "share operation failed". A share upload the node answers with `404 Space not found` fails with `SPACE_NOT_READY` (exit 4; a known node problem, retry after the node update).

  Behaviour change for scripts: share failures that used to report `INVALID_ARGUMENT` (exit 2) now report a typed code and exit code:

  | Signal                                                         | code                | exit |
  | -------------------------------------------------------------- | ------------------- | ---- |
  | upload 404 "Space not found"                                   | `SPACE_NOT_READY`   | 4    |
  | HTTP 401 / unauthenticated                                     | `AUTH_REQUIRED`     | 3    |
  | HTTP 403 / forbidden                                           | `PERMISSION_DENIED` | 5    |
  | HTTP 404                                                       | `NOT_FOUND`         | 4    |
  | HTTP 5xx, 408, 429                                             | `NODE_UNAVAILABLE`  | 7    |
  | node unreachable (a `fetch failed` error, `ECONNREFUSED`, ...) | `NETWORK_ERROR`     | 6    |
  | HTTP 400, 422                                                  | `INVALID_ARGUMENT`  | 2    |
  | other 4xx                                                      | `NODE_REJECTED`     | 1    |

  A `TypeError("fetch failed")` that used to be `INVALID_ARGUMENT` is now `NETWORK_ERROR`. The message carries the HTTP status and a plain upstream code, never response text; the original error is kept as `cause`. Errors with no status or network signal are unchanged.

- ef49c14: The "Manage storage" link in storage-full errors and status now points to https://account.tinycloud.xyz/storage instead of /billing. The `tinycloud account billing` commands still open the billing page.

  Details: TC-848

- 90bc0ae: Report the node's retry signals (tinycloud-node #347) as typed errors instead of `NETWORK_ERROR`, for SQL, DuckDB and KV get, head, list, put and delete.
  - `NODE_BUSY`: `503 sql_busy:<stage>` or `unavailable_retryable`. Nothing was applied. `meta.stage` (`lock_wait`, `hydration`, `artifact_transfer` or `identity_resolution`) when the node names one.
  - `REQUEST_TIMEOUT`: `503 request_timeout`. The node's deadline passed before any write began, so nothing was applied.
  - `OUTCOME_UNKNOWN`: `500 outcome_unknown`. A write may have been applied; read it back before retrying a non-idempotent operation.

  `meta.retryable` says whether a retry is safe and `meta.retryAfterMs` carries the node's `Retry-After`. The SDK still never retries by itself. A response without these bodies, such as a 503 or 500 from node 1.20.6, keeps its old code, and real transport failures stay `NETWORK_ERROR`. New export: `nodeRetryError`.

  Fix: a conditional KV `put` or `delete` that got a 503 was reported as `KV_CONFLICT`. A 503 is never a conflict; the node's precondition failure is its 412, still `KV_PRECONDITION_FAILED`. The SDK no longer produces `KV_CONFLICT` itself (callers that handle it keep working). A conditional write's 503 is now `NODE_BUSY` or `REQUEST_TIMEOUT` with the typed body, otherwise `KV_WRITE_FAILED` (put) or `NETWORK_ERROR` (delete) with `meta.status` 503.

  `tc` prints a plain message for the new codes ("The node is busy, try again in 5 s.", "Outcome unknown: the node may have applied the write. Check before retrying.") and exits 7.

- 0524256: Keep broker configuration outside Courier and resolve the owner's gh credential at runtime without copying it. Woken agents use a separate home and Courier-only identity snapshot. Existing broker token files are no longer used; owners configure the broker again after signing in with gh.

  Refuse protected-root traversal, gated executable aliases/copies, local network destinations and additional GitHub, registry and credential-access commands.

  Require registered executable identities for tool allowances, including Courier entrypoints and wrappers. Unregistered executables and package launchers fail closed. Protect registered tools from agent edits and preserve the installed census across automatic refreshes; owners refresh it after tool upgrades.

  Inspect interpreter script and preload files independently of their extension, and classify agent and gated-tool package entrypoints by their package manifest. Require the installed executable census and use its git identity for guard probes.

  Details: TC-1634

- c980014: Legacy local replica get, list, and status with an owner session require its persisted replica stamp and the active profile gate. A session without an owner DID (a delegate's imported grant) reads only while the profile has no gate and no committed sign-out. Serialize reads and output with sign-out denial, and refuse a pending logout marker before and after local reads so interrupted cleanup cannot serve retained replica data.

  Legacy logout cleanup accepts only the approved path, type, and inode inventory recorded in the logout marker; an unlisted or replaced file leaves cleanup pending instead of broadening `--discard-local-changes`.

- 0c4c6b2: `ProfileReplicaPurge.deny` with `{ deferErase: true }` now accepts only `reason: "sign_out"` and returns `ProfileReplicaDeferredDenyOutcome`, whose committed `denied` always carries `resumeToken`. `ReplicaEraseReport.deferred: true` marks a pass held by a deferred denial, so `remaining: 0` there is not completion. node-sdk exports the full contract `ProfileReplicaPurge`, requires the displayed `approval` in `prepareLogoutPending`, and reports `purgePending` from inspected status while a deferred denial or any intent remains.

  A v1 logout marker records the epoch its denial actually committed (`deniedEpoch`) in the same locked section as the deny, and every later check compares with it. A sign-out interrupted between its deny floor and gate writes is completed by the next `auth logout` (`@tinycloud/replica/profile-gate` adds `readLogoutGate`, `advanceInactiveGate` and `REPLICA_DENY_FLOOR_FILE`); reads report "a previous sign-out was interrupted; re-running `tc auth logout` completes it". A restored older gate under a recorded denial refuses with the `tc profile delete` route.

  `auth logout` by an account other than the one whose replicas the profile holds writes no marker and leaves that account's gate, floor and replicas untouched: it signs out, removes its own session and key, and erases the profile's legacy `replicas/` mirror (replayed at startup after a crash). `--revoke` there revokes only grants on the signed-in account's spaces.

  When startup recovery refuses a pending logout because a credential file is unreadable, the message now names that file (`session.json` or `profile.json`).

  CLI-bound storage and purge name the CLI's `replication/events.jsonl` and `events.jsonl.1` diagnostics logs (`diagnosticFiles`). With a readable gate, those exact names count as known only while they are regular files, so a fully synced profile signs out without `--discard-local-changes`; a symlink there stays unknown.

- b2b3b97: Replication: read `TC_REPLICATION_GRANT_TTL_MS` and `TC_REPLICATION_MAX_BYTES` in the CLI; both must be plain decimal integers (grant TTL at most 7 days), otherwise the command fails with a usage error naming the variable.
- aad5dd6: Clarify in the agent skill that write access to an app includes its table rows, that creating, changing or dropping tables needs a schema grant that only an app's catalog database gets, and that structural changes are confirmed with the owner first. Details: TC-1422
- ec13a60: `tinycloud auth request --preset apps-agent --write --app xyz.tinycloud.sample.healthlog` now also grants `tinycloud.sql/schema` on that app's catalog database (exact path `xyz.tinycloud.sample.healthlog/healthlog`, no trailing slash), so the agent can create, change and drop its tables. CREATE, ALTER and DROP need `tinycloud.sql/schema`, which SQL write alone does not carry; nodes before 1.21.6 do not enforce that split. Other apps get no schema grant, and the scope notice says so. Details: TC-1422
- 45ca334: Reword the `--write` description for `tinycloud auth request --preset apps-agent --write --app <app_id>` (TC-1620). With `--write --app <app_id>`, the agent can add and change that app's data: write its `knowledge/` and `prefs/` files and add, change or delete its table rows. For an app's catalog database it can also create, change and drop tables. The `tinycloud knowledge` missing-grant hint also shows this write request for a named app.

  Details: TC-1620
  Details: TC-1422

- Updated dependencies [2aa917e]
- Updated dependencies [c92953f]
- Updated dependencies [b6d0b9f]
- Updated dependencies [d2ad845]
- Updated dependencies [6ad58de]
- Updated dependencies [29440be]
- Updated dependencies [9592d3d]
- Updated dependencies [4aae658]
- Updated dependencies [4ac7592]
- Updated dependencies [a553392]
- Updated dependencies [fc88c48]
- Updated dependencies [86815bd]
- Updated dependencies [e7f709d]
- Updated dependencies [94566db]
- Updated dependencies [38980b0]
- Updated dependencies [41e5fca]
- Updated dependencies [a7cdfe0]
- Updated dependencies [94566db]
- Updated dependencies [94566db]
- Updated dependencies [94566db]
- Updated dependencies [9891ed9]
- Updated dependencies [f2cb165]
- Updated dependencies [ac612c0]
- Updated dependencies [87a137e]
- Updated dependencies [ef9653b]
- Updated dependencies [9067edd]
- Updated dependencies [daf8561]
- Updated dependencies [370a8e4]
- Updated dependencies [ef49c14]
- Updated dependencies [90bc0ae]
- Updated dependencies [e68e911]
- Updated dependencies [6e7ad8f]
- Updated dependencies [d84e379]
- Updated dependencies [c2fd94b]
- Updated dependencies [02c0a44]
- Updated dependencies [116b214]
- Updated dependencies [cce8b26]
- Updated dependencies [eb9defd]
- Updated dependencies [5373fa2]
- Updated dependencies [0c4c6b2]
- Updated dependencies [baca422]
- Updated dependencies [e99a127]
- Updated dependencies [f97d73d]
- Updated dependencies [18b6c9f]
- Updated dependencies [2292db7]
  - @tinycloud/node-sdk@3.3.0
  - @tinycloud/sdk-core@3.3.0
  - @tinycloud/operations@0.7.0
  - @tinycloud/node-sdk-wasm@1.7.8
  - @tinycloud/sdk-services@3.3.0
  - @tinycloud/share-sdk@1.2.0
  - @tinycloud/share-envelope@1.2.0

## 1.3.0-beta.55

### Patch Changes

- ef49c14: The "Manage storage" link in storage-full errors and status now points to https://account.tinycloud.xyz/storage instead of /billing. The `tinycloud account billing` commands still open the billing page.

  Details: TC-848

- Updated dependencies [ef49c14]
  - @tinycloud/sdk-services@3.3.0-beta.39
  - @tinycloud/operations@0.7.0-beta.38
  - @tinycloud/node-sdk@3.3.0-beta.39
  - @tinycloud/sdk-core@3.3.0-beta.39

## 1.3.0-beta.54

### Minor Changes

- ec13a60: New `tinycloud apps install <app_id>` installs a pinned catalog app (currently `xyz.tinycloud.sample.healthlog`) into the applications space of the profile it runs under (the owner's space, for a delegate profile, through the grant). It fetches each file from Share by its pinned bundle digest and checks its size and sha256 before anything is written. It then checks the pinned DDL: only `CREATE TABLE/INDEX/VIEW IF NOT EXISTS` and `DROP VIEW IF EXISTS` for the pinned views are allowed, and any other statement, including `DROP TABLE`, aborts before any write. It reads every knowledge file under `<app_id>/knowledge/` first, then creates the missing ones create-only, with `index.md` last. Then it applies the schema and re-creates the pinned views on every run.

  If `<app_id>/app/install.json` names a different bundle digest than this CLI pins, or is not a valid install record, the command refuses with `INSTALL_RECORD_MISMATCH` or `INSTALL_RECORD_INVALID` before writing anything. A missing record is not an error.

  Existing knowledge files whose bytes differ from the pinned version are left as you edited them and reported; they are not overwritten. The command exits 0 in that case, and the remaining files are still installed. JSON output lists them under `conflicts`.

  If the schema fails after notes were written, the command says "notes saved; tables not set up: run again" and exits non-zero. Re-running is safe: it reports `already` when nothing needed writing.

  Node-version note: the schema-scope grant is the same on every node. Nodes before 1.21.6 do not enforce the schema/data split for `ddl_requires_schema`. On those nodes the allowlist covers only the installer's own statements; the grant itself does not limit the agent's SQL to data statements.

  Details: TC-1422

### Patch Changes

- ec13a60: `tinycloud auth request --preset apps-agent --write --app xyz.tinycloud.sample.healthlog` now also grants `tinycloud.sql/schema` on that app's catalog database (exact path `xyz.tinycloud.sample.healthlog/healthlog`, no trailing slash), so the agent can create, change and drop its tables. CREATE, ALTER and DROP need `tinycloud.sql/schema`, which SQL write alone does not carry; nodes before 1.21.6 do not enforce that split. Other apps get no schema grant, and the scope notice says so. Details: TC-1422

## 1.3.0-beta.53

### Minor Changes

- 74b42c9: `tinycloud auth grant` on an OpenKey owner profile now sends every agent request to OpenKey, including `--preset apps-agent` requests with no extra entries, so the owner approves each one. `--yes` no longer skips that approval; it skips only the extras confirmation. The grant lasts as long as the approval allows, and requests are capped at 7 days. An approval that unchecks any requested ability is refused with `OPENKEY_APPROVAL_NARROWER`, and nothing is stored.

  The agent grant is now signed by a fresh node restored from the verified approval session, not by the owner's node. A grant therefore no longer changes the owner's in-process runtime authority.

  Without a terminal, the grant prints the OpenKey approval URL and waits for the callback; it does not open a browser.

## 1.3.0-beta.52

### Patch Changes

- aad5dd6: Clarify in the agent skill that write access to an app includes its tables and that structural changes are confirmed with the owner first. Details: TC-1422

## 1.3.0-beta.51

### Minor Changes

- 9459b5b: `auth logout`, `auth rotate`, and replica-enabled `auth login` check the sender share history before they replace the profile's share-history key. If the history holds unexpired shares, or cannot be read, the command refuses with `SHARE_HISTORY_UNEXPIRED` or `SHARE_HISTORY_UNAVAILABLE` (exit 5) and changes nothing. `--force` proceeds anyway on each of these commands, and `auth logout --revoke` skips the check. The new `share history recover` command moves an unreadable history file aside to `share-history-v2.json.unreadable-<timestamp>`: it links the file to that name without overwriting, then removes the original, under the profile lock. It never deletes or overwrites a file. If the history file exists but cannot be read, recover exits 1 with `SHARE_HISTORY_RECOVER_FAILED` and moves nothing. Plain re-login and local-owner profiles are not checked.

  Details: TC-1669

## 1.3.0-beta.50

### Minor Changes

- 9067edd: `tc share publish ./site/` publishes a folder with a top-level `index.html` as one self-contained `.html` page over the anyone-with-the-link path. The folder's stylesheets, scripts, images and fonts are inlined as `<style>`, `<script>` and `data:` URLs by the share-sdk `html-bundle` rewriter (HTML parsed with jsdom, loaded only for a folder publish); the page is named `<folder>.html` or `--name`. A folder the rewriter cannot make self-contained is refused with a typed error that names the file and the offending reference (up to 5 paths, escaped for the terminal): `UNSUPPORTED_HTML` (external URLs, frames, forms, `<base>`, module scripts, links to other pages, ...), `HTML_RESOURCE_MISSING`, `UNSAFE_PATH` (exit 8: `../`, backslashes, control or direction-changing characters, case collisions), `UNSUPPORTED_FOLDER_ENTRY` (symbolic links, special files, nesting deeper than 16), `MAX_BYTES_EXCEEDED` (exit 7), and `INVALID_ARGUMENT` for a folder without a top-level `index.html`. Symbolic links are never followed, including a parent folder swapped for a link while the folder is read (on Linux each file and directory is checked through its open descriptor; on other platforms the checks are best effort and the race is narrowed, not closed); entries starting with `.` are skipped and reported. `manifest.json` and `knowledge/**` are never inlined and are named on stderr; they are not published (sidecar publishing is not available yet). Addressed, `--prefix` and multi-input folder publishing is still refused with `MAX_BYTES_EXCEEDED` (exit 7), now with a message that says folders can only be published as a single page for an anyone-with-the-link share.

### Patch Changes

- Updated dependencies [9067edd]
  - @tinycloud/share-sdk@1.2.0-beta.7
  - @tinycloud/sdk-core@3.3.0-beta.38
  - @tinycloud/node-sdk@3.3.0-beta.38
  - @tinycloud/operations@0.7.0-beta.37

## 1.3.0-beta.49

### Patch Changes

- Updated dependencies [4ac7592]
  - @tinycloud/sdk-core@3.3.0-beta.37
  - @tinycloud/node-sdk@3.3.0-beta.37
  - @tinycloud/operations@0.7.0-beta.36

## 1.3.0-beta.48

### Patch Changes

- 45ca334: Reword the `--write` description for `tinycloud auth request --preset apps-agent --write --app <app_id>` (TC-1620). With `--write --app <app_id>`, the agent can add and change that app's data: write its `knowledge/` and `prefs/` files and change its tables. The `tinycloud knowledge` missing-grant hint also shows this write request for a named app. No grant shapes change.

  Details: TC-1620

## 1.3.0-beta.47

### Patch Changes

- Updated dependencies [5373fa2]
  - @tinycloud/operations@0.7.0-beta.35

## 1.3.0-beta.46

### Patch Changes

- 5bbc05c: `tinycloud auth login` keeps its browser callback open for the full five-minute sign-in window, so the browser can finish a slow local-network permission prompt. Interactive sign-in also prints a one-time how-to line on stderr after 15 seconds while it waits. JSON output is unchanged.

  Details: TC-1675

## 1.3.0-beta.45

### Patch Changes

- Updated dependencies [9592d3d]
  - @tinycloud/sdk-core@3.3.0-beta.36
  - @tinycloud/node-sdk@3.3.0-beta.36
  - @tinycloud/operations@0.7.0-beta.34

## 1.3.0-beta.44

### Patch Changes

- bba15a4: `tc share publish --json` now reports the sender-history write as `history`: `{"recorded": true}`, or `{"recorded": false, "reason": "HISTORY_UNREADABLE" | "HISTORY_READ_FAILED" | "HISTORY_WRITE_FAILED" | "HISTORY_UNAVAILABLE"}`. The exit status stays 0. The stderr warning names the reason. When a publish with `--notify` delivers but its confirmation cannot be saved, the warning also names the share id and CID to keep, and `history` stays `{"recorded": true}`. A failed delivery-confirmation write on `share notify` names its reason too.

## 1.3.0-beta.43

### Patch Changes

- f2cb165: `tc delegation revoke <cid>` now revokes an owner-signed grant (such as one from `tc auth grant`) from a profile that has no local record of it, for example another CLI profile or machine of the same owner. When the profile has no matching record, the CLI reads the owner's delegation records from the node and uses that record's space only if the grant was issued by the signed-in owner, directly or through a chain of delegations recorded on the node that ends at the owner or the signed-in session key, and every space it covers is one plain space id that belongs to that owner; a CID the node does not list, an issuer or space that does not match, or an ambiguous record keeps the existing `RAW_RECAP_RESOURCE_UNSUPPORTED` refusal, now saying "this CLI profile has no record of this grant and the node's record does not match the signed-in owner". A locally recorded grant still resolves first and unchanged. An agent that presents a revoked grant now gets "This grant was revoked. Ask the owner for a new grant" instead of a bare authentication error: the CLI reports it as `GRANT_REVOKED` (exit 5, the same code and exit as `tc replica`), and operations (including `knowledge list|read` and the MCP tools) keep `AUTH_REQUIRED` with that message, only when the node's 401 says the delegation (or one it derives from) was revoked; any other 401 is unchanged.
- Updated dependencies [f2cb165]
  - @tinycloud/operations@0.7.0-beta.33

## 1.3.0-beta.42

### Patch Changes

- 0524256: Keep broker configuration outside Courier and resolve the owner's gh credential at runtime without copying it. Woken agents use a separate home and Courier-only identity snapshot. Existing broker token files are no longer used; owners configure the broker again after signing in with gh.

  Refuse protected-root traversal, gated executable aliases/copies, local network destinations and additional GitHub, registry and credential-access commands.

  Require registered executable identities for tool allowances, including Courier entrypoints and wrappers. Unregistered executables and package launchers fail closed. Protect registered tools from agent edits and preserve the installed census across automatic refreshes; owners refresh it after tool upgrades.

  Inspect interpreter script and preload files independently of their extension, and classify agent and gated-tool package entrypoints by their package manifest. Require the installed executable census and use its git identity for guard probes.

  Details: TC-1634

## 1.3.0-beta.41

### Patch Changes

- e8448a4: `tinycloud auth request --preset apps-agent --write --app <app_id>` no longer lets the agent change an app's own code or manifest (TC-1620). KV put is now granted only on `<app_id>/knowledge/` and `<app_id>/prefs/` (the two folders the sample apps' manifests write to), and KV get and list stay on all of `<app_id>/`; SQL read and write are unchanged. A put on `<app_id>/app/` (which holds the code and the stored `app/manifest.json` and `app/install.json`), on the root-level `<app_id>/manifest.json` or `<app_id>/install.json`, or on any other folder is refused by the node. The scope printed to the agent and to the owner says so ("write knowledge and data files ... cannot change the app's code, manifest or install record"; SQL write is described separately: it can change rows and, because of TC-1581, table structure), and a request file that still asks for a put on the whole app, or on any path outside those folders, is listed under "MORE than the apps-agent preset" and needs the owner's explicit confirmation. Grants issued with the earlier wide write shape keep working until they expire (7 days) or are revoked.

## 1.3.0-beta.40

### Patch Changes

- c06c304: Courier profile permission errors use code profile-permissions; documentation wording updates.

## 1.3.0-beta.39

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.35
- @tinycloud/operations@0.7.0-beta.32

## 1.3.0-beta.38

### Minor Changes

- a553392: Agents can pick up the apps a user installed, from their `applications` space.
  - `tinycloud knowledge list` lists the apps that have a knowledge bundle (`<app_id>/knowledge/index.md`) with their concept files, merging the account application registry when the session can read it. `tinycloud knowledge read <app_id> [concept]` returns the index (with its links) or one concept with its frontmatter parsed. A grant that does not cover the request exits 5 and the hint lists the requests to make, with the real app id; a mistyped app id or concept exits 2 with the reason. Operations `tinycloud.knowledge.list@1` and `tinycloud.knowledge.read@1`; MCP tools `tinycloud_knowledge_list` and `tinycloud_knowledge_read` (local and hosted). Files and names come from the user's space, so they are marked untrusted in the tool result and escaped in terminal output (`--json` stays exact).
  - `tinycloud auth request --preset apps-agent` asks for **read-only** access: KV get and list, SQL read, on the `applications` space, up to 7 days. `--app <app_id>` (repeatable, up to 5) limits it to those apps' `<app_id>/` prefixes, which is the recommended ask. Don't request `--write` during the tiny-apps beta. It currently also allows changes to the app's own code and manifest; the narrowed write ships in TC-1620. (The flag adds KV put and SQL write for the named apps and is refused without `--app`.) Because of how TinyCloud permissions work today, SQL write also lets the agent create, change or drop those apps' tables, and the scope text says so; TC-1581 (node-side: `sql/write` must not permit DDL) is the real cure. Neither variant carries KV delete, SQL admin or schema, another service or space. The preset cannot be combined with `--cap`, `--permission`, `--manifest` or `--expiry`, and `--device` is refused because device approval cannot grant SQL.
  - `tinycloud auth grant` now resolves the request file once, the way the signer reads it (an entry with no `space` is in the owner's `applications` space; an empty space is refused; entries with the same service, space and path are merged), and prints, gates and signs that one list. Before signing it prints every permission in plain words (service, space, path, actions; delegation abilities as "can give other people or agents access on your behalf" and "can cancel access you gave"; unknown services and actions raw and marked unrecognised), once each, with the requested lifetime. The preset wording appears only when the permissions, the owner's own `applications` space and the 7-day lifetime all match. For a request that touches an `applications` space, anything the preset could never grant is marked `!`, listed first under "MORE than the apps-agent preset" and signed only after `--yes` or an interactive confirmation; without a terminal it exits 2 and signs nothing. A request with the `tinycloud.vault` shorthand, a service the signer cannot sign, or more than one space is refused with exit 2 before anything is printed or signed. The request's `sessionDid` and `requestedExpiry` are checked before anything is printed. Text from the request is escaped in the listing, the interactive prompt and every error message: on a terminal, `outputError` now escapes control characters, ANSI, bidi and zero-width characters (U+200B-200F, U+202A-202E, U+2066-2069, U+2028/2029, C1, U+FEFF) in every message and hint for every command. JSON output (stdout and the JSON error form on stderr, which a redirected `auth grant req.json > grant.json` still prints to a terminal) writes those characters as `\uXXXX` escapes: it parses to the same text. Refusal messages echo at most 5 items of 80 characters.
  - The `tc-cli` skill has a "Pick up a user's apps" section.
  - Fix: a delegation signed with an empty path (`tinycloud.kv:applications::get,list`, the whole service in a space) was rejected on import by the runtime validator, and `delegation revoke` could not bind its space. Both now accept it; other malformed resources are still refused. The validator now uses one pattern for both resource forms and drops an unreachable branch, so the web-sdk root bundle does not grow.

### Patch Changes

- Updated dependencies [a553392]
  - @tinycloud/operations@0.7.0-beta.31
  - @tinycloud/node-sdk@3.3.0-beta.34

## 1.3.0-beta.37

### Patch Changes

- a05cfe5: `tc auth login` (`--device`, `--paste` and browser) and `tc init` now wait for OpenKey to host the account's space before reporting success (TC-1608). OpenKey hands the CLI its delegation while it is still hosting the space in the background, so the first storage command could fail with `404 Space not found`. When OpenKey reports `spacePending`, the login shows "Setting up your space…" and re-reads the space with the saved session (read-only, no new signature, ability or delegation) for up to 150 seconds. The wait follows OpenKey's readiness: `spaceReady: null` with `spacePending: true` keeps waiting, with or without a `spaceError` (a timeout or a failure OpenKey is retrying; the error is shown as progress), and a transient read failure does not end it. Only `spaceReady: false` with a `spaceError` is final and fails with `SPACE_SETUP_FAILED`, carrying OpenKey's error text and code. If the 150 seconds pass, the login fails with `SPACE_SETUP_PENDING` and OpenKey's last report. Both exit 1 and keep the saved session, so retrying or approving again in OpenKey re-runs the setup. `spaceReady: false` alone (OpenKey will not host it) and a session with no kv grant to read with print a warning. Logins whose delegation says nothing about the space, or says it is ready, do not wait.

  An OpenKey profile's `SPACE_NOT_HOSTED` error, including one on the primary space when no `--space` is given (which previously got no `SPACE_NOT_HOSTED` error at all), no longer tells you to run `tc space host`, which cannot work without a signer. It says: "OpenKey is still setting up your space. Wait a minute and retry; approving again in OpenKey re-runs the setup." Local-key owners keep the `tc space host` hint.

## 1.3.0-beta.36

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.33
- @tinycloud/operations@0.6.1-beta.30

## 1.3.0-beta.35

### Patch Changes

- Updated dependencies [6ad58de]
  - @tinycloud/operations@0.6.1-beta.29
  - @tinycloud/sdk-core@3.3.0-beta.31
  - @tinycloud/node-sdk-wasm@1.7.8-beta.0
  - @tinycloud/node-sdk@3.3.0-beta.31

## 1.3.0-beta.34

### Patch Changes

- 9b46aa1: `tc share` now names a failure by class instead of a bare `INVALID_ARGUMENT` "share operation failed". A share upload the node answers with `404 Space not found` fails with `SPACE_NOT_READY` (exit 4; a known node problem, retry after the node update).

  Behaviour change for scripts: share failures that used to report `INVALID_ARGUMENT` (exit 2) now report a typed code and exit code:

  | Signal                                                         | code                | exit |
  | -------------------------------------------------------------- | ------------------- | ---- |
  | upload 404 "Space not found"                                   | `SPACE_NOT_READY`   | 4    |
  | HTTP 401 / unauthenticated                                     | `AUTH_REQUIRED`     | 3    |
  | HTTP 403 / forbidden                                           | `PERMISSION_DENIED` | 5    |
  | HTTP 404                                                       | `NOT_FOUND`         | 4    |
  | HTTP 5xx, 408, 429                                             | `NODE_UNAVAILABLE`  | 7    |
  | node unreachable (a `fetch failed` error, `ECONNREFUSED`, ...) | `NETWORK_ERROR`     | 6    |
  | HTTP 400, 422                                                  | `INVALID_ARGUMENT`  | 2    |
  | other 4xx                                                      | `NODE_REJECTED`     | 1    |

  A `TypeError("fetch failed")` that used to be `INVALID_ARGUMENT` is now `NETWORK_ERROR`. The message carries the HTTP status and a plain upstream code, never response text; the original error is kept as `cause`. Errors with no status or network signal are unchanged.

## 1.3.0-beta.33

### Patch Changes

- 72ff62a: `share publish`: `.jsx` and `.tsx` files are published as `text/jsx` and `text/tsx` instead of `application/octet-stream`. `--to anyone --action edit` now exits 2 with `INVALID_ARGUMENT` instead of silently publishing a read-only link. The tc-cli skill documents publishing Markdown, single-file HTML and JSX artifacts, and getting the link with `share show <id> --reveal-link`.

## 1.3.0-beta.32

### Patch Changes

- Updated dependencies [fc88c48]
  - @tinycloud/sdk-core@3.3.0-beta.30
  - @tinycloud/node-sdk@3.3.0-beta.30
  - @tinycloud/operations@0.6.1-beta.28

## 1.3.0-beta.31

### Patch Changes

- Updated dependencies [e99a127]
  - @tinycloud/node-sdk@3.3.0-beta.29
  - @tinycloud/operations@0.6.1-beta.27

## 1.3.0-beta.30

### Patch Changes

- Updated dependencies [ac612c0]
  - @tinycloud/sdk-core@3.3.0-beta.28
  - @tinycloud/node-sdk@3.3.0-beta.28
  - @tinycloud/operations@0.6.1-beta.26

## 1.3.0-beta.29

### Patch Changes

- b2b3b97: Replication: read `TC_REPLICATION_GRANT_TTL_MS` and `TC_REPLICATION_MAX_BYTES` in the CLI; both must be plain decimal integers (grant TTL at most 7 days), otherwise the command fails with a usage error naming the variable.

## 1.3.0-beta.28

### Patch Changes

- Updated dependencies [4aae658]
  - @tinycloud/sdk-core@3.3.0-beta.27
  - @tinycloud/node-sdk@3.3.0-beta.27
  - @tinycloud/operations@0.6.1-beta.25

## 1.3.0-beta.27

### Patch Changes

- @tinycloud/node-sdk@3.3.0-beta.26
- @tinycloud/operations@0.6.1-beta.24

## 1.3.0-beta.26

### Minor Changes

- 87a137e: Retry node `NODE_BUSY` and `REQUEST_TIMEOUT` answers automatically. Both mean nothing was applied, so the services now retry them under the existing `retryPolicy` through the new `ServiceContext.invokeWithRetry(url, build)`, which calls `build` once per attempt so every attempt carries a freshly signed invocation (the node answers a repeated invocation with 409, so re-sending one could never succeed). `ServiceContext.fetch` itself no longer retries. A context without `invokeWithRetry` sends once. The policy: at most 4 attempts in about 12 s, honouring the node's `Retry-After` (capped at the remaining budget) and otherwise backing off exponentially with full jitter (250 ms base, 4 s cap). Aborts and per-request timeouts end the wait at once, and `OUTCOME_UNKNOWN` is never retried. `defaultRetryPolicy` changes accordingly (its retryable codes are now `NODE_BUSY` and `REQUEST_TIMEOUT`; `NETWORK_ERROR` and `TIMEOUT` are no longer listed because no service read them), and `RetryPolicy` gains an optional `maxTotalMs`. Opt out with `retryPolicy: { maxAttempts: 1 }`.

  The CLI gains `--no-retry` and `TINYCLOUD_RETRY=0` for monitors and probes that must see the node's honest `NODE_BUSY`. KV responses (and `tc kv get|put|delete --json`) report `attempts` and `backoffMs`.

### Patch Changes

- Updated dependencies [87a137e]
  - @tinycloud/node-sdk@3.3.0-beta.25
  - @tinycloud/sdk-services@3.3.0-beta.25
  - @tinycloud/operations@0.6.1-beta.23
  - @tinycloud/sdk-core@3.3.0-beta.25

## 1.3.0-beta.25

### Patch Changes

- b6d0b9f: `tc account` commands now exit with `ACCOUNT_ACCESS_REQUIRED` (exit 5) before calling the node when the session lacks the account-space abilities that command invokes, as with a plain OpenKey login. Each command checks its own set (registry reads and writes, `kv/del` for removals, `space/list` and `capabilities/read` on the primary space for the commands that list spaces or delegations). `account delegations revoke` needs no session ability on a local-key profile (it signs with the owner wallet) and is refused with the `tc delegation revoke` command on an OpenKey profile, which cannot carry the raw-CID revoke ability, and the error prints the `tc auth request --grant --cap ...` command that grants exactly those, with a `--paste` variant. `tc auth request --grant` gains `--paste` (OpenKey owner profiles) for browsers that cannot reach the CLI's loopback callback, and a grant that spans several spaces now says up front how many OpenKey approvals it takes (one per space) and numbers each prompt. The account registry sync skip is recorded once per process as a debug event only (`TinyCloud_debug=true`).
- Updated dependencies [b6d0b9f]
  - @tinycloud/node-sdk@3.3.0-beta.24
  - @tinycloud/operations@0.6.1-beta.22

## 1.3.0-beta.24

### Minor Changes

- d2ad845: `tc delegation create` now signs and activates the delegation through `delegateTo`, reads it back through the node's account delegation query, and prints its CID only once the node lists it as active (`DELEGATION_NOT_CONFIRMED` otherwise). `tc delegation list` and `tc delegation info` use that query (`POST /delegation/query`) via `account.delegations.query()`, which includes delegations signed by the session key; `list` gains `--space`, and `--to` accepts a `did:key` with a `#fragment`. Previously `create` and `list` sent `tinycloud.delegation/create` and `tinycloud.delegation/list` invocations that the node does not handle (it answered an empty 200, surfaced as a JSON parse error), and `info` called a method that did not exist.

  A plain `tc auth login` now also requests `tinycloud.delegation/list` on the default space (OpenKey's default grant omits it). A session that lacks it, on the account space and its own space, gets a `PERMISSION_DENIED` error saying to run `tc auth login` again. `DelegationManager.query()` signs for the account space and falls back to the session's own space when the node refuses (403).

  Breaking: removed `DelegationManager.create()` (use `TinyCloudNode.delegateTo()`), `DelegationManager.list()` (use `account.delegations.query()`), `TinyCloudNode.delegate()` (use `delegateTo()`), `TinyCloudNode.listDelegations()` (use `account.delegations.query()`), and the web-sdk `TinyCloudWeb.delegate()` (use `delegateTo()`) and `TinyCloudWeb.listDelegations()` (use `account.delegations.query()`). They sent invocations the node never handled, so they never worked. `account.delegations.list()` is not a replacement: it reads the SQL index and omits session-signed delegations. Also removed the `delegationManager` option from `SharingService` config; sharing uses `createDelegation` or `createDelegationWasm`.

  `TinyCloudNode.delegateTo()` takes a new `requireActivation` option: when set, it throws when the node answers 200 but lists a target space under `skipped` (a space it does not host), naming that space; this used to look like success. It is off by default, since grants to a not-yet-hosted space (e.g. secrets) are valid. `tc delegation create` sets it. `DelegationManager.getChain()` and `checkPermission()` now return an `UNSUPPORTED_OPERATION` error when the node answers with an empty body.

### Patch Changes

- Updated dependencies [d2ad845]
  - @tinycloud/sdk-core@3.3.0-beta.23
  - @tinycloud/node-sdk@3.3.0-beta.23
  - @tinycloud/operations@0.6.1-beta.21

## 1.3.0-beta.23

### Patch Changes

- dc67c26: Breaking change to `tc replica report --json` (beta feature, from #551 / TC-841): the report is now read-only and never starts a replication runtime, so `replicas` is always `[]` and `replicasUnavailable` is always `true`. Per-partition pinned counts moved from `replicas[].pinned` to `partitions[].pinned` (each partition has `idHash`, `host`, `space`, `pinned`). Scripts reading `.replicas[].pinned` should read `.partitions[].pinned` instead. Live replica status returns with TC-1309.

## 1.3.0-beta.22

### Patch Changes

- 270c284: Clarify the share link fragment wording in the tc-cli skill reference.

## 1.3.0-beta.21

### Patch Changes

- Updated dependencies [6e7ad8f]
  - @tinycloud/share-sdk@1.2.0-beta.6
  - @tinycloud/sdk-core@3.3.0-beta.22
  - @tinycloud/node-sdk@3.3.0-beta.22
  - @tinycloud/operations@0.6.1-beta.20

## 1.3.0-beta.20

### Minor Changes

- 02c0a44: Owner-signed artifact pin for addressed shares (TC-1428). The Policy/v3 envelope gains an optional `artifactPin` field (artifact id, version, sha256 of the version's `manifest.json`, and the sha256 and size of the stored ciphertext file the share reads). It is covered by the envelope signature, so the existing envelope version and the node are unchanged (the node reads the envelope as opaque JSON). `share-sdk` adds a small verification module (`verifyArtifactShare`, `assertArtifactBinding`, `verifyArtifactFileBytes`, `verifyArtifactManifestBytes`, `buildArtifactPin`): a share that reads `artifacts/` without a pin that matches its content source is refused, a pinned share cannot grant edit, and fetched bytes that do not hash to the pinned digest are refused before any decrypt request. `inspectShare` reports `artifact: { id, version }`. `share publish --artifact` signs the pin for addressed shares.

  Breaking for old viewers: the envelope schema is strict, so a viewer that predates this release rejects an envelope with `artifactPin` rather than showing it. Update the viewer's `@tinycloud/share-sdk` before publishing pinned addressed shares. The owner is the trusted signer; the node has no write-once ACL, so an owner can still overwrite a version file and recipients then fail closed. Bearer artifact shares have no envelope and carry no pin yet.

### Patch Changes

- Updated dependencies [02c0a44]
  - @tinycloud/share-envelope@1.2.0-beta.0
  - @tinycloud/share-sdk@1.2.0-beta.5
  - @tinycloud/sdk-core@3.3.0-beta.21
  - @tinycloud/node-sdk@3.3.0-beta.21
  - @tinycloud/operations@0.6.1-beta.19

## 1.3.0-beta.19

### Patch Changes

- Updated dependencies [cce8b26]
  - @tinycloud/sdk-core@3.3.0-beta.20
  - @tinycloud/node-sdk@3.3.0-beta.20
  - @tinycloud/operations@0.6.1-beta.18

## 1.3.0-beta.18

### Patch Changes

- fff4c72: Add the node release pin and verified downloader that `tc node install` will use. The CLI embeds SHA-256 pins for the TinyCloud node tarballs and checks the download against them before unpacking. No command uses them yet.

## 1.3.0-beta.17

### Patch Changes

- Updated dependencies [eb9defd]
  - @tinycloud/sdk-core@3.3.0-beta.18
  - @tinycloud/node-sdk@3.3.0-beta.18
  - @tinycloud/operations@0.6.1-beta.17

## 1.3.0-beta.16

### Patch Changes

- Updated dependencies [daf8561]
  - @tinycloud/share-sdk@1.2.0-beta.4
  - @tinycloud/sdk-core@3.3.0-beta.17
  - @tinycloud/node-sdk@3.3.0-beta.17
  - @tinycloud/operations@0.6.1-beta.16

## 1.3.0-beta.15

### Patch Changes

- Updated dependencies [18b6c9f]
  - @tinycloud/node-sdk@3.3.0-beta.16
  - @tinycloud/operations@0.6.1-beta.15

## 1.3.0-beta.14

### Patch Changes

- Updated dependencies [e68e911]
  - @tinycloud/share-sdk@1.2.0-beta.3
  - @tinycloud/sdk-core@3.3.0-beta.15
  - @tinycloud/node-sdk@3.3.0-beta.15
  - @tinycloud/operations@0.6.1-beta.14

## 1.3.0-beta.13

### Patch Changes

- Updated dependencies [d84e379]
  - @tinycloud/share-sdk@1.2.0-beta.2
  - @tinycloud/sdk-core@3.3.0-beta.14
  - @tinycloud/node-sdk@3.3.0-beta.14
  - @tinycloud/operations@0.6.1-beta.13

## 1.3.0-beta.12

### Patch Changes

- Updated dependencies [c2fd94b]
  - @tinycloud/share-sdk@1.2.0-beta.1
  - @tinycloud/sdk-core@3.3.0-beta.13
  - @tinycloud/node-sdk@3.3.0-beta.13
  - @tinycloud/operations@0.6.1-beta.12

## 1.3.0-beta.11

### Patch Changes

- Updated dependencies [2292db7]
  - @tinycloud/sdk-services@3.3.0-beta.11
  - @tinycloud/node-sdk@3.3.0-beta.11
  - @tinycloud/operations@0.6.1-beta.11
  - @tinycloud/sdk-core@3.3.0-beta.11

## 1.3.0-beta.10

### Minor Changes

- 116b214: Artifact versions for `share publish` (TC-1428). `share publish --artifact <id|new>` stores the file as a write-once version under `artifacts/<id>/versions/<n>/` (created with `If-None-Match: *`, `manifest.json` written last) in the owner's space and pins the share to that version: bearer and addressed shares read one version file and never carry `put`. Re-publishing the same bytes to a bearer link returns the same version and changed content makes the next, so an agent retry is safe. An addressed share is a fresh encryption each time, so each is its own version; the manifest records only the sha256 of the stored bytes, never of the plaintext. `share versions <id>` lists versions and the shares pinned to each. `--action edit` on an artifact share is refused; every artifact share pins one version. The layout helpers (`publishArtifactVersion`, `listArtifactVersions`, `parseArtifactManifest`, path helpers) are a new `@tinycloud/share-sdk/artifact` entry point, kept out of the main barrel so browser bundles do not carry them. No node change.

  The built-in `builtin:share-publishing` manifest now also requests `artifacts/` (get, metadata, put, list). Profiles signed in before this version must sign in again to use `--artifact` (`auth login --device --manifest builtin:share-publishing`); other `share publish` use is unchanged. Versions are kept by default and count against the owner's storage; reclaiming bytes depends on history GC (TC-1277).

### Patch Changes

- Updated dependencies [116b214]
  - @tinycloud/share-sdk@1.2.0-beta.0
  - @tinycloud/sdk-core@3.3.0-beta.10
  - @tinycloud/node-sdk@3.3.0-beta.10
  - @tinycloud/operations@0.6.1-beta.10

## 1.3.0-beta.9

### Patch Changes

- ef9653b: Sign the share delivery authorization with the primary session key. The node records the signer as the delivery's sender key, and the SDK binds and countersigns the receipt with the primary session key; when a runtime grant held by another key covered the shared file, `tc share publish --to <email> --notify` rejected its own receipt and the recipient was never emailed (exit 9, `partial-failure`).
- Updated dependencies [ef9653b]
  - @tinycloud/node-sdk@3.3.0-beta.9
  - @tinycloud/operations@0.6.1-beta.9

## 1.3.0-beta.8

### Patch Changes

- Updated dependencies [f97d73d]
  - @tinycloud/sdk-core@3.3.0-beta.8
  - @tinycloud/node-sdk@3.3.0-beta.8
  - @tinycloud/operations@0.6.1-beta.8

## 1.3.0-beta.7

### Patch Changes

- 94566db: `auth logout` denies the profile's replica gate durably before it removes `session.json` and `key.json`, then erases local replicas. If the gate cannot be denied, credentials and replicas stay in place and the command exits with a retryable error. Fence unchanged inactive replica gates across online logout, reject changed gates before local credential removal, and give an actionable retry path for an interrupted orphan logout marker. A plain `auth logout` retry now resumes a committed local logout whose credential removal failed, instead of asking to discard local changes. Logout and startup recovery refuse without changes when the pending logout belongs to a different principal than the current session.
- b22a88d: A plain OpenKey `auth login` on a profile that already belongs to an owner now names that owner's space, so OpenKey preselects the owner's key without `--owner`. The signed owner is still verified after approval.
- 3d24566: Cancelling a prepared OpenKey login before approval now takes one path whether it comes from terminal Ctrl-C or a SIGINT/SIGTERM sent to a non-interactive process: the CLI asks OpenKey to cancel the handoff (best effort, two-second timeout), saves nothing and exits 130 `CANCELLED`, as the exit-code table documents. Previously a non-interactive signal never reached OpenKey, and terminal Ctrl-C exited 3.
- 1289240: A completed prepared OpenKey login now exits promptly under Node even when the browser opened a connection to the loopback callback and never sent a request, as Chromium does when Local Network Access refuses the callback. Closing the callback listener now also drops connections that never sent a request; the ACK's own connection closes after its response.
- d2c1e10: A failed or cancelled replica-enabled OpenKey login (interrupt, expiry, invalid signature, paste EOF or a failed commit) no longer signs out the profile's existing session: it never denies an already-active replica gate, so the live session's unsynced writes are kept. Only a gate that the failed attempt itself bound, and that no saved session holds, is denied again.
- 8332bc6: Classify replica storage-budget failures as storage-full exits and expired consent as permission-denied with sign-in renewal guidance.
- 90bc0ae: Report the node's retry signals (tinycloud-node #347) as typed errors instead of `NETWORK_ERROR`, for SQL, DuckDB and KV get, head, list, put and delete.
  - `NODE_BUSY`: `503 sql_busy:<stage>` or `unavailable_retryable`. Nothing was applied. `meta.stage` (`lock_wait`, `hydration`, `artifact_transfer` or `identity_resolution`) when the node names one.
  - `REQUEST_TIMEOUT`: `503 request_timeout`. The node's deadline passed before any write began, so nothing was applied.
  - `OUTCOME_UNKNOWN`: `500 outcome_unknown`. A write may have been applied; read it back before retrying a non-idempotent operation.

  `meta.retryable` says whether a retry is safe and `meta.retryAfterMs` carries the node's `Retry-After`. The SDK still never retries by itself. A response without these bodies, such as a 503 or 500 from node 1.20.6, keeps its old code, and real transport failures stay `NETWORK_ERROR`. New export: `nodeRetryError`.

  Fix: a conditional KV `put` or `delete` that got a 503 was reported as `KV_CONFLICT`. A 503 is never a conflict; the node's precondition failure is its 412, still `KV_PRECONDITION_FAILED`. The SDK no longer produces `KV_CONFLICT` itself (callers that handle it keep working). A conditional write's 503 is now `NODE_BUSY` or `REQUEST_TIMEOUT` with the typed body, otherwise `KV_WRITE_FAILED` (put) or `NETWORK_ERROR` (delete) with `meta.status` 503.

  `tc` prints a plain message for the new codes ("The node is busy, try again in 5 s.", "Outcome unknown: the node may have applied the write. Check before retrying.") and exits 7.

- c980014: Legacy local replica get, list, and status with an owner session require its persisted replica stamp and the active profile gate. A session without an owner DID (a delegate's imported grant) reads only while the profile has no gate and no committed sign-out. Serialize reads and output with sign-out denial, and refuse a pending logout marker before and after local reads so interrupted cleanup cannot serve retained replica data.

  Legacy logout cleanup accepts only the approved path, type, and inode inventory recorded in the logout marker; an unlisted or replaced file leaves cleanup pending instead of broadening `--discard-local-changes`.

- 0c4c6b2: `ProfileReplicaPurge.deny` with `{ deferErase: true }` now accepts only `reason: "sign_out"` and returns `ProfileReplicaDeferredDenyOutcome`, whose committed `denied` always carries `resumeToken`. `ReplicaEraseReport.deferred: true` marks a pass held by a deferred denial, so `remaining: 0` there is not completion. node-sdk exports the full contract `ProfileReplicaPurge`, requires the displayed `approval` in `prepareLogoutPending`, and reports `purgePending` from inspected status while a deferred denial or any intent remains.

  A v1 logout marker records the epoch its denial actually committed (`deniedEpoch`) in the same locked section as the deny, and every later check compares with it. A sign-out interrupted between its deny floor and gate writes is completed by the next `auth logout` (`@tinycloud/replica/profile-gate` adds `readLogoutGate`, `advanceInactiveGate` and `REPLICA_DENY_FLOOR_FILE`); reads report "a previous sign-out was interrupted; re-running `tc auth logout` completes it". A restored older gate under a recorded denial refuses with the `tc profile delete` route.

  `auth logout` by an account other than the one whose replicas the profile holds writes no marker and leaves that account's gate, floor and replicas untouched: it signs out, removes its own session and key, and erases the profile's legacy `replicas/` mirror (replayed at startup after a crash). `--revoke` there revokes only grants on the signed-in account's spaces.

  When startup recovery refuses a pending logout because a credential file is unreadable, the message now names that file (`session.json` or `profile.json`).

  CLI-bound storage and purge name the CLI's `replication/events.jsonl` and `events.jsonl.1` diagnostics logs (`diagnosticFiles`). With a readable gate, those exact names count as known only while they are regular files, so a fully synced profile signs out without `--discard-local-changes`; a symlink there stays unknown.

- Updated dependencies [29440be]
- Updated dependencies [86815bd]
- Updated dependencies [e7f709d]
- Updated dependencies [94566db]
- Updated dependencies [38980b0]
- Updated dependencies [a7cdfe0]
- Updated dependencies [94566db]
- Updated dependencies [94566db]
- Updated dependencies [94566db]
- Updated dependencies [90bc0ae]
- Updated dependencies [0c4c6b2]
  - @tinycloud/node-sdk@3.3.0-beta.7
  - @tinycloud/sdk-core@3.3.0-beta.7
  - @tinycloud/sdk-services@3.3.0-beta.7
  - @tinycloud/operations@0.6.1-beta.7

## 1.3.0-beta.6

### Patch Changes

- @tinycloud/node-sdk@3.2.6-beta.6
- @tinycloud/operations@0.6.1-beta.6

## 1.3.0-beta.5

### Minor Changes

- baca422: Pin profile and replica directories before SQLite opens during reset and sync, and for local report reads and logout cleanup. Reject whole-profile aliases, symlinked replica roots, entries, database files and persisted report descendants, changed SQLite identities, and expired profile descriptors before access. Gate legacy replica reads on pending logout, including aliases and in-flight reads. Resume cleanup of verified empty legacy replica directories after an interrupted purge without deleting unknown files.

  `@tinycloud/operations` resolves user-owned symlinked TinyCloud home directories to a pinned real directory while refusing aliases inside a profile; profile JSON reads verify leaf identity. `@tinycloud/replica` creates SQLite database files exclusively for concurrent openers and checks their identity before migration; on macOS and Windows, replica removal checks each known file and directory before nonrecursive deletion and stops on a changed or unknown entry.

  Breaking change (beta feature): `tc replica report` now reads persisted events and identity partitions without starting a replication runtime. `--purge` and `--clear-pending` refuse with exit 2 `REPORT_READ_ONLY`. Use `tc replica reset --replica <name> --purge` only as a partial alternative for named local replicas. Flag-owned purge and pending clearing have no equivalent yet; TC-1309 tracks safe replacement commands.

### Patch Changes

- Updated dependencies [baca422]
  - @tinycloud/operations@0.6.1-beta.5
  - @tinycloud/node-sdk@3.2.6-beta.5

## 1.2.6-beta.4

### Patch Changes

- 9891ed9: Replication: add the shared replica contract for browser and node/CLI storage adapters: the lifecycle gate (`ReplicaGateTx.run`, session stamps, scoped deny), the grant-lifetime policy, the quota seams, the options `grantTtlMs`, `maxBytes` and `minFreeBytes`, and new status fields and events. It adds `@tinycloud/sdk-services/kv/replication/contractConstants`, `/grantPolicyConstants` (numeric policy constants only, with the original names re-exported from `/contractConstants`) and `/grantPolicyTypes`. Diagnostics allowlists, `TelemetryEvents` and CLI debug output cover the new values.

  Source-breaking for exhaustive consumers (replication is beta): switches over these types must now handle `ReplicaState` `gated`, `ReplicationReason` `replica_gated`, the `replication.grant` and `replication.lifecycle` events, sync `trigger: "peer"` and sync `class: "lifecycle"`. Browser ungated `inspectStatus` now returns a discriminated `ReplicaInspectedStatus { redacted: true }` branch without grant, authority or errors; consumers must narrow before reading those fields. Browser `admitPage` takes the exact signed ciphertext-row `deltaBytes` instead of plaintext `blobBytes`/entry count; node's admission hook retains its existing shape.

  `ReplicaGateAccess` now carries a prederived `principalHash` instead of a raw principal; browser `run` requires gate/account key IDs and derives hashes outside IDB transactions. `ReplicaBrowserGateTx` returns a typed private-key snapshot for this derivation, and `ReplicaGatedStorage.open` no longer inherits the unstamped Phase 1 overload. Browser partition-index entries add private-HMAC `lookupId` and nonsecret `ownerDevice` for owner status and scoped purge without decrypting the sealed owner device.

  Phase 2 `ReplicaGatedHandle` requires the opaque `replicaId` supplied by the adapter. Consent-deadline grant events are emitted only for already opened handles with that id; pre-open expiry is reported by lifecycle/recovery, never a raw-prefix or unsalted identifier. `ReplicaLifecycleGate.consentDeadline(stamp)` exposes only the immutable persisted deadline to the main-thread timer, including compact session restore without a fresh anchor; it never derives one from first install.

  The browser contract also defines the origin-wide deny tombstone outside the deletable IndexedDB database, its fail-closed gate semantics, and the lock requirement across lifecycle mutations.

  Browser schema v2 destructively replaces legacy plaintext replica-owned v1 stores only after preserving the origin denial floor; pre-v2 persisted stamps cannot restore. The RC1 per-partition databases remain untouched.

  Establishment takes `{ consentAnchor }`, not `{ siweIssuedAt }`: validated signed SIWE or an independently verified **owner-authorizing** delegation proof supplies finite recency, never a new child minted from old consent. With only a compact leaf or no owner proof timestamp, establishment refuses `not_established` and KV uses the network; matching persisted stamps may restore. Node `pending.json` operations require the profile lock across gate check and file access; deny records a durable identity generation with the pending intent. `activationAllowed` returns false for a null gate principal. Browser replica identifiers use private nonextractable gate-HMAC keys, and account KV metadata/content is sealed with separate account keys; denial or seven-day consent expiry shreds both key records before purge. This limits replica-owned storage plaintext but does not claim confidentiality against a raw browser-profile reader with a valid signed-in session (CONTRACT.md).

  Replica consent from full SIWE requires verified signed `issuedAt`, finite signed `expirationTime` and an exact-space uncaveated KV get+sync witness. Expirationless or otherwise unanchored SIWE can remain network-valid but cannot establish, mint or renew a replica; refused stamps never fail network sign-in/restore, and restore never establishes. A same-principal fresh SIWE does not extend the persisted deadline: controller mint and adapter effective expiry are capped by the gate's durable deadline.

  The browser origin-wide encoded-row budget includes a reserved device bucket for sealed owner-device and grant/first-install rows, admitted with partition rows before any put and released on deny. Native CryptoKey serialization and IndexedDB allocation remain unobservable; node admission is unchanged.

  Compact `sessionOnly` restore requires both a matching stamp/active installed grant **and the current session's own uncaveated get authority** for the requested key or list prefix. A `sessionGrant` refusal cannot be overridden by a stored device grant; compact sessions never mint or renew. Plain logout still ends the network session, while `logout --revoke` keeps it if online revocation fails and leaves the replica denied for retry.

  Browser erase retains a keyless opaque/numeric `purged: true` meta tombstone to fence stale handles. Its measured bytes remain charged until deletion or same-partition replacement; replay releases zero and cannot double-subtract quota.
  - @tinycloud/node-sdk@3.2.6-beta.4
  - @tinycloud/operations@0.6.1-beta.4
  - @tinycloud/sdk-core@3.2.6-beta.4

## 1.2.6-beta.3

### Patch Changes

- Updated dependencies [41e5fca]
  - @tinycloud/node-sdk@3.2.6-beta.3
  - @tinycloud/operations@0.6.1-beta.3

## 1.2.6-beta.2

### Patch Changes

- Updated dependencies [370a8e4]
  - @tinycloud/node-sdk@3.2.6-beta.2
  - @tinycloud/operations@0.6.1-beta.2
  - @tinycloud/sdk-core@3.2.6-beta.2

## 1.2.6-beta.1

### Patch Changes

- Updated dependencies [c92953f]
  - @tinycloud/sdk-core@3.2.6-beta.1
  - @tinycloud/node-sdk@3.2.6-beta.1
  - @tinycloud/operations@0.6.1-beta.1

## 1.2.6-beta.0

### Patch Changes

- Updated dependencies [2aa917e]
  - @tinycloud/node-sdk@3.2.6-beta.0
  - @tinycloud/operations@0.6.1-beta.0

## 1.2.5

### Patch Changes

- Updated dependencies [527c91b]
- Updated dependencies [cfc9d1b]
  - @tinycloud/operations@0.6.0
  - @tinycloud/node-sdk@3.2.5
  - @tinycloud/sdk-core@3.2.5

## 1.2.5-beta.2

### Patch Changes

- Updated dependencies [527c91b]
  - @tinycloud/operations@0.6.0-beta.2

## 1.2.5-beta.1

### Patch Changes

- Updated dependencies [cfc9d1b]
  - @tinycloud/operations@0.6.0-beta.1

## 1.2.5-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.2.5-beta.0
- @tinycloud/operations@0.5.5-beta.0
- @tinycloud/sdk-core@3.2.5-beta.0

## 1.2.4

### Patch Changes

- 016b878: Release the `space list` account-registry change in a new beta (the earlier 1.2.4-beta.1 build predates it).
- 9704c99: The tc-cli and courier skills now find the CLI as `tinycloud` (`node_modules/.bin/tinycloud`, or `$(npm prefix --global)/bin/tinycloud`) and tell agents to run `tinycloud`, so relayed hints no longer reach iproute2's `/usr/sbin/tc`. Requires CLI 1.2.3 or later.
- 0e82bce: `tc space list` no longer fails with `AUTH_REQUIRED` (exit 3) on sessions that lack `tinycloud.space/list`, which no OpenKey or local-key sign-in requests (TC-1083). It now lists the owner's spaces from the account registry (`account/spaces/`) when the session holds `tinycloud.kv/get` and `tinycloud.kv/list` on the account space's `spaces/` prefix, as local-key owner sessions do, and uses `tinycloud.space/list` only when the session holds it. The JSON output keeps `spaces` and `count`; registry entries carry `id`, `name`, `owner`, `type`, `permissions` and `status`.

  A session with neither, such as a default OpenKey owner sign-in (which covers only the `default` space), now fails with `PERMISSION_DENIED` (exit 5) naming both capabilities, instead of a 401 that read as "not authenticated". Owners get the registry read with `tc auth request --grant --cap tinycloud.kv:account:spaces/:get,list`; delegates are told to request it from the owner.

- Updated dependencies [b6038b1]
- Updated dependencies [079afb6]
  - @tinycloud/operations@0.5.4
  - @tinycloud/node-sdk@3.2.4
  - @tinycloud/sdk-core@3.2.4

## 1.2.4-beta.3

### Patch Changes

- Updated dependencies [079afb6]
  - @tinycloud/operations@0.5.4-beta.2

## 1.2.4-beta.2

### Patch Changes

- 016b878: Release the `space list` account-registry change in a new beta (the earlier 1.2.4-beta.1 build predates it).

## 1.2.4-beta.1

### Patch Changes

- 9704c99: The tc-cli and courier skills now find the CLI as `tinycloud` (`node_modules/.bin/tinycloud`, or `$(npm prefix --global)/bin/tinycloud`) and tell agents to run `tinycloud`, so relayed hints no longer reach iproute2's `/usr/sbin/tc`. Requires CLI 1.2.3 or later.
- 0e82bce: `tc space list` no longer fails with `AUTH_REQUIRED` (exit 3) on sessions that lack `tinycloud.space/list`, which no OpenKey or local-key sign-in requests (TC-1083). It now lists the owner's spaces from the account registry (`account/spaces/`) when the session holds `tinycloud.kv/get` and `tinycloud.kv/list` on the account space's `spaces/` prefix, as local-key owner sessions do, and uses `tinycloud.space/list` only when the session holds it. The JSON output keeps `spaces` and `count`; registry entries carry `id`, `name`, `owner`, `type`, `permissions` and `status`.

  A session with neither, such as a default OpenKey owner sign-in (which covers only the `default` space), now fails with `PERMISSION_DENIED` (exit 5) naming both capabilities, instead of a 401 that read as "not authenticated". Owners get the registry read with `tc auth request --grant --cap tinycloud.kv:account:spaces/:get,list`; delegates are told to request it from the owner.

- Updated dependencies [b6038b1]
  - @tinycloud/operations@0.5.4-beta.1

## 1.2.4-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.2.4-beta.0
- @tinycloud/operations@0.5.4-beta.0

## 1.2.3

### Patch Changes

- 135b1ee: `tc kv list --cursor` with a cursor the node rejects now fails with `KV_LIST_CURSOR_INVALID` (exit 2) and a hint to start again without `--cursor`, instead of `NETWORK_ERROR` with a misleading "switch to a reachable profile" hint.
- 11220b4: `tc share receive` on a revoked bearer link now fails with `SHARE_REVOKED` (exit 4, "This share link has been revoked by its sender.") instead of the generic `INVALID_ARGUMENT: share operation failed`.
- 1a8a8a7: Skills resolve the CLI from the agents.tinycloud.xyz private install (`~/.local/share/tinycloud/cli`, or `TC_BIN`), falling back to a global npm install; tc-cli INSTALL.md points at agents.tinycloud.xyz for setup and skill installs.
- 40fab17: Ctrl-C now cancels `tc auth login --method openkey` in a terminal, in both browser and `--paste` mode (TC-1062). Before, the login's interactive code prompt swallowed it and the login kept waiting until its 5-minute timeout. It now stops with `CANCELLED` (exit 130) and saves nothing.
- c13720c: `tc share revoke <id>` now revokes public (anyone-with-the-link) shares. Before, the node refused the revocation with 403 and the link stayed readable until it expired. The command reports `revoked` only when the node confirms it; receiving the link then fails.
  - **Error codes for bearer revokes.**
    - `SHARE_ISSUER_KEY_UNAVAILABLE` (exit 5): the profile cannot sign for the link. Nothing is revoked.
    - `SHARE_LINK_UNAVAILABLE` (exit 4): the stored link is missing, or it doesn't match the record. Nothing is revoked.
    - `SHARE_REVOKE_REJECTED` (exit 4): the node refused. The message includes the node's reason, and nothing is revoked.
    - `SHARE_REVOKE_UNCONFIRMED` (exit 1): the node answered without confirming. The link may already be revoked, history is not marked revoked, and you should check the link before retrying.
  - **History.** Revoking an already revoked share keeps its original `revokedAt`.
  - **Share SDK.** `ShareRevocationAdapter.revokeDelegation` now receives the share `record` next to `delegationCid` and `scope`, and `revokeShare` passes it. Adapters that ignore it still type-check, but code that calls `adapter.revokeDelegation(...)` directly must now pass `record`. `revokeShare` keeps an existing `revokedAt`.
  - **sdk-core.** These are additions only:
    - `parseSignedCompactUcanAttenuation` also returns the verified issuer as `payload.iss`.
    - The new `parseSignedSiweCacao(authorization, expectedCid?)` verifies a wallet SIWE CACAO: size (64 KiB) and nesting (64) limits, the exact-bytes CID, canonical DAG-CBOR, the CACAO shape (integer version 1, no unknown or empty fields, safe-integer chain ID), the ReCap shape and statement, and the EIP-191 signature. It returns the issuer, audience, `expiresAt` and the ReCap attenuation. It does not enforce validity times; callers decide.
  - **node-sdk.** The new `TinyCloudNode.signOwnerRevocation(cid)` signs a wallet (CACAO) revocation that the node's `POST /revoke` accepts from the space owner.

- 9e8e4d1: `tc kv list` can now page through a prefix and say whether a listing is complete (TC-982). The new options:
  - `--limit N` (1–1000) sets the page size;
  - `--cursor C` continues from a previous page;
  - `--all` follows cursors until the listing is complete, and stops with `KV_LIST_CURSOR_STALLED` if the node repeats a cursor.

  `--json` output now includes `truncated` and `nextCursor`; both are `null` when the node doesn't report them. Human output says when more keys follow. The `Size` and `Updated` columns were always empty for a list and still are.

- 024a95f: Install the CLI as `tinycloud` as well as `tc`, so it works on Linux hosts where iproute2's `/usr/sbin/tc` shadows `tc`. Help and usage show the invoked name.
- 021330d: Hints, examples and completion scripts name the command you ran: `tinycloud …` when invoked as `tinycloud`, `tc …` otherwise. `@tinycloud/operations` exports `CLI_NAME` from `@tinycloud/operations/cli-name` for this. Courier's missing-space hint names the TinyCloud CLI it runs inside (`tinycloud space host agents` under `tinycloud courier`), and `tc` when run as the standalone `courier` bin.
- Updated dependencies [c13720c]
- Updated dependencies [021330d]
  - @tinycloud/share-sdk@1.1.1
  - @tinycloud/sdk-core@3.2.3
  - @tinycloud/node-sdk@3.2.3
  - @tinycloud/operations@0.5.3

## 1.2.3-beta.5

### Patch Changes

- 11220b4: `tc share receive` on a revoked bearer link now fails with `SHARE_REVOKED` (exit 4, "This share link has been revoked by its sender.") instead of the generic `INVALID_ARGUMENT: share operation failed`.

## 1.2.3-beta.4

### Patch Changes

- 135b1ee: `tc kv list --cursor` with a cursor the node rejects now fails with `KV_LIST_CURSOR_INVALID` (exit 2) and a hint to start again without `--cursor`, instead of `NETWORK_ERROR` with a misleading "switch to a reachable profile" hint.

## 1.2.3-beta.3

### Patch Changes

- 1a8a8a7: Skills resolve the CLI from the agents.tinycloud.xyz private install (`~/.local/share/tinycloud/cli`, or `TC_BIN`), falling back to a global npm install; tc-cli INSTALL.md points at agents.tinycloud.xyz for setup and skill installs.

## 1.2.3-beta.2

### Patch Changes

- c13720c: `tc share revoke <id>` now revokes public (anyone-with-the-link) shares. Before, the node refused the revocation with 403 and the link stayed readable until it expired. The command reports `revoked` only when the node confirms it; receiving the link then fails.
  - **Error codes for bearer revokes.**
    - `SHARE_ISSUER_KEY_UNAVAILABLE` (exit 5): the profile cannot sign for the link. Nothing is revoked.
    - `SHARE_LINK_UNAVAILABLE` (exit 4): the stored link is missing, or it doesn't match the record. Nothing is revoked.
    - `SHARE_REVOKE_REJECTED` (exit 4): the node refused. The message includes the node's reason, and nothing is revoked.
    - `SHARE_REVOKE_UNCONFIRMED` (exit 1): the node answered without confirming. The link may already be revoked, history is not marked revoked, and you should check the link before retrying.
  - **History.** Revoking an already revoked share keeps its original `revokedAt`.
  - **Share SDK.** `ShareRevocationAdapter.revokeDelegation` now receives the share `record` next to `delegationCid` and `scope`, and `revokeShare` passes it. Adapters that ignore it still type-check, but code that calls `adapter.revokeDelegation(...)` directly must now pass `record`. `revokeShare` keeps an existing `revokedAt`.
  - **sdk-core.** These are additions only:
    - `parseSignedCompactUcanAttenuation` also returns the verified issuer as `payload.iss`.
    - The new `parseSignedSiweCacao(authorization, expectedCid?)` verifies a wallet SIWE CACAO: size (64 KiB) and nesting (64) limits, the exact-bytes CID, canonical DAG-CBOR, the CACAO shape (integer version 1, no unknown or empty fields, safe-integer chain ID), the ReCap shape and statement, and the EIP-191 signature. It returns the issuer, audience, `expiresAt` and the ReCap attenuation. It does not enforce validity times; callers decide.
  - **node-sdk.** The new `TinyCloudNode.signOwnerRevocation(cid)` signs a wallet (CACAO) revocation that the node's `POST /revoke` accepts from the space owner.

- Updated dependencies [c13720c]
  - @tinycloud/share-sdk@1.1.1-beta.0
  - @tinycloud/sdk-core@3.2.3-beta.0
  - @tinycloud/node-sdk@3.2.3-beta.0
  - @tinycloud/operations@0.5.3-beta.1

## 1.2.3-beta.1

### Patch Changes

- 021330d: Hints, examples and completion scripts name the command you ran: `tinycloud …` when invoked as `tinycloud`, `tc …` otherwise. `@tinycloud/operations` exports `CLI_NAME` from `@tinycloud/operations/cli-name` for this. Courier's missing-space hint names the TinyCloud CLI it runs inside (`tinycloud space host agents` under `tinycloud courier`), and `tc` when run as the standalone `courier` bin.
- Updated dependencies [021330d]
  - @tinycloud/operations@0.5.3-beta.0

## 1.2.3-beta.0

### Patch Changes

- 40fab17: Ctrl-C now cancels `tc auth login --method openkey` in a terminal, in both browser and `--paste` mode (TC-1062). Before, the login's interactive code prompt swallowed it and the login kept waiting until its 5-minute timeout. It now stops with `CANCELLED` (exit 130) and saves nothing.
- 9e8e4d1: `tc kv list` can now page through a prefix and say whether a listing is complete (TC-982). The new options:
  - `--limit N` (1–1000) sets the page size;
  - `--cursor C` continues from a previous page;
  - `--all` follows cursors until the listing is complete, and stops with `KV_LIST_CURSOR_STALLED` if the node repeats a cursor.

  `--json` output now includes `truncated` and `nextCursor`; both are `null` when the node doesn't report them. Human output says when more keys follow. The `Size` and `Updated` columns were always empty for a list and still are.

- 024a95f: Install the CLI as `tinycloud` as well as `tc`, so it works on Linux hosts where iproute2's `/usr/sbin/tc` shadows `tc`. Help and usage show the invoked name.

## 1.2.2

### Patch Changes

- c20d7e2: `tc doctor` reports the session state again instead of "error reading session" for every profile with a session. An owner session with no signed OpenKey proof now shows "not usable (no signed OpenKey proof)" with the sign-in command.
- afe7e56: `tc` commands now exit once they finish, even when the caller keeps stdin open (TC-1025). Most visibly, `tc auth login --paste` used to stay running after printing `authenticated: true` until a wrapper that wrote the code and kept its pipe open finally closed it. The CLI now releases stdin after the command settles. `tc courier` has its own entry point and is unchanged.
- 00ad275: `tc doctor` no longer reports a healthy node as down (TC-1048). It probed `/health`, which TinyCloud nodes answer with 404, and now probes `/healthz`, as `tc node health` does. Its Session check now fails for an expired session and prints the command to sign in again, instead of reporting it as active.
- 0e8ee33: **If a command now fails with `AUTH_REQUIRED` and `auth status` shows `session.state: "unverified"`, sign in again: `tc --profile <profile> auth login --method openkey`.** This happens to an OpenKey owner profile whose saved session has no signed OpenKey proof, either from the old unverified paste login or from an older `tc auth import` on an owner profile; for an import, re-import into a delegate-session profile instead. Sessions from any real OpenKey sign-in are unaffected.

  `tc auth login --method openkey`, including `--paste`, now requires a SIWE proof signed for this profile's session key, and saves nothing without one (TC-1053). Before, a plain login (with no `--manifest`, `--owner` or `--expiry`) stored a pasted delegation that had no signature, reported `authenticated: true` and took the profile's `spaceId` from unverified input. Such a paste now fails with `OPENKEY_PROOF_INVALID` (exit 3). Real OpenKey logins always carry this proof and are unaffected.

  The approved session's space must also belong to the account that signed it (`OPENKEY_SCOPE_MISMATCH`), and the saved session always signs with the profile's own key, never a key echoed by the callback.

  A session without a signed proof on an OpenKey owner profile is now reported as `unverified` by `auth status`, `whoami`, `context` and `status`. Commands refuse it, printing the sign-in command, instead of sending it to the node. That covers both the CLI's own restore and the operations runtime behind `tc secrets` and the MCP server (`ownerSessionLacksProof` in `@tinycloud/operations/profile`). It applies to anything the old unverified login saved, and to legacy delegation imports on profiles with no recorded posture. Sign in again, or re-import into a delegate-session profile.

  This doesn't yet tie the proof to this particular login attempt: on a profile with no pinned owner, any wallet's valid proof for the session key is still accepted (TC-1058).

- 8eed117: The browser login's local callback is narrower (TC-1058). It now:
  - listens on an unguessable `/callback/<random>` path;
  - answers only requests whose `Origin` is OpenKey's (others, including requests with no `Origin`, get 403);
  - refuses bodies over 1 MiB (413);
  - ignores a structurally invalid or foreign request without ending the login;
  - closes any held-open connection once the login settles, so a stray socket can't keep `tc` running.

  This doesn't authenticate the sender: a local process that learns the path, which appears in the printed URL and the browser's command line, can forge the header and send a well-formed payload. At worst that ends the login with a proof error, because the CLI verifies OpenKey's signed proof before saving anything. Binding each approval to one login attempt needs an OpenKey nonce.

  When a login (browser, paste or device) first pins a profile's owner and you didn't pass `--owner`, the CLI now prints that owner on stderr. Plain `auth login --method openkey` also reports `ownerDid` in its JSON.

- c8f0137: An `unverified` OpenKey owner session (one with no signed OpenKey proof, see TC-1053) no longer blocks recovery (TC-1059). A scoped or device login replaces it without `--replace-session`, instead of failing with `SESSION_IN_USE`. `tc secrets` treats it like a missing session and offers the sign-in, rather than failing with a permission error.
- 4c0ff89: `tc auth status` and `tc auth whoami` no longer report an expired session as signed in (TC-973). `authenticated` is now true only when the stored session has not expired, or has no recorded expiry. A signed SIWE `Expiration Time` takes precedence over unsigned expiry metadata, as it does when commands restore the session. Both commands also report `session: { state, expiresAt }` in their JSON, using the same evaluation as `tc context` (`missing`, `expired`, `present` or `unknown-expiry`); `tc context` now applies the same SIWE precedence to its `expiresAt`. Human output gains a `Session` line, and `auth status` prints the sign-in command when the session has expired. The exit status is still 0.
- Updated dependencies [0e8ee33]
  - @tinycloud/operations@0.5.2
  - @tinycloud/node-sdk@3.2.2
  - @tinycloud/sdk-core@3.2.2

## 1.2.2-beta.5

### Patch Changes

- c20d7e2: `tc doctor` reports the session state again instead of "error reading session" for every profile with a session. An owner session with no signed OpenKey proof now shows "not usable (no signed OpenKey proof)" with the sign-in command.

## 1.2.2-beta.4

### Patch Changes

- c8f0137: An `unverified` OpenKey owner session (one with no signed OpenKey proof, see TC-1053) no longer blocks recovery (TC-1059). A scoped or device login replaces it without `--replace-session`, instead of failing with `SESSION_IN_USE`. `tc secrets` treats it like a missing session and offers the sign-in, rather than failing with a permission error.

## 1.2.2-beta.3

### Patch Changes

- 00ad275: `tc doctor` no longer reports a healthy node as down (TC-1048). It probed `/health`, which TinyCloud nodes answer with 404, and now probes `/healthz`, as `tc node health` does. Its Session check now fails for an expired session and prints the command to sign in again, instead of reporting it as active.
- 8eed117: The browser login's local callback is narrower (TC-1058). It now:
  - listens on an unguessable `/callback/<random>` path;
  - answers only requests whose `Origin` is OpenKey's (others, including requests with no `Origin`, get 403);
  - refuses bodies over 1 MiB (413);
  - ignores a structurally invalid or foreign request without ending the login;
  - closes any held-open connection once the login settles, so a stray socket can't keep `tc` running.

  This doesn't authenticate the sender: a local process that learns the path, which appears in the printed URL and the browser's command line, can forge the header and send a well-formed payload. At worst that ends the login with a proof error, because the CLI verifies OpenKey's signed proof before saving anything. Binding each approval to one login attempt needs an OpenKey nonce.

  When a login (browser, paste or device) first pins a profile's owner and you didn't pass `--owner`, the CLI now prints that owner on stderr. Plain `auth login --method openkey` also reports `ownerDid` in its JSON.

## 1.2.2-beta.2

### Patch Changes

- 0e8ee33: `tc auth login --method openkey`, including `--paste`, now requires a SIWE proof signed for this profile's session key, and saves nothing without one (TC-1053). Before, a plain login (with no `--manifest`, `--owner` or `--expiry`) stored a pasted delegation that had no signature, reported `authenticated: true` and took the profile's `spaceId` from unverified input. Such a paste now fails with `OPENKEY_PROOF_INVALID` (exit 3). Real OpenKey logins always carry this proof and are unaffected.

  The approved session's space must also belong to the account that signed it (`OPENKEY_SCOPE_MISMATCH`), and the saved session always signs with the profile's own key, never a key echoed by the callback.

  A session without a signed proof on an OpenKey owner profile is now reported as `unverified` by `auth status`, `whoami`, `context` and `status`. Commands refuse it, printing the sign-in command, instead of sending it to the node. That covers both the CLI's own restore and the operations runtime behind `tc secrets` and the MCP server (`ownerSessionLacksProof` in `@tinycloud/operations/profile`). It applies to anything the old unverified login saved, and to legacy delegation imports on profiles with no recorded posture. Sign in again, or re-import into a delegate-session profile.

  This doesn't yet tie the proof to this particular login attempt: on a profile with no pinned owner, any wallet's valid proof for the session key is still accepted (TC-1058).

- Updated dependencies [0e8ee33]
  - @tinycloud/operations@0.5.2-beta.1

## 1.2.2-beta.1

### Patch Changes

- afe7e56: `tc` commands now exit once they finish, even when the caller keeps stdin open (TC-1025). Most visibly, `tc auth login --paste` used to stay running after printing `authenticated: true` until a wrapper that wrote the code and kept its pipe open finally closed it. The CLI now releases stdin after the command settles. `tc courier` has its own entry point and is unchanged.
- 4c0ff89: `tc auth status` and `tc auth whoami` no longer report an expired session as signed in (TC-973). `authenticated` is now true only when the stored session has not expired, or has no recorded expiry. A signed SIWE `Expiration Time` takes precedence over unsigned expiry metadata, as it does when commands restore the session. Both commands also report `session: { state, expiresAt }` in their JSON, using the same evaluation as `tc context` (`missing`, `expired`, `present` or `unknown-expiry`); `tc context` now applies the same SIWE precedence to its `expiresAt`. Human output gains a `Session` line, and `auth status` prints the sign-in command when the session has expired. The exit status is still 0.

## 1.2.2-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.2.2-beta.0
- @tinycloud/operations@0.5.2-beta.0

## 1.2.1

### Patch Changes

- Updated dependencies [10359c5]
- Updated dependencies [eda1f78]
  - @tinycloud/node-sdk@3.2.1
  - @tinycloud/operations@0.5.1
  - @tinycloud/sdk-core@3.2.1

## 1.2.1-beta.1

### Patch Changes

- Updated dependencies [10359c5]
  - @tinycloud/node-sdk@3.2.1-beta.1
  - @tinycloud/operations@0.5.1-beta.1

## 1.2.1-beta.0

### Patch Changes

- Updated dependencies [eda1f78]
  - @tinycloud/node-sdk@3.2.1-beta.0
  - @tinycloud/operations@0.5.1-beta.0

## 1.2.0

### Minor Changes

- ad4a11f: Add `tc auth grants list` for local verification and inspection of stored grants without a network request, and `tc auth grants remove <cid> [--revoke]` for deleting matching local records. Local removal is available to delegates; only `--revoke` is owner-only and removes local rows after successful node revocation.

  Cross-user imports appear as `for_another_key` only when their CID and signed audience verify and match the stored transport audience; tampered rows retain their refusal reason. `--revoke` uses the usual verified local-node discovery. A concurrent local removal after node revocation succeeds with `removed: 0`; other local removal failures return `GRANT_REVOKED_LOCAL_REMOVE_FAILED` with a structured cause code and a hint to retry local-only.

- 4f851e6: New `tc secrets request <NAME...> [--scope S | --app ID] [--owner DID] [--requester LABEL] [--open]`: prints the owner's Secret Manager `/request` link as `{url, names, scope?, owner}` and exits 0, offline. A local identity (local-owner profile, a profile holding a `privateKey`, `--private-key` or `TC_PRIVATE_KEY`) gets `LOCAL_OWNER_PROFILE` (exit 2); an unknown owner is `OWNER_DID_UNKNOWN` (exit 3).

  New `tc secrets wait <NAME...> [--scope S | --app ID] [--owner DID] [--timeout D]`: polls until the secrets exist, each check in a child process killed if it overruns, bounded at timeout + 21 s (`--timeout 0` checks once). It never signs in: it needs a stored session, and `TC_PRIVATE_KEY` is not supported (exit 3). It writes no profile state and saves no consent. Exit 8 (`PENDING`) when the deadline passes with names still missing, 130 (`CANCELLED`) when interrupted, 1 for `PROFILE_MIGRATION_REQUIRED` (run `tc --profile P auth caps` once after an upgrade) or `PROBE_FAILED`.

  New `--app ID` on `request`, `wait` and `manage` derives the scope with `appSecretScope`. `tc secrets manage [NAME...] [--scope S | --app ID] [--no-open]` opens the Secret Manager at the named secrets.

  Error JSON gains three validated, value-free fields: `error.setup` (`{url, names, scope?, owner, action: "add_secret"}`, on `NOT_FOUND` and on `wait`'s `PERMISSION_DENIED`), `error.recovery` (`sign_in`, `complete_migration` or `request_access`, exact shapes only) and `error.progress` (`{present, pending}`, on `wait`'s `NETWORK_ERROR`/`CANCELLED`).

  Fixes: `tc secrets get --delegation` now reports a missing secret with the owner's request link (never for a local identity), and a refused delegated read (403, a capability 401, `AUTH_UNAUTHORIZED`) exits 5 instead of 1. Manifest secrets resolve the owner with the shared rule (a delegate session's space owner counts; a `--owner` that disagrees with the profile's owner is `OWNER_MISMATCH`, exit 2).

  **Breaks:** `tc secrets manage` JSON is now `{url, opened}` (was `{opened: url}`), and it takes optional names. Refused `tc secrets put` / `tc vault put` writes exit 3 or 5 instead of 1. `tc secrets doctor` hints for a missing secret now name `tc secrets request NAME`, or `tc secrets put NAME --stdin` for a local identity. A missing secret on `tc secrets get` now carries `error.setup` with a `/request?owner=…` link instead of an `/app` hint, and a local identity gets no link.

- df18325: Add the opt-in replication flags, saved login prefixes, diagnostics log and report, bounded replication shutdown that forces a successful exit after a stalled drain, and lease-safe logout cleanup under one profile lock for legacy and flag-owned replicas. Registrations arriving during shutdown are drained before completion. The new login authority is limited to prefixes already covered by an unrestricted `get`; scoped logins are never broadened. Scoped app manifests preserve ReCap caveats, so caveated-only gets cannot authorize replication. Fresh local login still bootstraps missing profiles, key rotation preserves saved scoped permissions, and replication-enabled unscoped logins retain their full KV/SQL defaults. A missing replication grant emits one warning per prefix per invocation while reads remain network-backed.

  The CLI now supplies profile-partitioned SQLite storage to the node runtime and registers the node's live replication control surface for reports. Secret/vault existence reads that determine CLI behavior bypass local replicas and remain network-authoritative. Replication profile writes are serialized by the profile guard; with `TC_REPLICATION` unset, no replica store is opened.

  `TC_REPLICATION_VERIFY=1` now forwards the verification policy to the node runtime; with the flag unset, CLI replication remains disabled and creates no replication directory.

- d84cfed: New package `@tinycloud/courier` (first beta): Courier, agent-to-agent threads over TinyCloud, moved into this repo from TinyCloudLabs/courier. It ships the standalone `courier` bin, the library entry `main(argv, { prog })`, and the `courier` agent skill. The package has no `license` field yet (TC-861).

  `@tinycloud/cli` bundles Courier as `tc courier …`. It takes the same arguments as `courier`, keeps its own profile in `$COURIER_HOME` (default `~/.courier`) rather than a tc profile, and is loaded only when invoked. tc options before `courier` (for example `tc -p x courier …`) exit 2. The CLI tarball now ships the `courier` skill next to `tc-cli`; install both with `--skill tc-cli courier`.

  `courier init --paste` and `courier init --grant-file -` accept OpenKey `XXXX-XXXX` short codes (TC-823). The code is redeemed at `--openkey-api-host`, `COURIER_OPENKEY_API_HOST`, or by default `https://api.openkey.so` (for `https://openkey.so`, otherwise the OpenKey host). The redeemed delegation must be bound to the local Courier agent key.

### Patch Changes

- 9836159: `tc` recovers a profile lock left by a crashed process with its own PID in another PID namespace (a container restarted with a persistent `TC_HOME`) once that process's liveness socket in the shared turn directory is gone or refused by the kernel, and still waits for a live or paused one, for one whose socket it cannot verify (a turn directory it does not share, or a sandbox that blocks its own connections), and for older releases. The tc-cli reference documents each condition, what still waits, and the manual remedy for `$TC_HOME/.tinycloud` and per-tenant MCP state, and restores the caveat that the lock does not protect processes with different PIDs in different PID namespaces.
- ad4a11f: Unify stored-grant replay across CLI, operations, and MCP. Refused replay candidates use fixed-code warnings; only a cross-user compact import with a verified signed audience, matching stored transport audience, and correct CID remains separate and silent.

  Breaking behavior for `@tinycloud/cli`:
  - Grants without a `siweProof` (including CLI <=1.1.0-beta.13 and 1.0.x escalations and non-compact imports without proof) are refused with `proof_missing`. Owners can approve again using `tc auth request --grant [--device]`; delegates can request, receive, and import a new signed grant or reimport the original artifact with its proof. Remove stale rows using `tc auth grants remove <old-cid>`; an owner may add `--revoke`.
  - Unbound compact grants no longer install before migration binds them (including a busy migration lock, `--private-key` on a local profile, or a session without `verificationMethod`); they report `unbound`. Run an ordinary command, sign in again, or reimport the artifact to recover.
  - Compact grants with invalid signatures or CIDs are refused locally with `proof_invalid` or `cid_mismatch`; damaged transport audiences are refused rather than silently classified as cross-user. A single `Bearer` prefix is stripped before activation so verified grants authorize reads; a double prefix is refused.
  - `tc auth import` refuses every proofless non-compact delegation (`INVALID_AUTH_IMPORT`, exit 2), including cross-user artifacts; none is stored or recorded in grant history. A compact or signed-login delegation failing verification returns `DELEGATION_REJECTED` (exit 1). A tampered transport audience cannot turn a session grant into a silent cross-user import. Valid session-targeted imports bind to `unbound-import:<cid>`.
  - Commands that replay may now emit a `{warnings}` stderr line or include `error.warnings`; `TC_DEBUG_REPLAY` is removed. `--private-key` on an OpenKey profile no longer replays stored grants.
  - Owner OpenKey `tc delegation revoke` no longer requests raw `urn:cid` authority (unsupported by deployed OpenKey). It uses a CID-bound owner-space fallback, or fails immediately with `RAW_RECAP_RESOURCE_UNSUPPORTED` instead of timing out.

  `@tinycloud/sdk-core` now exposes the verified signed `payload.aud` from `parseSignedCompactUcanAttenuation` and rejects compact tokens without an audience. The audience is read during the existing signature verification, so replay does not decode an unsigned payload separately.

  Breaking behavior for `@tinycloud/operations`:
  - `replayLimit(entry)` no longer takes `migrated` or returns `"signed"`; `replayStoredDelegation` options no longer take `migrated`; `activateUnboundCompactImport` becomes `activateUnboundImport` and accepts signed-login records. New APIs: `replayProfileDelegations`, `inspectStoredDelegation`, `storedDelegationForAnotherKey`, `verifiedCompactAudience`, `storedDelegationSource`, and `withoutBearer`.
  - Unbound compact grants are refused before migration; `createInvocationRuntime` replays only for a restored persisted session. `liveAdditionalDelegationCount` in `tinycloud.status.get` and `tinycloud.auth.status` counts only bound, unexpired grants. Invalid compact proofs report `proof_invalid`. `generated/operations.json` changes accordingly.

  `@tinycloud/mcp` receives the shared replay and status behavior through its `@tinycloud/operations` dependency; no MCP-generated schema changes in this release.

- 6a7fa64: A SIWE-less session created by `tc auth import` now expires locally at the compact UCAN's signed `exp`; expired restores throw `AUTH_EXPIRED` before host lookup, including sessions imported by earlier releases. The new `signedCompactUcanExpiry` export reads that signed lifetime. CACAO-headed sessions remain refused only by the node.

  A request-bound compact import whose signed expiry passes during its locked store write now reports `DELEGATION_EXPIRED` and rolls back the grant and any provisional session. If a fresh delegate profile's provisional session expires during import, it is rolled back unless another writer has since changed the profile. Cross-user compact imports require transport expiry to match signed `exp`, and persist the signed expiry. An import that is already expired or expires before activation also reports `DELEGATION_EXPIRED` without storing a grant.

  The client clock is authoritative. `context` reports imported-session expiry, and the scoped paste login named by the hint is no longer blocked by an unknown expiry. Before probing a configured local node, session-using commands verify the stored session locally; this also covers older imported sessions. Login, logout, rotate, status, whoami, context, node, profile, `space host-request|switch`, `enable`, `auth request` without `--grant`, explicit private-key commands, and profiles without a stored session retain discovery behavior. Deferred discovery after owner refresh respects a context copied with another host.

- 4756923: Location registry and target `/info` failures, single-source location resolution failures, manifest fetches, node version checks, and CLI delegation-code fetches now carry typed HTTP status. A 401 or 403 from these producers is an authorization verdict: the CLI exits with `AUTH_REQUIRED` or `PERMISSION_DENIED` instead of `ERROR`, `withSessionRefresh` signs in again on 401, and account-registry sync stops rather than retrying a single-source location 401 or 403. Location resolutions with multiple independent failures remain unclassified.

  Hook timeouts are classified from HTTP status rather than response text: 408 and 504 report `TIMEOUT`, while hook HTTP error messages containing `timeout` retain the server's diagnostic text. Account-registry retry uses the message fallback only for genuinely untyped errors. The untyped session-error fallback ignores standalone single-quoted names, not apostrophes inside words, and strips quoted names in linear time (also fixing master's slow case with many escaped double quotes).

  An account-index initialization failure, whether a failed result or a thrown error, no longer blocks or retries account-registry sync; it is warned at most once per sync with only its HTTP status and error code, and the canonical registry writes and space sync continue.

- df18325: Exact-key grants cannot cover folders under sdk-core capability containment. Local LIST keeps the exact-only network fallback and nested-LIST pending-write protection.
- 47eb547: Replication prefixes are folders such as `notes/`, or `/` for the whole space (requires a node advertising `kv-sync-root`). Bare paths and `""` are rejected.

  For local-key and eligible owner OpenKey sign-ins with unrestricted whole-space KV get coverage, replication adds sync once to the existing whole-space KV entry. Narrower owner coverage and delegated/device grants retain per-prefix scope.

  Published `@tinycloud/replica` declarations, including `./browser` and `./worker`, are self-contained; consumers do not need `@tinycloud/sdk-services`.

  `kvSyncTransport(kv)` discovers the node host exposed by the KV service for whole-space feature checks. If the service does not expose a host, pass `{ host }`; root sync refuses early with a clear error rather than skipping the `kv-sync-root` check.

- 05c4efa: Courier waits up to 2.5 minutes during init when OpenKey reports `spacePending: true` with `spaceReady: null`. It saves the grant and pending profile before waiting so interrupted or timed-out setup can resume without a new approval. Pending `init --resume` waits up to one minute and clears the marker when the space is ready. Responses without literal `spacePending: true` keep the existing single-probe behavior and manual hosting guidance. Authentication and network errors still propagate.

  The CLI bundles the updated Courier behavior and skill as `tc courier`. Both packages release on the existing beta channel. Release Courier before, or in the same window as, the TC-945 OpenKey API deployment.

- d825e49: A fresh owner's first private-key sign-in (`tc auth login --method local`, or `TinyCloudNode.signIn()` with a private key) no longer warns `account bootstrap failed: … 401 - Unauthorized Action: …:account/sql/account / tinycloud.sql/schema`, and it creates the account index, registry and bootstrap marker on the account space. Previously these were only repaired on the next sign-in. The default bootstrap session now signs each requested permission onto its own space, as sign-in already does, and an operation on another space that a bootstrap session covers is invoked against that space (TC-957).
- Updated dependencies [33efc8c]
- Updated dependencies [33efc8c]
- Updated dependencies [26f86bd]
- Updated dependencies [9836159]
- Updated dependencies [ad4a11f]
- Updated dependencies [6a7fa64]
- Updated dependencies [4756923]
- Updated dependencies [4f851e6]
- Updated dependencies [4f851e6]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [47eb547]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [d825e49]
  - @tinycloud/node-sdk@3.2.0
  - @tinycloud/operations@0.5.0
  - @tinycloud/sdk-core@3.2.0

## 1.2.0-beta.12

### Patch Changes

- d825e49: A fresh owner's first private-key sign-in (`tc auth login --method local`, or `TinyCloudNode.signIn()` with a private key) no longer warns `account bootstrap failed: … 401 - Unauthorized Action: …:account/sql/account / tinycloud.sql/schema`, and it creates the account index, registry and bootstrap marker on the account space. Previously these were only repaired on the next sign-in. The default bootstrap session now signs each requested permission onto its own space, as sign-in already does, and an operation on another space that a bootstrap session covers is invoked against that space (TC-957).
- Updated dependencies [d825e49]
  - @tinycloud/node-sdk@3.2.0-beta.9
  - @tinycloud/operations@0.5.0-beta.10

## 1.2.0-beta.11

### Patch Changes

- 05c4efa: Courier waits up to 2.5 minutes during init when OpenKey reports `spacePending: true` with `spaceReady: null`. It saves the grant and pending profile before waiting so interrupted or timed-out setup can resume without a new approval. Pending `init --resume` waits up to one minute and clears the marker when the space is ready. Responses without literal `spacePending: true` keep the existing single-probe behavior and manual hosting guidance. Authentication and network errors still propagate.

  The CLI bundles the updated Courier behavior and skill as `tc courier`. Both packages release on the existing beta channel. Release Courier before, or in the same window as, the TC-945 OpenKey API deployment.

## 1.2.0-beta.10

### Patch Changes

- 4756923: Location registry and target `/info` failures, single-source location resolution failures, manifest fetches, node version checks, and CLI delegation-code fetches now carry typed HTTP status. A 401 or 403 from these producers is an authorization verdict: the CLI exits with `AUTH_REQUIRED` or `PERMISSION_DENIED` instead of `ERROR`, `withSessionRefresh` signs in again on 401, and account-registry sync stops rather than retrying a single-source location 401 or 403. Location resolutions with multiple independent failures remain unclassified.

  Hook timeouts are classified from HTTP status rather than response text: 408 and 504 report `TIMEOUT`, while hook HTTP error messages containing `timeout` retain the server's diagnostic text. Account-registry retry uses the message fallback only for genuinely untyped errors. The untyped session-error fallback ignores standalone single-quoted names, not apostrophes inside words, and strips quoted names in linear time (also fixing master's slow case with many escaped double quotes).

  An account-index initialization failure, whether a failed result or a thrown error, no longer blocks or retries account-registry sync; it is warned at most once per sync with only its HTTP status and error code, and the canonical registry writes and space sync continue.

- Updated dependencies [4756923]
  - @tinycloud/sdk-core@3.2.0-beta.8
  - @tinycloud/node-sdk@3.2.0-beta.8
  - @tinycloud/operations@0.5.0-beta.9

## 1.2.0-beta.9

### Patch Changes

- Updated dependencies [26f86bd]
  - @tinycloud/sdk-core@3.2.0-beta.7
  - @tinycloud/node-sdk@3.2.0-beta.7
  - @tinycloud/operations@0.5.0-beta.8

## 1.2.0-beta.8

### Patch Changes

- Updated dependencies [33efc8c]
- Updated dependencies [33efc8c]
  - @tinycloud/node-sdk@3.2.0-beta.6
  - @tinycloud/operations@0.5.0-beta.7

## 1.2.0-beta.7

### Patch Changes

- 9836159: `tc` recovers a profile lock left by a crashed process with its own PID in another PID namespace (a container restarted with a persistent `TC_HOME`) once that process's liveness socket in the shared turn directory is gone or refused by the kernel, and still waits for a live or paused one, for one whose socket it cannot verify (a turn directory it does not share, or a sandbox that blocks its own connections), and for older releases. The tc-cli reference documents each condition, what still waits, and the manual remedy for `$TC_HOME/.tinycloud` and per-tenant MCP state, and restores the caveat that the lock does not protect processes with different PIDs in different PID namespaces.
- Updated dependencies [9836159]
  - @tinycloud/operations@0.5.0-beta.6

## 1.2.0-beta.6

### Patch Changes

- 47eb547: Replication prefixes are folders such as `notes/`, or `/` for the whole space (requires a node advertising `kv-sync-root`). Bare paths and `""` are rejected.

  For local-key and eligible owner OpenKey sign-ins with unrestricted whole-space KV get coverage, replication adds sync once to the existing whole-space KV entry. Narrower owner coverage and delegated/device grants retain per-prefix scope.

  Published `@tinycloud/replica` declarations, including `./browser` and `./worker`, are self-contained; consumers do not need `@tinycloud/sdk-services`.

  `kvSyncTransport(kv)` discovers the node host exposed by the KV service for whole-space feature checks. If the service does not expose a host, pass `{ host }`; root sync refuses early with a clear error rather than skipping the `kv-sync-root` check.

- Updated dependencies [47eb547]
  - @tinycloud/node-sdk@3.2.0-beta.5
  - @tinycloud/operations@0.5.0-beta.5
  - @tinycloud/sdk-core@3.2.0-beta.5

## 1.2.0-beta.5

### Minor Changes

- d84cfed: New package `@tinycloud/courier` (first beta): Courier, agent-to-agent threads over TinyCloud, moved into this repo from TinyCloudLabs/courier. It ships the standalone `courier` bin, the library entry `main(argv, { prog })`, and the `courier` agent skill. The package has no `license` field yet (TC-861).

  `@tinycloud/cli` bundles Courier as `tc courier …`. It takes the same arguments as `courier`, keeps its own profile in `$COURIER_HOME` (default `~/.courier`) rather than a tc profile, and is loaded only when invoked. tc options before `courier` (for example `tc -p x courier …`) exit 2. The CLI tarball now ships the `courier` skill next to `tc-cli`; install both with `--skill tc-cli courier`.

  `courier init --paste` and `courier init --grant-file -` accept OpenKey `XXXX-XXXX` short codes (TC-823). The code is redeemed at `--openkey-api-host`, `COURIER_OPENKEY_API_HOST`, or by default `https://api.openkey.so` (for `https://openkey.so`, otherwise the OpenKey host). The redeemed delegation must be bound to the local Courier agent key.

## 1.2.0-beta.4

### Patch Changes

- @tinycloud/node-sdk@3.2.0-beta.4
- @tinycloud/operations@0.5.0-beta.4

## 1.2.0-beta.3

### Minor Changes

- df18325: Add the opt-in replication flags, saved login prefixes, diagnostics log and report, bounded replication shutdown that forces a successful exit after a stalled drain, and lease-safe logout cleanup under one profile lock for legacy and flag-owned replicas. Registrations arriving during shutdown are drained before completion. The new login authority is limited to prefixes already covered by an unrestricted `get`; scoped logins are never broadened. Scoped app manifests preserve ReCap caveats, so caveated-only gets cannot authorize replication. Fresh local login still bootstraps missing profiles, key rotation preserves saved scoped permissions, and replication-enabled unscoped logins retain their full KV/SQL defaults. A missing replication grant emits one warning per prefix per invocation while reads remain network-backed.

  The CLI now supplies profile-partitioned SQLite storage to the node runtime and registers the node's live replication control surface for reports. Secret/vault existence reads that determine CLI behavior bypass local replicas and remain network-authoritative. Replication profile writes are serialized by the profile guard; with `TC_REPLICATION` unset, no replica store is opened.

  `TC_REPLICATION_VERIFY=1` now forwards the verification policy to the node runtime; with the flag unset, CLI replication remains disabled and creates no replication directory.

### Patch Changes

- df18325: Keep published segment-aware replica selection unchanged while using sdk-core capability containment only for authority. Bare selectors now request get/sync grants for the exact path and slash descendants through the shared public `grantPathsForSelector` helper; root and trailing-slash selectors remain single-path grants. LIST local serving requires complete selection coverage, and nested LIST pending writes force network fallback or cursor restart.
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
- Updated dependencies [df18325]
  - @tinycloud/sdk-core@3.2.0-beta.3
  - @tinycloud/node-sdk@3.2.0-beta.3
  - @tinycloud/operations@0.5.0-beta.3

## 1.2.0-beta.2

### Minor Changes

- 4f851e6: New `tc secrets request <NAME...> [--scope S | --app ID] [--owner DID] [--requester LABEL] [--open]`: prints the owner's Secret Manager `/request` link as `{url, names, scope?, owner}` and exits 0, offline. A local identity (local-owner profile, a profile holding a `privateKey`, `--private-key` or `TC_PRIVATE_KEY`) gets `LOCAL_OWNER_PROFILE` (exit 2); an unknown owner is `OWNER_DID_UNKNOWN` (exit 3).

  New `tc secrets wait <NAME...> [--scope S | --app ID] [--owner DID] [--timeout D]`: polls until the secrets exist, each check in a child process killed if it overruns, bounded at timeout + 21 s (`--timeout 0` checks once). It never signs in: it needs a stored session, and `TC_PRIVATE_KEY` is not supported (exit 3). It writes no profile state and saves no consent. Exit 8 (`PENDING`) when the deadline passes with names still missing, 130 (`CANCELLED`) when interrupted, 1 for `PROFILE_MIGRATION_REQUIRED` (run `tc --profile P auth caps` once after an upgrade) or `PROBE_FAILED`.

  New `--app ID` on `request`, `wait` and `manage` derives the scope with `appSecretScope`. `tc secrets manage [NAME...] [--scope S | --app ID] [--no-open]` opens the Secret Manager at the named secrets.

  Error JSON gains three validated, value-free fields: `error.setup` (`{url, names, scope?, owner, action: "add_secret"}`, on `NOT_FOUND` and on `wait`'s `PERMISSION_DENIED`), `error.recovery` (`sign_in`, `complete_migration` or `request_access`, exact shapes only) and `error.progress` (`{present, pending}`, on `wait`'s `NETWORK_ERROR`/`CANCELLED`).

  Fixes: `tc secrets get --delegation` now reports a missing secret with the owner's request link (never for a local identity), and a refused delegated read (403, a capability 401, `AUTH_UNAUTHORIZED`) exits 5 instead of 1. Manifest secrets resolve the owner with the shared rule (a delegate session's space owner counts; a `--owner` that disagrees with the profile's owner is `OWNER_MISMATCH`, exit 2).

  **Breaks:** `tc secrets manage` JSON is now `{url, opened}` (was `{opened: url}`), and it takes optional names. Refused `tc secrets put` / `tc vault put` writes exit 3 or 5 instead of 1. `tc secrets doctor` hints for a missing secret now name `tc secrets request NAME`, or `tc secrets put NAME --stdin` for a local identity. A missing secret on `tc secrets get` now carries `error.setup` with a `/request?owner=…` link instead of an `/app` hint, and a local identity gets no link.

### Patch Changes

- Updated dependencies [4f851e6]
- Updated dependencies [4f851e6]
  - @tinycloud/operations@0.5.0-beta.2
  - @tinycloud/sdk-core@3.2.0-beta.2
  - @tinycloud/node-sdk@3.2.0-beta.2

## 1.2.0-beta.1

### Patch Changes

- 6a7fa64: A SIWE-less session created by `tc auth import` now expires locally at the compact UCAN's signed `exp`; expired restores throw `AUTH_EXPIRED` before host lookup, including sessions imported by earlier releases. The new `signedCompactUcanExpiry` export reads that signed lifetime. CACAO-headed sessions remain refused only by the node.

  A request-bound compact import whose signed expiry passes during its locked store write now reports `DELEGATION_EXPIRED` and rolls back the grant and any provisional session. If a fresh delegate profile's provisional session expires during import, it is rolled back unless another writer has since changed the profile. Cross-user compact imports require transport expiry to match signed `exp`, and persist the signed expiry. An import that is already expired or expires before activation also reports `DELEGATION_EXPIRED` without storing a grant.

  The client clock is authoritative. `context` reports imported-session expiry, and the scoped paste login named by the hint is no longer blocked by an unknown expiry. Before probing a configured local node, session-using commands verify the stored session locally; this also covers older imported sessions. Login, logout, rotate, status, whoami, context, node, profile, `space host-request|switch`, `enable`, `auth request` without `--grant`, explicit private-key commands, and profiles without a stored session retain discovery behavior. Deferred discovery after owner refresh respects a context copied with another host.

- Updated dependencies [6a7fa64]
  - @tinycloud/node-sdk@3.2.0-beta.1
  - @tinycloud/operations@0.5.0-beta.1

## 1.2.0-beta.0

### Minor Changes

- ad4a11f: Add `tc auth grants list` for local verification and inspection of stored grants without a network request, and `tc auth grants remove <cid> [--revoke]` for deleting matching local records. Local removal is available to delegates; only `--revoke` is owner-only and removes local rows after successful node revocation.

  Cross-user imports appear as `for_another_key` only when their CID and signed audience verify and match the stored transport audience; tampered rows retain their refusal reason. `--revoke` uses the usual verified local-node discovery. A concurrent local removal after node revocation succeeds with `removed: 0`; other local removal failures return `GRANT_REVOKED_LOCAL_REMOVE_FAILED` with a structured cause code and a hint to retry local-only.

### Patch Changes

- ad4a11f: Unify stored-grant replay across CLI, operations, and MCP. Refused replay candidates use fixed-code warnings; only a cross-user compact import with a verified signed audience, matching stored transport audience, and correct CID remains separate and silent.

  Breaking behavior for `@tinycloud/cli`:
  - Grants without a `siweProof` (including CLI <=1.1.0-beta.13 and 1.0.x escalations and non-compact imports without proof) are refused with `proof_missing`. Owners can approve again using `tc auth request --grant [--device]`; delegates can request, receive, and import a new signed grant or reimport the original artifact with its proof. Remove stale rows using `tc auth grants remove <old-cid>`; an owner may add `--revoke`.
  - Unbound compact grants no longer install before migration binds them (including a busy migration lock, `--private-key` on a local profile, or a session without `verificationMethod`); they report `unbound`. Run an ordinary command, sign in again, or reimport the artifact to recover.
  - Compact grants with invalid signatures or CIDs are refused locally with `proof_invalid` or `cid_mismatch`; damaged transport audiences are refused rather than silently classified as cross-user. A single `Bearer` prefix is stripped before activation so verified grants authorize reads; a double prefix is refused.
  - `tc auth import` refuses every proofless non-compact delegation (`INVALID_AUTH_IMPORT`, exit 2), including cross-user artifacts; none is stored or recorded in grant history. A compact or signed-login delegation failing verification returns `DELEGATION_REJECTED` (exit 1). A tampered transport audience cannot turn a session grant into a silent cross-user import. Valid session-targeted imports bind to `unbound-import:<cid>`.
  - Commands that replay may now emit a `{warnings}` stderr line or include `error.warnings`; `TC_DEBUG_REPLAY` is removed. `--private-key` on an OpenKey profile no longer replays stored grants.
  - Owner OpenKey `tc delegation revoke` no longer requests raw `urn:cid` authority (unsupported by deployed OpenKey). It uses a CID-bound owner-space fallback, or fails immediately with `RAW_RECAP_RESOURCE_UNSUPPORTED` instead of timing out.

  `@tinycloud/sdk-core` now exposes the verified signed `payload.aud` from `parseSignedCompactUcanAttenuation` and rejects compact tokens without an audience. The audience is read during the existing signature verification, so replay does not decode an unsigned payload separately.

  Breaking behavior for `@tinycloud/operations`:
  - `replayLimit(entry)` no longer takes `migrated` or returns `"signed"`; `replayStoredDelegation` options no longer take `migrated`; `activateUnboundCompactImport` becomes `activateUnboundImport` and accepts signed-login records. New APIs: `replayProfileDelegations`, `inspectStoredDelegation`, `storedDelegationForAnotherKey`, `verifiedCompactAudience`, `storedDelegationSource`, and `withoutBearer`.
  - Unbound compact grants are refused before migration; `createInvocationRuntime` replays only for a restored persisted session. `liveAdditionalDelegationCount` in `tinycloud.status.get` and `tinycloud.auth.status` counts only bound, unexpired grants. Invalid compact proofs report `proof_invalid`. `generated/operations.json` changes accordingly.

  `@tinycloud/mcp` receives the shared replay and status behavior through its `@tinycloud/operations` dependency; no MCP-generated schema changes in this release.

- Updated dependencies [ad4a11f]
  - @tinycloud/operations@0.5.0-beta.0
  - @tinycloud/sdk-core@3.2.0-beta.0
  - @tinycloud/node-sdk@3.2.0-beta.0

## 1.1.0

### Minor Changes

- 37123c3: New package `@tinycloud/replica` (first beta): a durable, read-only local replica of one KV prefix, kept current over the node's `tinycloud.kv/sync` change feed (`kv-sync-v1`, TinyCloud Node with TC-732). It verifies every value against the node-attested blake3 ETag before committing, commits each feed page with its cursor in one transaction, enforces the node-attested authority window offline (optionally extended by a `tinycloud.kv/retain` grant), purges itself when it learns of a revocation, and resets in place on `410 RESET_REQUIRED`. `.` exports the engine, the frozen `ReplicaTransport`/`ReplicaStore` contracts, `kvSyncTransport(kv)` over `KVService.changes()` and the worker-safe `parseUcanGrant`; `./sqlite` is the Node/Bun store (built-in `node:sqlite` on Node 22.13+, `bun:sqlite` under Bun; no native addon).

  `tc replica sync|get|list|status|reset` (CLI): sync a prefix under a device grant carrying `tinycloud.kv/sync` and `tinycloud.kv/get`, then read it with the host offline. `get`, `list`, `status` and `reset` never touch the network. On Node.js older than 22.13 every `tc replica` command exits 1 with `RUNTIME_UNSUPPORTED`; other commands keep working on Node 20.

- dea6d3f: Manual OpenKey login now accepts an eight-character delegation retrieval code in `tc auth login --paste` and the interactive callback fallback. The CLI checks that the fetched public delegation belongs to its local session key. Full JSON and base64 delegation paste remain available when the broker cannot be reached.
- e2ec154: TC-625: Every command and tool reports full TinyCloud storage the same way.
  - CLI: a write refused because storage is full (`STORAGE_QUOTA_EXCEEDED`) or too small for the write (`STORAGE_LIMIT_REACHED`) exits with the new code 10 (`ExitCode.STORAGE_FULL`) from every command, including `kv`, `sql`, `duckdb`, `vars`, `vault`, `secrets`, `account` and `share`. It prints one message, `TinyCloud storage is full; nothing was written.`, with a hint that gives the account totals when the SDK reports them (`371.7 MiB used of 100 MiB (free plan)`), says reading still works, and links to https://account.tinycloud.xyz/billing. It never shows the per-space limit or the switch-hosts network hint. `tc sql copy` that fills storage part-way keeps its progress instead (`Insert into "notes" failed after 2 row(s): TinyCloud storage is full.`). The node's storage text is read only from an uncoded 402 or 413 response; an error with another code, such as a local `ENOENT`, keeps its own mapping. Behaviour change: `tc kv put` exited 1 and `tc share` exited 4 for a full space; both now exit 10. `tc share` keeps 8 for `UNSAFE_FILENAME`/`OUTPUT_EXISTS` and 9 for notify partial failure. `tc share` reports a write larger than the remaining storage as `STORAGE_LIMIT_REACHED` instead of `UPLOAD_FAILED`.
  - Operations and MCP: a new `STORAGE_QUOTA_EXCEEDED` operation error code with `retryable: false`. The message says nothing was written, reading still works and the owner must free up space or upgrade; `details.account` carries the account totals when known. Behaviour change: a KV write on full storage was a retryable `NODE_ERROR`, and a SQL write was `SQL_EXECUTION_FAILED` with an unknown outcome.
  - VFS: a write on full storage fails with `ENOSPC` instead of `EIO`.

- 045c2d3: TC-634: `tc kv` previously surfaced some HTTP 401/403 refusals as `AUTH_UNAUTHORIZED` or `NETWORK_ERROR` with exit 1. Get, put, head, list, and delete now return `AUTH_REQUIRED` (exit 3) for plain 401 and `PERMISSION_DENIED` (exit 5) for 403 or a 401 with a validated missing capability. `tc space list|host` and `tc sql` honor typed status, while deliberately constructed CLI errors retain their own code, exit code, and metadata. The same service-result mapping applies to `tc vault`, `tc vars`, `tc duckdb`, `tc secrets list|put|delete`, `tc delegation`, and `tc account`: a status-less `AUTH_UNAUTHORIZED` now exits 5 as `PERMISSION_DENIED` instead of exit 1. Untyped signer JWK failures still request sign-in. Capability-request hints use validated TinyCloud resources and actions, including root or trailing-prefix KV lists and nested SQL spaces; noninteractive JSON adds optional `meta` with HTTP status and only validated resource/action fields, never arbitrary server metadata. Non-auth failures and `tc share` redaction remain unchanged.
- b0972e5: `tc share publish --notify` refuses a share without `read` before publication. Domain invitations use `--to domain:<name> --notify --notify-to <mailbox>` on a node reporting 1.17.3 or later; a session-only publisher may deliver its own signed policy when its sender DID matches the policy owner. Unsupported nodes are refused before upload or registration, and standalone `tc share notify` checks stored read permission and domain node support before delivery. Notifications use an atomic, profile-locked sender-history confirmation; a history write failure warns without hiding successful delivery, and concurrent revocation or invitations retain each other's fields. Publish JSON includes the additive `notification` result, including non-retryable window failures. `ShareNotifyError.code` remains `"delivery-failed"`; its optional `reason` distinguishes an expired delivery window. Confirmed repeats report `already-delivered` using encrypted sender history; a lost response remains a retryable failure rather than a false confirmation.

  Post-publication history writes wait through profile-lock recovery, but a failed initial write no longer hides the published link; the CLI warns that sender-history commands cannot later find that share. Share lock timeouts keep the standard `PROFILE_LOCK_TIMEOUT` retry guidance. OpenKey history signing, identity validation, and key derivation occur outside the profile lock, with the selected profile/key rechecked inside it. Standalone domain notifications reject mismatched recipients and expired delivery windows locally before probing the node. A stalled `/info` response body is classified as unavailable rather than an unsupported version, and publish versus notify errors state precisely whether a share was created.

  Each sender-history operation now pins its profile across bounded salt/key-input retries, preventing a changed default profile from receiving another profile's share record. History identity tracks only local private-key material or the OpenKey session signer JWK and verification method, so unrelated profile edits do not interrupt writes. Failed retries and disappearing profiles return a typed, actionable `SHARE_HISTORY_RETRY` instead of an argument error. Writes waiting more than about two seconds for the profile lock name the profile on stderr once, while keeping the 45-second recovery window.

  A profile missing from the outset retains `PROFILE_NOT_FOUND` and its setup guidance instead of masquerading as a retryable history change. The sender-history adapter remembers observed profiles by name across its operations, so a profile removed between a share read and its post-revocation update returns `SHARE_HISTORY_RETRY` with the warning that node revocation may already have succeeded; another previously unseen profile still returns `PROFILE_NOT_FOUND`. Mismatched resolved signer profiles now return the typed history retry error. Node authentication and every sender-history operation share one command-pinned profile, so a changed default cannot send a published share's link to a different profile. The Share reference also lists the exit-1 lock and history-retry codes.

- b78f6a8: The CLI now tells you when you sign in with an OpenKey key that is not your account's primary key (TC-705). An OpenKey account can hold several keys, and each key is a separate owner with its own spaces and data.
  - **Record.** After a verified OpenKey login (browser, paste or device), the profile records OpenKey's `primary` flag as `ownerKeyPrimary`. `tc auth status` shows it as `Primary Key` (JSON `ownerKeyPrimary`, `null` when OpenKey did not say). A re-login replaces it, and it is only recorded beside a verified owner. It is unsigned metadata, never authority.
  - **Warn.** A login approved by another key succeeds, but prints a warning on stderr that names the owner and explains that its data is separate. stdout and JSON output are unchanged. OpenKey deployments that do not report the flag produce no warning.
  - **`--owner` on plain login.** `tc auth login --owner <did>` no longer requires `--manifest`. It asks OpenKey for the same default abilities on that owner's `default` space, so OpenKey preselects that key, and an approval by any other identity is still refused with `OPENKEY_OWNER_MISMATCH`.

### Patch Changes

- ada86ed: Review fixes (TC-19): `openReplica` requires `principal` — the signed-in user's identity DID — as an app-asserted partition label; the replica database key becomes `sha256(host, space, prefix, deviceDid, principal)`. Session-key rotation (every `delegateTo` signs with the session key) lands as a pending grant in the same partition and the node promotes it on the next attested page, continuing from the stored cursor. Grants are no longer issuer-bound at install: `installGrant` accepts any grant addressed to this device that covers this replica's scope in its validity window; the node authorizes at sync time. `open()` and `status()` now always return the full replica status (the `authorized` flag and restricted-status gate are gone). A malformed `principal` throws `REPLICA_INVALID_ARGUMENT` before a worker spawns.

  Second review round (TC-19): `openReplica`'s `worker` option also accepts a `() => Worker` factory, evaluated after `principal` validation so a rejected open never spawns a worker; `principal` is now validated before the worker spawns at all. `purgeReplicaStore` takes the Web Lock before the durable lease — the same order `handleReset` uses — and releases every acquired resource on failure so a BUSY purge never leaks a lease. The Chromium fixture now includes a `/default.html` importmap page that loads the packaged `dist/` verbatim, so the real `new URL("./replica.worker.js", import.meta.url)` path is exercised without a bundler-emitted worker asset masking it.

  Fourth review round (TC-19): `reset --purge` no longer deletes the IndexedDB database at all — a queued `deleteDatabase` could fire after a new replica was created under the same name, so the purge is now a wipe in place. One `readwrite` commit clears `entries` and `blobs`, drops authority and the grant, releases the lease, bumps `writerEpoch`, and stamps a durable `{purged, generation+1}` marker in `meta`; the reset resolves `{ purged: true }` the moment that commit lands and nothing after it can change the result. Every store transaction re-checks the marker and its opening generation inside the transaction itself — a tombstoned connection gets `RESET_REQUIRED` on any read or write, even if it never saw a `versionchange` — and the next `openReplica` reinitializes the same database under the next generation, so no replica created after a purge can ever be lost. The file left behind is a small empty database named by the replica's hash, holding no user data, which the next open reuses. `DeletionOutcome`, `deleteReplicaDatabase`, `deleteWaitMs`, `onDeleteBlocked` and the `deletion` result field are gone.

  Concurrent first opens can no longer race to write two device keys — `deviceIdentity` re-reads inside the write transaction and returns the stored identity — and `init` accepts an identical stored config instead of raising `REPLICA_CONFIG_MISMATCH`. `setRetentionGrant` clears the attested `retainUntil` when the retain grant CID changes (or is cleared), and a committed page only persists `retainUntil` while the stored `retentionGrantCid` still equals the CID the request presented — an in-flight sync cannot revive the previous grant's window. Both affect the SQLite store bundled into `tc replica` and the IndexedDB store. `BrowserReplica.close()` rejects in-flight and later calls with `REPLICA_CLOSED` before the close handshake is sent, so a reply arriving mid-close is ignored. Commits broadcast `committed` per page and per repair batch (not only per sync); `reset --purge` and manual `reset` broadcast to sibling tabs, whose stores surface `RESET_REQUIRED` after a sibling purge. **Breaking-ish:** `openReplica` requires `principal`; `open()`/`status()` no longer return `authorized`; `REPLICA_CLOSED` replaces `STORAGE_ERROR` for post-close calls.

- f25aa05: Bring the remaining profile writers under the profile lock. `tc profile delete` waits for the lock and removes the profile's files while holding it (session and key first, settings last), never another holder's lock, and unlinks a symlinked profile directory without touching its target. It refuses a name that is not one path segment with `INVALID_PROFILE_NAME`; before, `tc profile delete ..` removed the whole TinyCloud home. Local `tc auth rotate` keeps the previous session when a concurrent change refuses its commit (`PROFILE_CHANGED_DURING_LOGIN`). The delegate-session bootstrap in `tc auth import` reads the profile, key and session under the lock, never replaces a session that appeared meanwhile (`PROFILE_CHANGED_DURING_IMPORT`), and rolls itself back if it fails. A failed request-bound import rolls back that bootstrap only if the profile still holds what the bootstrap wrote, and keeps (and reports) newer state otherwise; if the rollback cannot run, the import's error is still the one reported. Other import forms keep a successful bootstrap when a later step fails, as before. A lock acquirer that finds its profile directory removed by a concurrent delete recreates it and retries within its deadline instead of failing.
- 6de6688: `tc share publish --to email:<address> --notify` now emails the invitation and exits 0 on tinycloud-node 1.17.2. Exact-email shares now sign their canonical recipient as the envelope's delivery address. Node 1.17.2 requires it before it authorizes an invitation (without it the node answers `403 delivery-authorization-invalid` and the CLI exits 9); 1.17.3 accepts it but no longer requires it. A mailbox the share envelope cannot carry as a delivery address (for example `a/b@example.com`) is published without one, as before, so on nodes before 1.17.3 it cannot be emailed. On those nodes, email shares published by earlier CLI versions cannot be emailed either; publish them again.

  `@tinycloud/share-envelope` exports `isEnvelopeDeliveryEmail`, the rule envelopes apply to `deliveryEmail`. `prepareAddressedShare` in `@tinycloud/share-sdk` now refuses a `deliveryEmail` that rule rejects before any side effect, instead of failing after upload and policy registration.

- b7fd979: The CLI now replays stored compact-UCAN delegations under the same request-binding rule as the operations runtime: through validated activation, and only when the delegation's signed capabilities fit inside its stored `authorityRequest`. A delegation broader than its binding is refused before it is activated, so `tc kv` and `tc sql` can no longer use it either. Signed-login grants from `tc auth request --grant` and secret-read approvals replay as before, sending the node only their single `Authorization` header; a stored record with any other header shape, or one of these records that carries an `authorityRequest`, installs nothing. A new OpenKey or local grant never replaces a stored record for the same CID that carries a binding. Ordinary commands on a local-key profile now run the profile's one-time binding migration; an explicit `--private-key` override does not.

  `tc auth import` of an artifact with no request (a bare portable delegation, a stored record, or an envelope without `requestId`) now validates a compact-UCAN delegation addressed to the profile's session key, and stores it bound to exactly its own signed capabilities (`unbound-import:<cid>`, with an audit note). It therefore keeps working with `tc secrets get` and MCP tools after the profile's one-time binding migration. Importing a CID that is already stored never drops or weakens its binding, and a delegation whose header is not a single string `Authorization` is refused with `INVALID_AUTH_IMPORT`.

  `tc status` skips stored records replay never installs (not objects, malformed headers, bound records the legacy path cannot hold) and reports how many it skipped, instead of exiting with an error.

  The skill's `AUTH.md` and `REFERENCE.md` describe the bindings, the one-time migration, and how to recover a record that installs nothing.

- dca972f: An expired stored session now asks for a new sign-in instead of looking like a node failure (TC-607). When node-sdk refuses a persisted signed session as expired or no longer valid (`AUTH_EXPIRED`), the operations runtime returns a non-retryable `AUTH_REQUIRED` (the code TC-634 uses for a node's 401) instead of a retryable `NODE_ERROR`, and the CLI reports `AUTH_REQUIRED` (exit 3) with a sign-in hint for the profile's kind (scoped paste login for a delegate, `--method local` for a local owner key, `--method openkey` for an OpenKey owner). This covers `tc secrets get/list/put/delete`, `tc auth import` of a request-bound delegation, and every other command that restores a stored session; the refusal happens before any node request. Share commands keep their share-publishing sign-in guidance. Operations and MCP consumers that switch on error codes see `AUTH_REQUIRED` where they previously saw `NODE_ERROR` for this case. Any service result coded `AUTH_REQUIRED` or `PERMISSION_DENIED` without an HTTP status now exits 3 or 5 instead of 1 in commands using `cliErrorFromService` (account, delegation, duckdb, kv, secrets list/put/delete, space, sql, vars and vault); for example, `tc secrets list` without a grant returns the NodeSecretsService's status-less `PERMISSION_DENIED` with exit 5. `tc secrets get` and `tc auth import` also supply the profile kind's sign-in hint for `AUTH_REQUIRED`. A delegate session bootstrapped by `tc auth import` carries no signed expiry and is still refused by the node instead.

  Interactive secret escalation and `tc auth request --grant` now send OpenKey `/delegate` a request it signs, and the approved grant now authorizes `secrets get` (TC-609). Each request adds `tinycloud.capabilities/read` on its space root, keeps raw decrypt in the `encryption` pseudo-space with an EIP-55 owner, and anchors a decrypt-only request in the secrets space (`--space` when given) or, for `auth request --grant`, the profile's primary space. The signed proof is verified before anything is activated or stored; the added `capabilities/read` counts as requested, and any other authority beyond the request is refused.

  `activateValidatedRuntimeDelegation` now accepts wallet-signed CACAO session grants (OpenKey `/delegate`, `grantRuntimePermissions`) as well as compact UCANs. Such a grant must carry `siweProof` (its SIWE and signature, now set by `grantRuntimePermissions` and by the CLI when it stores an OpenKey grant); it is verified with the new `TinyCloudNode.verifySessionGrant` against the live session key, must be signed by the session's owner for one owner space and owner networks, and installs exactly the verified ReCap. The CLI stores each such grant (`tc auth request --grant`, secret-read approvals) with its `siweProof` and an `authorityRequest` binding to exactly its signed capabilities as validated activation reads them (`cli-grant:<cid>`, new `bindCliGrant` in `@tinycloud/operations/delegation-binding`), so the request-binding replay rule installs it in the CLI, `secrets get` and MCP; a signed-login record with a proof but no valid binding installs nothing. Grants stored without a proof by earlier releases are not used by operations. `replayStoredDelegation` now returns `{ status: "installed" | "skipped" | "not-replayed" }` with a fixed skip `reason` instead of the installed delegation or `undefined`. Refusals throw `RuntimeDelegationRejectedError` with a stable `reason` (`RUNTIME_DELEGATION_REJECTIONS`). Operation results gain an optional `warnings` array: every unexpired stored grant the runtime skips is listed as `{ code: "STORED_GRANT_SKIPPED", reason, grantCid? }` with a fixed reason code (including `unbound` and `outside_request` for the request-binding rule) and never error text, node responses or stored URLs (expired grants are still dropped silently); `grantCid` appears only when it is the CID recomputed from the stored authorization bytes. The CLI prints them inside its JSON error, beside TC-634's `meta` (also when an `-o` write or browser approval fails), as one JSON line on stderr after a successful command's output, or as one human-readable line. `--json` now selects JSON errors and warnings, and suppresses progress spinners, the banner and the missing-profile notice, even when stdout is a terminal; it is read from the parsed options, so a `--json` operand after `--` does not count. `secrets get` reports missing authority as `PERMISSION_DENIED` with exit 5 instead of exit 1.

- dca972f: A local-key grant of only raw decrypt on the owner's encryption network can be stored and used again (TC-609). `tc auth request --grant` and a secret read's escalation activated such a grant, then refused to store it, because verifying it reused the persisted-session check that a session's ReCap authorizes its primary space, and a raw network names no space. The new WASM export `validateSessionGrant` (optional `IWasmBindings.validateSessionGrant`, implemented by `NodeWasmBindings`) runs the same signature, signer, audience, lifetime, ReCap and CID checks, and waives the space check only for a grant whose ReCap holds nothing but raw encryption-network resources; a grant with no ReCap authority is refused. `TinyCloudNode.verifySessionGrant` uses it, falling back to `validatePersistedSession` (which refuses decrypt-only grants) for bindings without it. Restoring a session still uses `validatePersistedSession` and its space check.
- 7edc599: Make the profile lock safe against paused processes and older releases, and usable without hard links. This release takes a turn in `~/.tinycloud/profile-locks/<profile>/` before the `.lock` directory shared with CLI 1.0.0-beta.16 and older and 1.0.0-beta.17 … 1.0.1-beta.4. Turns do not expire with time: a paused process of this release cannot let another writer in, and only one at a time reclaims an abandoned `.lock`. This assumes one host and PID namespace and a filesystem whose directory `rename` fails onto an existing directory; a `TC_HOME` shared across machines or containers without a shared PID namespace is unsupported. Older releases still race when one pauses after `mkdir(.lock)` past the stale threshold or reclaims concurrently with that paused writer.

  With hard links, dead-owner recovery claims and verifies the observed record without moving a live owner or removing a new empty `.lock` after a failed claim. Without hard links (FAT/exFAT, some SMB mounts), owner publication uses exclusive creation and recovery moves the record into `.recover-*`; an incomplete record left by a crash is reclaimed once 30 s old. On either path, a recoverer can claim a replacement live owner's record, detect the mismatch, and crash before dropping its hard link or restoring its moved record. If the holder then releases but its process stays alive, the next current-release acquisition restores the claim as `owner.json` and may remain blocked until the PID exits and the record is at least 30 s old (for a long-lived MCP server, possibly until it restarts). This costs availability only, never exclusion. Releases through 1.0.1-beta.4 cannot reclaim a `.recover-*` claim left by a crashed current-release recoverer, even once aged; a current release can process it. To clear a stalled profile manually, remove its `.lock` only when no tc or MCP process is running.

  A failed lock-file write (a full disk, a permission error) is retried. A turn left unfinished is settled once writes work again, by the same process (in the background, or on its next write) or by others once it exits; an unreadable turn record is never voided on that account. If the turn lock is damaged, `PROFILE_LOCK_TIMEOUT` names `~/.tinycloud/profile-locks/<profile>`, which can be removed while no tc or MCP process uses the profile. Process-wide held-lock entries now use `tinycloud.operations.heldProfileLocks.v2` to exclude TC-602's earlier shape; the invocation state root remains the same string path in `.v1`.

  A key, session, delegation or permission-request write that waited for the lock while `tc profile delete` removed the profile (whether it arrived before or after the deletion's files were removed) now fails with `PROFILE_NOT_FOUND` instead of recreating a profile without settings. `@tinycloud/operations/state` exports `recordProfileDeletion`, `refuseWriteToDeletedProfile`, `ProfileDeletedError` and `profileTurnLockPath` for this. `tc profile delete` of a profile that does not exist no longer creates lock state. The rollback of a failed `tc auth import` bootstrap compares only what the bootstrap wrote (the session, and the profile's session DID and space), so an unrelated profile change made meanwhile, such as a new default space, no longer keeps the provisional session and is itself kept. Its notes name failures by code and never quote file contents.

- c923361: TC-649: For a missing secret, the setup link printed by `tc secrets get` and returned by MCP `secrets.get` now opens Secret Manager with the name filled in: `https://secrets.tinycloud.xyz/app?secret=NAME` plus `&scope=…` when scoped. Before, `https://secrets.tinycloud.xyz?name=NAME` opened the landing page and filled in nothing.
- bac8f2d: `tc auth logout` and `tc auth login` (OpenKey) now fail with `PROFILE_NOT_FOUND` when the selected profile does not exist. Logout used to report `{"authenticated":false}` for a profile that was never created, and login reported `NO_KEY` with a `tc init` hint that targets the `default` profile. The missing-profile error now suggests `tc init --name <profile>`, and `NO_KEY` on an existing profile suggests `tc --profile <profile> auth rotate`.
- 2c703fc: `tc delegation revoke <cid>` tries authority scoped to that CID, falls back to a locally stored signed grant artifact only when the raw-CID encoder is unavailable, and keeps temporary authority out of profile storage. Noninteractive authority acquisition requires `--yes`; node-side 403 rejections are reported as typed CLI errors.
- cadda9a: Write `kv`, `vault`, `vars`, and `secrets` get outputs through a shared private atomic writer. `auth logout` now removes the profile's local replicas by default, with `--keep-replicas` to retain them and a warning that node grants remain valid until expiry. Sync warns when it replicates secret ciphertext (related to TC-755).
- b5b8161: Mark `tc replica` as a beta feature in help text.
- Updated dependencies [02b6773]
- Updated dependencies [37123c3]
- Updated dependencies [f25aa05]
- Updated dependencies [0652195]
- Updated dependencies [6de6688]
- Updated dependencies [6484eba]
- Updated dependencies [b7fd979]
- Updated dependencies [b7fd979]
- Updated dependencies [dca972f]
- Updated dependencies [dca972f]
- Updated dependencies [a074fa5]
- Updated dependencies [e2ec154]
- Updated dependencies [7edc599]
- Updated dependencies [045c2d3]
- Updated dependencies [045c2d3]
- Updated dependencies [045c2d3]
- Updated dependencies [045c2d3]
- Updated dependencies [b0972e5]
- Updated dependencies [c923361]
- Updated dependencies [698654e]
- Updated dependencies [2c703fc]
- Updated dependencies [1f44a61]
  - @tinycloud/sdk-core@3.1.0
  - @tinycloud/node-sdk@3.1.0
  - @tinycloud/operations@0.4.0
  - @tinycloud/share-envelope@1.1.0
  - @tinycloud/share-sdk@1.1.0
  - @tinycloud/node-sdk-wasm@1.7.7

## 1.1.0-beta.24

### Patch Changes

- Updated dependencies [1f44a61]
  - @tinycloud/node-sdk@3.1.0-beta.15
  - @tinycloud/operations@0.4.0-beta.19

## 1.1.0-beta.23

### Patch Changes

- b5b8161: Mark `tc replica` as a beta feature in help text.

## 1.1.0-beta.22

### Patch Changes

- cadda9a: Write `kv`, `vault`, `vars`, and `secrets` get outputs through a shared private atomic writer. `auth logout` now removes the profile's local replicas by default, with `--keep-replicas` to retain them and a warning that node grants remain valid until expiry. Sync warns when it replicates secret ciphertext (related to TC-755).

## 1.1.0-beta.21

### Patch Changes

- @tinycloud/node-sdk@3.1.0-beta.14
- @tinycloud/operations@0.4.0-beta.18
- @tinycloud/sdk-core@3.1.0-beta.14

## 1.1.0-beta.20

### Patch Changes

- @tinycloud/node-sdk@3.1.0-beta.13
- @tinycloud/operations@0.4.0-beta.17
- @tinycloud/sdk-core@3.1.0-beta.13

## 1.1.0-beta.19

### Patch Changes

- 2c703fc: `tc delegation revoke <cid>` tries authority scoped to that CID, falls back to a locally stored signed grant artifact only when the raw-CID encoder is unavailable, and keeps temporary authority out of profile storage. Noninteractive authority acquisition requires `--yes`; node-side 403 rejections are reported as typed CLI errors.
- Updated dependencies [2c703fc]
  - @tinycloud/sdk-core@3.1.0-beta.12
  - @tinycloud/node-sdk@3.1.0-beta.12
  - @tinycloud/operations@0.4.0-beta.16

## 1.1.0-beta.18

### Patch Changes

- ada86ed: Review fixes (TC-19): `openReplica` requires `principal` — the signed-in user's identity DID — as an app-asserted partition label; the replica database key becomes `sha256(host, space, prefix, deviceDid, principal)`. Session-key rotation (every `delegateTo` signs with the session key) lands as a pending grant in the same partition and the node promotes it on the next attested page, continuing from the stored cursor. Grants are no longer issuer-bound at install: `installGrant` accepts any grant addressed to this device that covers this replica's scope in its validity window; the node authorizes at sync time. `open()` and `status()` now always return the full replica status (the `authorized` flag and restricted-status gate are gone). A malformed `principal` throws `REPLICA_INVALID_ARGUMENT` before a worker spawns.

  Second review round (TC-19): `openReplica`'s `worker` option also accepts a `() => Worker` factory, evaluated after `principal` validation so a rejected open never spawns a worker; `principal` is now validated before the worker spawns at all. `purgeReplicaStore` takes the Web Lock before the durable lease — the same order `handleReset` uses — and releases every acquired resource on failure so a BUSY purge never leaks a lease. The Chromium fixture now includes a `/default.html` importmap page that loads the packaged `dist/` verbatim, so the real `new URL("./replica.worker.js", import.meta.url)` path is exercised without a bundler-emitted worker asset masking it.

  Fourth review round (TC-19): `reset --purge` no longer deletes the IndexedDB database at all — a queued `deleteDatabase` could fire after a new replica was created under the same name, so the purge is now a wipe in place. One `readwrite` commit clears `entries` and `blobs`, drops authority and the grant, releases the lease, bumps `writerEpoch`, and stamps a durable `{purged, generation+1}` marker in `meta`; the reset resolves `{ purged: true }` the moment that commit lands and nothing after it can change the result. Every store transaction re-checks the marker and its opening generation inside the transaction itself — a tombstoned connection gets `RESET_REQUIRED` on any read or write, even if it never saw a `versionchange` — and the next `openReplica` reinitializes the same database under the next generation, so no replica created after a purge can ever be lost. The file left behind is a small empty database named by the replica's hash, holding no user data, which the next open reuses. `DeletionOutcome`, `deleteReplicaDatabase`, `deleteWaitMs`, `onDeleteBlocked` and the `deletion` result field are gone.

  Concurrent first opens can no longer race to write two device keys — `deviceIdentity` re-reads inside the write transaction and returns the stored identity — and `init` accepts an identical stored config instead of raising `REPLICA_CONFIG_MISMATCH`. `setRetentionGrant` clears the attested `retainUntil` when the retain grant CID changes (or is cleared), and a committed page only persists `retainUntil` while the stored `retentionGrantCid` still equals the CID the request presented — an in-flight sync cannot revive the previous grant's window. Both affect the SQLite store bundled into `tc replica` and the IndexedDB store. `BrowserReplica.close()` rejects in-flight and later calls with `REPLICA_CLOSED` before the close handshake is sent, so a reply arriving mid-close is ignored. Commits broadcast `committed` per page and per repair batch (not only per sync); `reset --purge` and manual `reset` broadcast to sibling tabs, whose stores surface `RESET_REQUIRED` after a sibling purge. **Breaking-ish:** `openReplica` requires `principal`; `open()`/`status()` no longer return `authorized`; `REPLICA_CLOSED` replaces `STORAGE_ERROR` for post-close calls.

## 1.1.0-beta.17

### Patch Changes

- Updated dependencies [02b6773]
  - @tinycloud/sdk-core@3.1.0-beta.11
  - @tinycloud/node-sdk@3.1.0-beta.11
  - @tinycloud/operations@0.4.0-beta.15

## 1.1.0-beta.16

### Minor Changes

- 37123c3: New package `@tinycloud/replica` (first beta): a durable, read-only local replica of one KV prefix, kept current over the node's `tinycloud.kv/sync` change feed (`kv-sync-v1`, TinyCloud Node with TC-732). It verifies every value against the node-attested blake3 ETag before committing, commits each feed page with its cursor in one transaction, enforces the node-attested authority window offline (optionally extended by a `tinycloud.kv/retain` grant), purges itself when it learns of a revocation, and resets in place on `410 RESET_REQUIRED`. `.` exports the engine, the frozen `ReplicaTransport`/`ReplicaStore` contracts, `kvSyncTransport(kv)` over `KVService.changes()` and the worker-safe `parseUcanGrant`; `./sqlite` is the Node/Bun store (built-in `node:sqlite` on Node 22.13+, `bun:sqlite` under Bun; no native addon).

  `tc replica sync|get|list|status|reset` (CLI): sync a prefix under a device grant carrying `tinycloud.kv/sync` and `tinycloud.kv/get`, then read it with the host offline. `get`, `list`, `status` and `reset` never touch the network. On Node.js older than 22.13 every `tc replica` command exits 1 with `RUNTIME_UNSUPPORTED`; other commands keep working on Node 20.

### Patch Changes

- Updated dependencies [37123c3]
  - @tinycloud/operations@0.4.0-beta.14
  - @tinycloud/node-sdk@3.1.0-beta.10
  - @tinycloud/sdk-core@3.1.0-beta.10

## 1.1.0-beta.15

### Patch Changes

- Updated dependencies [698654e]
  - @tinycloud/sdk-core@3.1.0-beta.9
  - @tinycloud/node-sdk@3.1.0-beta.9
  - @tinycloud/operations@0.4.0-beta.13

## 1.1.0-beta.14

### Minor Changes

- dea6d3f: Manual OpenKey login now accepts an eight-character delegation retrieval code in `tc auth login --paste` and the interactive callback fallback. The CLI checks that the fetched public delegation belongs to its local session key. Full JSON and base64 delegation paste remain available when the broker cannot be reached.

### Patch Changes

- dca972f: An expired stored session now asks for a new sign-in instead of looking like a node failure (TC-607). When node-sdk refuses a persisted signed session as expired or no longer valid (`AUTH_EXPIRED`), the operations runtime returns a non-retryable `AUTH_REQUIRED` (the code TC-634 uses for a node's 401) instead of a retryable `NODE_ERROR`, and the CLI reports `AUTH_REQUIRED` (exit 3) with a sign-in hint for the profile's kind (scoped paste login for a delegate, `--method local` for a local owner key, `--method openkey` for an OpenKey owner). This covers `tc secrets get/list/put/delete`, `tc auth import` of a request-bound delegation, and every other command that restores a stored session; the refusal happens before any node request. Share commands keep their share-publishing sign-in guidance. Operations and MCP consumers that switch on error codes see `AUTH_REQUIRED` where they previously saw `NODE_ERROR` for this case. Any service result coded `AUTH_REQUIRED` or `PERMISSION_DENIED` without an HTTP status now exits 3 or 5 instead of 1 in commands using `cliErrorFromService` (account, delegation, duckdb, kv, secrets list/put/delete, space, sql, vars and vault); for example, `tc secrets list` without a grant returns the NodeSecretsService's status-less `PERMISSION_DENIED` with exit 5. `tc secrets get` and `tc auth import` also supply the profile kind's sign-in hint for `AUTH_REQUIRED`. A delegate session bootstrapped by `tc auth import` carries no signed expiry and is still refused by the node instead.

  Interactive secret escalation and `tc auth request --grant` now send OpenKey `/delegate` a request it signs, and the approved grant now authorizes `secrets get` (TC-609). Each request adds `tinycloud.capabilities/read` on its space root, keeps raw decrypt in the `encryption` pseudo-space with an EIP-55 owner, and anchors a decrypt-only request in the secrets space (`--space` when given) or, for `auth request --grant`, the profile's primary space. The signed proof is verified before anything is activated or stored; the added `capabilities/read` counts as requested, and any other authority beyond the request is refused.

  `activateValidatedRuntimeDelegation` now accepts wallet-signed CACAO session grants (OpenKey `/delegate`, `grantRuntimePermissions`) as well as compact UCANs. Such a grant must carry `siweProof` (its SIWE and signature, now set by `grantRuntimePermissions` and by the CLI when it stores an OpenKey grant); it is verified with the new `TinyCloudNode.verifySessionGrant` against the live session key, must be signed by the session's owner for one owner space and owner networks, and installs exactly the verified ReCap. The CLI stores each such grant (`tc auth request --grant`, secret-read approvals) with its `siweProof` and an `authorityRequest` binding to exactly its signed capabilities as validated activation reads them (`cli-grant:<cid>`, new `bindCliGrant` in `@tinycloud/operations/delegation-binding`), so the request-binding replay rule installs it in the CLI, `secrets get` and MCP; a signed-login record with a proof but no valid binding installs nothing. Grants stored without a proof by earlier releases are not used by operations. `replayStoredDelegation` now returns `{ status: "installed" | "skipped" | "not-replayed" }` with a fixed skip `reason` instead of the installed delegation or `undefined`. Refusals throw `RuntimeDelegationRejectedError` with a stable `reason` (`RUNTIME_DELEGATION_REJECTIONS`). Operation results gain an optional `warnings` array: every unexpired stored grant the runtime skips is listed as `{ code: "STORED_GRANT_SKIPPED", reason, grantCid? }` with a fixed reason code (including `unbound` and `outside_request` for the request-binding rule) and never error text, node responses or stored URLs (expired grants are still dropped silently); `grantCid` appears only when it is the CID recomputed from the stored authorization bytes. The CLI prints them inside its JSON error, beside TC-634's `meta` (also when an `-o` write or browser approval fails), as one JSON line on stderr after a successful command's output, or as one human-readable line. `--json` now selects JSON errors and warnings, and suppresses progress spinners, the banner and the missing-profile notice, even when stdout is a terminal; it is read from the parsed options, so a `--json` operand after `--` does not count. `secrets get` reports missing authority as `PERMISSION_DENIED` with exit 5 instead of exit 1.

- dca972f: A local-key grant of only raw decrypt on the owner's encryption network can be stored and used again (TC-609). `tc auth request --grant` and a secret read's escalation activated such a grant, then refused to store it, because verifying it reused the persisted-session check that a session's ReCap authorizes its primary space, and a raw network names no space. The new WASM export `validateSessionGrant` (optional `IWasmBindings.validateSessionGrant`, implemented by `NodeWasmBindings`) runs the same signature, signer, audience, lifetime, ReCap and CID checks, and waives the space check only for a grant whose ReCap holds nothing but raw encryption-network resources; a grant with no ReCap authority is refused. `TinyCloudNode.verifySessionGrant` uses it, falling back to `validatePersistedSession` (which refuses decrypt-only grants) for bindings without it. Restoring a session still uses `validatePersistedSession` and its space check.
- Updated dependencies [dca972f]
- Updated dependencies [dca972f]
  - @tinycloud/node-sdk@3.1.0-beta.8
  - @tinycloud/operations@0.4.0-beta.12
  - @tinycloud/node-sdk-wasm@1.7.7-beta.0
  - @tinycloud/sdk-core@3.1.0-beta.8

## 1.1.0-beta.13

### Minor Changes

- e2ec154: TC-625: Every command and tool reports full TinyCloud storage the same way.
  - CLI: a write refused because storage is full (`STORAGE_QUOTA_EXCEEDED`) or too small for the write (`STORAGE_LIMIT_REACHED`) exits with the new code 10 (`ExitCode.STORAGE_FULL`) from every command, including `kv`, `sql`, `duckdb`, `vars`, `vault`, `secrets`, `account` and `share`. It prints one message, `TinyCloud storage is full; nothing was written.`, with a hint that gives the account totals when the SDK reports them (`371.7 MiB used of 100 MiB (free plan)`), says reading still works, and links to https://account.tinycloud.xyz/billing. It never shows the per-space limit or the switch-hosts network hint. `tc sql copy` that fills storage part-way keeps its progress instead (`Insert into "notes" failed after 2 row(s): TinyCloud storage is full.`). The node's storage text is read only from an uncoded 402 or 413 response; an error with another code, such as a local `ENOENT`, keeps its own mapping. Behaviour change: `tc kv put` exited 1 and `tc share` exited 4 for a full space; both now exit 10. `tc share` keeps 8 for `UNSAFE_FILENAME`/`OUTPUT_EXISTS` and 9 for notify partial failure. `tc share` reports a write larger than the remaining storage as `STORAGE_LIMIT_REACHED` instead of `UPLOAD_FAILED`.
  - Operations and MCP: a new `STORAGE_QUOTA_EXCEEDED` operation error code with `retryable: false`. The message says nothing was written, reading still works and the owner must free up space or upgrade; `details.account` carries the account totals when known. Behaviour change: a KV write on full storage was a retryable `NODE_ERROR`, and a SQL write was `SQL_EXECUTION_FAILED` with an unknown outcome.
  - VFS: a write on full storage fails with `ENOSPC` instead of `EIO`.

### Patch Changes

- Updated dependencies [e2ec154]
  - @tinycloud/operations@0.4.0-beta.11

## 1.1.0-beta.12

### Minor Changes

- b78f6a8: The CLI now tells you when you sign in with an OpenKey key that is not your account's primary key (TC-705). An OpenKey account can hold several keys, and each key is a separate owner with its own spaces and data.
  - **Record.** After a verified OpenKey login (browser, paste or device), the profile records OpenKey's `primary` flag as `ownerKeyPrimary`. `tc auth status` shows it as `Primary Key` (JSON `ownerKeyPrimary`, `null` when OpenKey did not say). A re-login replaces it, and it is only recorded beside a verified owner. It is unsigned metadata, never authority.
  - **Warn.** A login approved by another key succeeds, but prints a warning on stderr that names the owner and explains that its data is separate. stdout and JSON output are unchanged. OpenKey deployments that do not report the flag produce no warning.
  - **`--owner` on plain login.** `tc auth login --owner <did>` no longer requires `--manifest`. It asks OpenKey for the same default abilities on that owner's `default` space, so OpenKey preselects that key, and an approval by any other identity is still refused with `OPENKEY_OWNER_MISMATCH`.

## 1.1.0-beta.11

### Patch Changes

- @tinycloud/node-sdk@3.1.0-beta.7
- @tinycloud/operations@0.4.0-beta.10
- @tinycloud/sdk-core@3.1.0-beta.7

## 1.1.0-beta.10

### Patch Changes

- bac8f2d: `tc auth logout` and `tc auth login` (OpenKey) now fail with `PROFILE_NOT_FOUND` when the selected profile does not exist. Logout used to report `{"authenticated":false}` for a profile that was never created, and login reported `NO_KEY` with a `tc init` hint that targets the `default` profile. The missing-profile error now suggests `tc init --name <profile>`, and `NO_KEY` on an existing profile suggests `tc --profile <profile> auth rotate`.

## 1.1.0-beta.9

### Minor Changes

- 045c2d3: TC-634: `tc kv` previously surfaced some HTTP 401/403 refusals as `AUTH_UNAUTHORIZED` or `NETWORK_ERROR` with exit 1. Get, put, head, list, and delete now return `AUTH_REQUIRED` (exit 3) for plain 401 and `PERMISSION_DENIED` (exit 5) for 403 or a 401 with a validated missing capability. `tc space list|host` and `tc sql` honor typed status, while deliberately constructed CLI errors retain their own code, exit code, and metadata. The same service-result mapping applies to `tc vault`, `tc vars`, `tc duckdb`, `tc secrets list|put|delete`, `tc delegation`, and `tc account`: a status-less `AUTH_UNAUTHORIZED` now exits 5 as `PERMISSION_DENIED` instead of exit 1. Untyped signer JWK failures still request sign-in. Capability-request hints use validated TinyCloud resources and actions, including root or trailing-prefix KV lists and nested SQL spaces; noninteractive JSON adds optional `meta` with HTTP status and only validated resource/action fields, never arbitrary server metadata. Non-auth failures and `tc share` redaction remain unchanged.

### Patch Changes

- Updated dependencies [045c2d3]
- Updated dependencies [045c2d3]
- Updated dependencies [045c2d3]
- Updated dependencies [045c2d3]
  - @tinycloud/sdk-core@3.1.0-beta.6
  - @tinycloud/operations@0.4.0-beta.9
  - @tinycloud/node-sdk@3.1.0-beta.6
  - @tinycloud/share-sdk@1.1.0-beta.2

## 1.1.0-beta.8

### Patch Changes

- 7edc599: Make the profile lock safe against paused processes and older releases, and usable without hard links. This release takes a turn in `~/.tinycloud/profile-locks/<profile>/` before the `.lock` directory shared with CLI 1.0.0-beta.16 and older and 1.0.0-beta.17 … 1.0.1-beta.4. Turns do not expire with time: a paused process of this release cannot let another writer in, and only one at a time reclaims an abandoned `.lock`. This assumes one host and PID namespace and a filesystem whose directory `rename` fails onto an existing directory; a `TC_HOME` shared across machines or containers without a shared PID namespace is unsupported. Older releases still race when one pauses after `mkdir(.lock)` past the stale threshold or reclaims concurrently with that paused writer.

  With hard links, dead-owner recovery claims and verifies the observed record without moving a live owner or removing a new empty `.lock` after a failed claim. Without hard links (FAT/exFAT, some SMB mounts), owner publication uses exclusive creation and recovery moves the record into `.recover-*`; an incomplete record left by a crash is reclaimed once 30 s old. On either path, a recoverer can claim a replacement live owner's record, detect the mismatch, and crash before dropping its hard link or restoring its moved record. If the holder then releases but its process stays alive, the next current-release acquisition restores the claim as `owner.json` and may remain blocked until the PID exits and the record is at least 30 s old (for a long-lived MCP server, possibly until it restarts). This costs availability only, never exclusion. Releases through 1.0.1-beta.4 cannot reclaim a `.recover-*` claim left by a crashed current-release recoverer, even once aged; a current release can process it. To clear a stalled profile manually, remove its `.lock` only when no tc or MCP process is running.

  A failed lock-file write (a full disk, a permission error) is retried. A turn left unfinished is settled once writes work again, by the same process (in the background, or on its next write) or by others once it exits; an unreadable turn record is never voided on that account. If the turn lock is damaged, `PROFILE_LOCK_TIMEOUT` names `~/.tinycloud/profile-locks/<profile>`, which can be removed while no tc or MCP process uses the profile. Process-wide held-lock entries now use `tinycloud.operations.heldProfileLocks.v2` to exclude TC-602's earlier shape; the invocation state root remains the same string path in `.v1`.

  A key, session, delegation or permission-request write that waited for the lock while `tc profile delete` removed the profile (whether it arrived before or after the deletion's files were removed) now fails with `PROFILE_NOT_FOUND` instead of recreating a profile without settings. `@tinycloud/operations/state` exports `recordProfileDeletion`, `refuseWriteToDeletedProfile`, `ProfileDeletedError` and `profileTurnLockPath` for this. `tc profile delete` of a profile that does not exist no longer creates lock state. The rollback of a failed `tc auth import` bootstrap compares only what the bootstrap wrote (the session, and the profile's session DID and space), so an unrelated profile change made meanwhile, such as a new default space, no longer keeps the provisional session and is itself kept. Its notes name failures by code and never quote file contents.

- Updated dependencies [7edc599]
  - @tinycloud/operations@0.4.0-beta.8

## 1.1.0-beta.7

### Patch Changes

- b7fd979: The CLI now replays stored compact-UCAN delegations under the same request-binding rule as the operations runtime: through validated activation, and only when the delegation's signed capabilities fit inside its stored `authorityRequest`. A delegation broader than its binding is refused before it is activated, so `tc kv` and `tc sql` can no longer use it either. Signed-login grants from `tc auth request --grant` and secret-read approvals replay as before, sending the node only their single `Authorization` header; a stored record with any other header shape, or one of these records that carries an `authorityRequest`, installs nothing. A new OpenKey or local grant never replaces a stored record for the same CID that carries a binding. Ordinary commands on a local-key profile now run the profile's one-time binding migration; an explicit `--private-key` override does not.

  `tc auth import` of an artifact with no request (a bare portable delegation, a stored record, or an envelope without `requestId`) now validates a compact-UCAN delegation addressed to the profile's session key, and stores it bound to exactly its own signed capabilities (`unbound-import:<cid>`, with an audit note). It therefore keeps working with `tc secrets get` and MCP tools after the profile's one-time binding migration. Importing a CID that is already stored never drops or weakens its binding, and a delegation whose header is not a single string `Authorization` is refused with `INVALID_AUTH_IMPORT`.

  `tc status` skips stored records replay never installs (not objects, malformed headers, bound records the legacy path cannot hold) and reports how many it skipped, instead of exiting with an error.

  The skill's `AUTH.md` and `REFERENCE.md` describe the bindings, the one-time migration, and how to recover a record that installs nothing.

- Updated dependencies [b7fd979]
- Updated dependencies [b7fd979]
  - @tinycloud/node-sdk@3.1.0-beta.5
  - @tinycloud/operations@0.4.0-beta.7

## 1.1.0-beta.6

### Minor Changes

- b0972e5: `tc share publish --notify` refuses a share without `read` before publication. Domain invitations use `--to domain:<name> --notify --notify-to <mailbox>` on a node reporting 1.17.3 or later; a session-only publisher may deliver its own signed policy when its sender DID matches the policy owner. Unsupported nodes are refused before upload or registration, and standalone `tc share notify` checks stored read permission and domain node support before delivery. Notifications use an atomic, profile-locked sender-history confirmation; a history write failure warns without hiding successful delivery, and concurrent revocation or invitations retain each other's fields. Publish JSON includes the additive `notification` result, including non-retryable window failures. `ShareNotifyError.code` remains `"delivery-failed"`; its optional `reason` distinguishes an expired delivery window. Confirmed repeats report `already-delivered` using encrypted sender history; a lost response remains a retryable failure rather than a false confirmation.

  Post-publication history writes wait through profile-lock recovery, but a failed initial write no longer hides the published link; the CLI warns that sender-history commands cannot later find that share. Share lock timeouts keep the standard `PROFILE_LOCK_TIMEOUT` retry guidance. OpenKey history signing, identity validation, and key derivation occur outside the profile lock, with the selected profile/key rechecked inside it. Standalone domain notifications reject mismatched recipients and expired delivery windows locally before probing the node. A stalled `/info` response body is classified as unavailable rather than an unsupported version, and publish versus notify errors state precisely whether a share was created.

  Each sender-history operation now pins its profile across bounded salt/key-input retries, preventing a changed default profile from receiving another profile's share record. History identity tracks only local private-key material or the OpenKey session signer JWK and verification method, so unrelated profile edits do not interrupt writes. Failed retries and disappearing profiles return a typed, actionable `SHARE_HISTORY_RETRY` instead of an argument error. Writes waiting more than about two seconds for the profile lock name the profile on stderr once, while keeping the 45-second recovery window.

  A profile missing from the outset retains `PROFILE_NOT_FOUND` and its setup guidance instead of masquerading as a retryable history change. The sender-history adapter remembers observed profiles by name across its operations, so a profile removed between a share read and its post-revocation update returns `SHARE_HISTORY_RETRY` with the warning that node revocation may already have succeeded; another previously unseen profile still returns `PROFILE_NOT_FOUND`. Mismatched resolved signer profiles now return the typed history retry error. Node authentication and every sender-history operation share one command-pinned profile, so a changed default cannot send a published share's link to a different profile. The Share reference also lists the exit-1 lock and history-retry codes.

### Patch Changes

- Updated dependencies [b0972e5]
  - @tinycloud/share-sdk@1.1.0-beta.1
  - @tinycloud/sdk-core@3.1.0-beta.4
  - @tinycloud/node-sdk@3.1.0-beta.4
  - @tinycloud/operations@0.3.4-beta.6

## 1.0.1-beta.5

### Patch Changes

- Updated dependencies [6484eba]
  - @tinycloud/sdk-core@3.1.0-beta.3
  - @tinycloud/node-sdk@3.1.0-beta.3
  - @tinycloud/operations@0.3.4-beta.5

## 1.0.1-beta.4

### Patch Changes

- c923361: TC-649: For a missing secret, the setup link printed by `tc secrets get` and returned by MCP `secrets.get` now opens Secret Manager with the name filled in: `https://secrets.tinycloud.xyz/app?secret=NAME` plus `&scope=…` when scoped. Before, `https://secrets.tinycloud.xyz?name=NAME` opened the landing page and filled in nothing.
- Updated dependencies [c923361]
  - @tinycloud/operations@0.3.4-beta.4

## 1.0.1-beta.3

### Patch Changes

- Updated dependencies [a074fa5]
  - @tinycloud/sdk-core@3.1.0-beta.2
  - @tinycloud/node-sdk@3.1.0-beta.2
  - @tinycloud/operations@0.3.4-beta.3

## 1.0.1-beta.2

### Patch Changes

- Updated dependencies [0652195]
  - @tinycloud/sdk-core@3.1.0-beta.1
  - @tinycloud/node-sdk@3.1.0-beta.1
  - @tinycloud/operations@0.3.4-beta.2

## 1.0.1-beta.1

### Patch Changes

- f25aa05: Bring the remaining profile writers under the profile lock. `tc profile delete` waits for the lock and removes the profile's files while holding it (session and key first, settings last), never another holder's lock, and unlinks a symlinked profile directory without touching its target. It refuses a name that is not one path segment with `INVALID_PROFILE_NAME`; before, `tc profile delete ..` removed the whole TinyCloud home. Local `tc auth rotate` keeps the previous session when a concurrent change refuses its commit (`PROFILE_CHANGED_DURING_LOGIN`). The delegate-session bootstrap in `tc auth import` reads the profile, key and session under the lock, never replaces a session that appeared meanwhile (`PROFILE_CHANGED_DURING_IMPORT`), and rolls itself back if it fails. A failed request-bound import rolls back that bootstrap only if the profile still holds what the bootstrap wrote, and keeps (and reports) newer state otherwise; if the rollback cannot run, the import's error is still the one reported. Other import forms keep a successful bootstrap when a later step fails, as before. A lock acquirer that finds its profile directory removed by a concurrent delete recreates it and retries within its deadline instead of failing.
- Updated dependencies [f25aa05]
  - @tinycloud/operations@0.3.4-beta.1

## 1.0.1-beta.0

### Patch Changes

- 6de6688: `tc share publish --to email:<address> --notify` now emails the invitation and exits 0 on tinycloud-node 1.17.2. Exact-email shares now sign their canonical recipient as the envelope's delivery address. Node 1.17.2 requires it before it authorizes an invitation (without it the node answers `403 delivery-authorization-invalid` and the CLI exits 9); 1.17.3 accepts it but no longer requires it. A mailbox the share envelope cannot carry as a delivery address (for example `a/b@example.com`) is published without one, as before, so on nodes before 1.17.3 it cannot be emailed. On those nodes, email shares published by earlier CLI versions cannot be emailed either; publish them again.

  `@tinycloud/share-envelope` exports `isEnvelopeDeliveryEmail`, the rule envelopes apply to `deliveryEmail`. `prepareAddressedShare` in `@tinycloud/share-sdk` now refuses a `deliveryEmail` that rule rejects before any side effect, instead of failing after upload and policy registration.

- Updated dependencies [6de6688]
  - @tinycloud/share-envelope@1.1.0-beta.0
  - @tinycloud/share-sdk@1.0.1-beta.0
  - @tinycloud/sdk-core@3.0.1-beta.0
  - @tinycloud/node-sdk@3.0.1-beta.0
  - @tinycloud/operations@0.3.4-beta.0

## 1.0.0

### Major Changes

- c690844: Complete the TC-498/TC-500 native-sharing beta cutover. The legacy
  broker-backed Share APIs, link/transport compatibility paths, and retired CLI
  Share flags are intentionally removed. Use owner-Node native bearer
  delegations or signed Policy/v3 addressed shares; this release does not retain
  a parallel legacy broker authority plane.
- b852650: Seal Policy/v3 recipient metadata as the canonical AES-256-GCM
  `version || nonce || ciphertext+tag` blob before constructing an addressed
  share link. Delivery authorization now binds that sealed blob and its
  fragment-only key, rather than accepting a plaintext `?tc2` envelope. Remove
  the public plaintext Policy/v3 inline URL codec; only sealed fragment links
  are accepted for addressed shares. Add the reusable app-neutral
  OpenCredentials invitation client and bind notification retries to the signed
  delivery JTI/nonce used by Node and OpenCredentials deduplication.

### Minor Changes

- 48eca36: TC-540: `tc auth login --device --manifest FILE [--expiry DUR] [--owner DID] [--replace-session]` and `tc auth request --manifest FILE --grant --device` request exactly a KV-scoped manifest's permissions through OpenKey device authorization (SQL stays on browser login). The signed SIWE ReCap is the authority: the CLI accepts an approval only when OpenKey's binding and relayed delegation state exactly the signed permissions, which must stay inside the request and match the session key, owner, origins and lifetime; `permissions`/`declined` are derived from the signed grant, and OpenKey `invalid_scope` surfaces as `SCOPE_REJECTED`. A profile that recorded an owner is pinned to it on scoped and device login (except local-owner-key profiles); device login refuses local-owner-key profiles (`LOCAL_OWNER_PROFILE`) and will not replace a live session with a different scope without `--replace-session` (`SESSION_IN_USE`). Device logins honor the profile's self-hosted `openkeyHost`, accept verification pages only on the OpenKey site, and name OpenKey when it is unreachable. Owner addresses compare case-insensitively (EIP-55 or lowercase) while chain id and space name compare exactly. `--device` requires `--manifest`; non-interactive `auth login` no longer switches to device mode or waits silently on a browser (`INTERACTIVE_LOGIN_REQUIRED`). The built-in `builtin:share-publishing` manifest requests only `tinycloud.capabilities/read` on `""` (OpenKey requires it to sign any delegation), KV get/put on `xyz.tinycloud.share/shares/` and get/metadata/put/list on `shares/`; `tc enable share` uses it.

  `--expiry` is enforced against the signed session on every login path; OpenKey `--expiry` takes durations only (ISO dates are refused up front, since OpenKey signs approval time plus a lifetime). Logins commit under the profile lock after re-reading profile, key and session: a change while approval was pending refuses with `PROFILE_CHANGED_DURING_LOGIN`, and a live session is replaced only by an approved scope that keeps all of it (`SESSION_IN_USE` otherwise, for scoped browser and device login alike). Every login keeps the profile's recorded owner and records only a signature-verified owner. Browser `--expiry` reaches OpenKey as seconds. Login commits and the `ProfileManager` profile, key and session writers take the profile lock, and read-modify-write updates hold it for the whole transaction. A failed commit write restores the pre-commit state, attempting every restore write; if restoring fails too, or interrupted state is found (including a session naming an owner the profile does not record), it surfaces as `PROFILE_STATE_INCONSISTENT`. A profile lock timeout reaching the CLI error handler is reported as `PROFILE_LOCK_TIMEOUT` with a retry hint. Signed ReCap caveats (including JSON `null` values, which the WASM verifier returns as `undefined`) are recorded with the session's permissions, and a renewal that adds a caveat to an action the live session holds unrestricted counts as narrowing (`SESSION_IN_USE`). An unscoped login whose callback carries no complete proof saves no SIWE or signature, so an unsigned expiry is never read back. Session authority fields (owner, permissions, expiry, signed-scope marker) are set only from verified proofs; `tc init` uses the same verified commit. `withProfileLock` in operations is reentrant only for the acquiring call chain and lock path while the acquisition lasts, takes the lock with an exclusive `mkdir` (the primitive older releases use) and holds it only once it has `link`ed a fully written owner record into it (`link` never replaces; EEXIST or ENOENT means not acquired, and the attempt retries), never renames anything onto the lock or its owner record, and reclaims an ownerless lock directory older than the stale threshold only by `rmdir`, so only while it is empty; claim files left by a process killed mid-recovery are removed first (never `owner.json`), and owner files a crashed acquirer staged are removed once aged. Dead-holder recovery claims the owner record with a hard link instead of moving it, so a recoverer acting on an outdated observation can no longer move a live holder's record away and restore it after that holder released (which left the lock blocked until the stale threshold); release removes its own verified record. Recovery is fenced: a recoverer that took longer than half the stale threshold between its claim and removing the dead holder's record, or a cleanup between its age check and removing claims, abandons that step (dropping only its own claim) and retries, so a recoverer paused while cleanup and a new holder moved on can never remove that holder's record. Port manifest-scoped first login (`auth login --manifest/--owner/--expiry` with signed-proof verification), the `tc context` command, and the packaged core `tc-cli` skill (SKILL, AUTH, REFERENCE, INSTALL, release.json) from the 0.10 line. The default host is now `https://tee.node.tinycloud.xyz` in the CLI, operations and MCP HTTP CLI; only an explicit `--host` is stored on a profile. Profile state is written 0600 in 0700 directories, and directories or grant history created by older releases are tightened on the next write.

  `tc share publish` authorization hints for OpenKey profiles now name `tc --profile <name> auth login --device --manifest builtin:share-publishing` (or `tc --profile <name> enable share`), and scope denials name the `builtin:share-publishing` scope; local-key profiles keep `auth login --method local`. The packaged `tc-cli` skill requires CLI `>=1.0.0-beta.17`, the first release with these commands. Device login validates that OpenKey's relay key is a P-256 point before deriving the relay secret. `tc auth request --grant --device` keeps signed ReCap caveats on the granted resources, in the stored delegation and in the reported grant, so a caveated grant is never replayed as unrestricted.

### Patch Changes

- aee2308: Add Share-first, end-to-end-encrypted OpenKey device authorization for first-time remote publishing, plus explicit `tc auth login --device` and `tc enable share` commands.
- 9cc11ca: Honor Share subcommands' `--json` flag when the root CLI also defines that option, restoring machine-readable success output for inspect, receive, and lifecycle commands.
- c690844: Reject addressed-share ciphertext whose exact owner-KV bytes do not match the
  signed source digest before key unwrap or rendering. Revoke addressed shares
  through the existing signed Policy/v3 root-revocation path, which cuts off
  active sessions as well as fresh admission and delivery.
- d8b122e: Bind restored-session share publication to the signed owner space, compare EIP-155 owner addresses without case sensitivity, classify authority failures, and constrain implicit share expiry to session lifetime.
- d8b122e: Preserve actionable sharing and KV authorization diagnostics while keeping CLI output safe and session expiry guidance prioritized.
- d8b122e: Restore backwards-compatible auth codes and preserve typed session and authorization diagnostics across SDK boundaries.
- d8b122e: Harden share publication expiry clamping and map restored-session and authorization failures to typed, safe errors.
- d8b122e: Resolve Share publication's owner space from restored OpenKey sessions while retaining the configured Share-origin binding.
- a132b77: `tc share publish` refuses a session whose authority for an anyone-with-link share carries signed restrictions (caveats) before storing anything, so a refused publish no longer leaves an orphaned file. It exits 5 with `PERMISSION_DENIED` and says to approve Share publishing without restrictions on a new, dedicated profile (`tc init --name publisher --key-only && tc --profile publisher enable share`). A caveat only on authority the link does not use (such as `tinycloud.capabilities/read` or the addressed `shares/` prefix) does not block publishing, and a session that lacks the link's authority altogether is also refused with `PERMISSION_DENIED` before upload. Addressed (`--to`) shares and signer-backed local-key profiles are unchanged.

  `SharingService.preflightGenerate({ path, actions, expiry })` reports, without side effects, whether the session's own authority can issue the delegation `generate` would create: `"ok"`, `"caveated"` (only caveated entries cover it) or `"not-covered"`. It does not consult `onRootDelegationNeeded`.

- 2e9db6e: Owner-only (email-addressed) Share links published by the CLI now open in the Share viewer, and CLI `--to domain:` shares now work. The CLI commits the recipient's mailbox credential in the policy (Policy/v2) and publishes the owner's node location record before publishing.
  - `publishAddressedShare` refuses an exact-email share without a credential requirement bound to the address. Previously such a share was signed as Policy/v1, which no receiver accepts.
  - The new `addressedCredentialRequirement(target)` builds the commitment for email and email-domain targets.
  - The new `prepareAddressedShare(request)` runs every target, recipient, filename and action check, with no side effects. The CLI calls it before publishing the location record or uploading, so a refused share (for example `--to domain:… --action edit`) leaves nothing behind.
  - `notifyShare` matches, keys and delivers on the canonical mailbox, so `tc share publish --to email:Foo@x.com --notify` and `tc share notify --to Foo@x.com` invite `foo@x.com`. The CLI canonicalizes `--to` mailboxes and domains up front, and an invalid one reports the specific reason.
  - A location registry outage during `tc share publish` (network error, 5xx, 408 or 429) reports `UNAVAILABLE` (exit 4) with a retry hint. A registry rejection (any other 4xx, or an invalid record) reports `REGISTRY_REJECTED` (exit 6) and says that retrying will not help. sdk-core throws the new `LocationRegistryHttpError`, which carries the HTTP `status`, for registry HTTP failures; the message text is unchanged.
  - `canonicalMailbox`, `canonicalEmailDomain`, `isCanonicalEmailDomain` and `mailboxBelongsToDomain` now live in `@tinycloud/share-envelope`. `@tinycloud/sdk-core` re-exports them unchanged.

- c79f5f4: TC-575: Report OpenKey device sign-in rate limits as `DEVICE_AUTH_RATE_LIMITED` with a wait hint and any `Retry-After` window.
- b3db51a: `tc share publish` no longer fails with `PERMISSION_DENIED` when a filename contains spaces. A name that has characters other than `A-Z a-z 0-9 . _ -`, starts with anything but a letter or digit, contains `..`, or is longer than 128 characters is stored under a readable URI-safe name (`Edge test (A).md` is stored as `Edge-test-A.md`). It keeps its extension when that is 1-16 ASCII letters or digits; a leading dot is dropped (`.env` becomes `share.env`), and a name without such an extension never gains one. Anyone-with-link pages and `tc share receive` show the stored name; addressed shares keep the original display filename. A full storage quota reports `STORAGE_QUOTA_EXCEEDED`, with used and limit sizes when the node includes them, and other upload failures report `UPLOAD_FAILED`, never server text. `tc kv get`, `put`, `head`, `delete` and `list --prefix` refuse keys with spaces or control characters (`USAGE_ERROR`) before authenticating, because the SDK sends keys unescaped in the node resource URI, and `tc kv put` reports a full quota as `STORAGE_QUOTA_EXCEEDED` (exit 1). Permission errors advise checking the existing scope before requesting it again.
- bf6fbd1: Share publication now applies the share viewer's filename policy: names are NFC-normalized, and control, format (such as U+200B zero-width space and U+202E bidi override), surrogate, and U+2028/U+2029 code points are refused before any content is read or uploaded. share-sdk exports `canonicalShareFilename` and `hasUnsafeFilenameCodePoint`, and `publishTargetShare` reports "filename contains control or invisible characters". `tc share publish` refuses every such filename with `UNSAFE_FILENAME` (exit 8), and addressed shares display the NFC-normalized name.
- 877097d: TC-599: Scoped OpenKey login can grant an agent read access to named secrets, and the secrets commands are safe to run headless.
  - `auth login --manifest` keeps raw `tinycloud.encryption` network entries in the `encryption` pseudo-space (never in the manifest's space), so the Secret Manager `secrets: { NAME: true }` shape passes first-login validation; the decrypt network uses the EIP-55-checksummed recorded owner or `--owner` (`OWNER_DID_UNKNOWN` otherwise), never the session `did:key`.
  - Every scoped login (browser, paste, device) requests `tinycloud.capabilities/read` on the space root when the manifest lacks it. A signed decrypt nested inside the owner's space is not raw authority: it is reported in `declined`, omitted from saved permissions so a later valid raw renewal is not blocked, and accompanied by an old-OpenKey warning. Foreign-owner decrypt grants are refused; device login refuses encryption and secrets-space manifests up front.
  - Browser `auth request --grant` and secret-read permission escalation verify the owner's signed OpenKey proof against the profile session key, requested space, scope and expiry. Only signed effective permissions are activated and persisted; old nested decrypt, foreign-owner, broadened or missing proof is refused before storage, and activation failure leaves local grants unchanged.
  - `auth login --paste` accepts a final code line without a newline and fails with `PASTE_CODE_MISSING` (exit 3, naming the approval URL) when stdin ends without a code.
  - `secrets get -o FILE` validates the destination and its existing directory before fetching secret bytes, syncs a new 0600 inode, and atomically replaces the destination. A best-effort parent-directory sync follows replacement without turning a completed write into an error. Symlinks, non-regular destinations, and absent parents are refused without unsafe fallback; filesystem output failures identify the destination without leaking the temporary filename.
  - With no TTY on stdin or stderr, `secrets get|list|put|delete` on an OpenKey profile lacking the grant fails with `PERMISSION_DENIED` (exit 5) and a scoped paste-login hint. A missing or real signed expired session fails with `AUTH_REQUIRED` (exit 3) before the canonical get operation or an unscoped browser refresh. Redirecting stdout alone still permits owner approval through stderr and terminal stdin.
  - node-sdk: a decrypt refused with HTTP 401/403 is reported as missing decrypt authority on the invoked network, never on a response-supplied resource or action.
  - node-sdk keeps an owner's space-nested encryption ReCap distinct from a raw network grant when restoring sessions, checking runtime permissions, and deriving further delegations.

- 08f5bad: Route hosted Share device authorization through the canonical OpenKey API origin while preserving the browser approval origin and explicit self-hosted overrides.
- Updated dependencies [46c83a7]
- Updated dependencies [036ce34]
- Updated dependencies [ce34dc1]
- Updated dependencies [4b60562]
- Updated dependencies [b0069f7]
- Updated dependencies [dc92402]
- Updated dependencies [cc27c3a]
- Updated dependencies [657c1ff]
- Updated dependencies [12e5c4d]
- Updated dependencies [c690844]
- Updated dependencies [c690844]
- Updated dependencies [31043b5]
- Updated dependencies [b852650]
- Updated dependencies [026bf15]
- Updated dependencies [70e6c95]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [48eca36]
- Updated dependencies [48eca36]
- Updated dependencies [a132b77]
- Updated dependencies [2e9db6e]
- Updated dependencies [bf6fbd1]
- Updated dependencies [877097d]
  - @tinycloud/sdk-core@3.0.0
  - @tinycloud/node-sdk@3.0.0
  - @tinycloud/share-sdk@1.0.0
  - @tinycloud/share-envelope@1.0.0
  - @tinycloud/operations@0.3.3

## 1.0.0-beta.23

### Patch Changes

- 877097d: TC-599: Scoped OpenKey login can grant an agent read access to named secrets, and the secrets commands are safe to run headless.
  - `auth login --manifest` keeps raw `tinycloud.encryption` network entries in the `encryption` pseudo-space (never in the manifest's space), so the Secret Manager `secrets: { NAME: true }` shape passes first-login validation; the decrypt network uses the EIP-55-checksummed recorded owner or `--owner` (`OWNER_DID_UNKNOWN` otherwise), never the session `did:key`.
  - Every scoped login (browser, paste, device) requests `tinycloud.capabilities/read` on the space root when the manifest lacks it. A signed decrypt nested inside the owner's space is not raw authority: it is reported in `declined`, omitted from saved permissions so a later valid raw renewal is not blocked, and accompanied by an old-OpenKey warning. Foreign-owner decrypt grants are refused; device login refuses encryption and secrets-space manifests up front.
  - Browser `auth request --grant` and secret-read permission escalation verify the owner's signed OpenKey proof against the profile session key, requested space, scope and expiry. Only signed effective permissions are activated and persisted; old nested decrypt, foreign-owner, broadened or missing proof is refused before storage, and activation failure leaves local grants unchanged.
  - `auth login --paste` accepts a final code line without a newline and fails with `PASTE_CODE_MISSING` (exit 3, naming the approval URL) when stdin ends without a code.
  - `secrets get -o FILE` validates the destination and its existing directory before fetching secret bytes, syncs a new 0600 inode, and atomically replaces the destination. A best-effort parent-directory sync follows replacement without turning a completed write into an error. Symlinks, non-regular destinations, and absent parents are refused without unsafe fallback; filesystem output failures identify the destination without leaking the temporary filename.
  - With no TTY on stdin or stderr, `secrets get|list|put|delete` on an OpenKey profile lacking the grant fails with `PERMISSION_DENIED` (exit 5) and a scoped paste-login hint. A missing or real signed expired session fails with `AUTH_REQUIRED` (exit 3) before the canonical get operation or an unscoped browser refresh. Redirecting stdout alone still permits owner approval through stderr and terminal stdin.
  - node-sdk: a decrypt refused with HTTP 401/403 is reported as missing decrypt authority on the invoked network, never on a response-supplied resource or action.
  - node-sdk keeps an owner's space-nested encryption ReCap distinct from a raw network grant when restoring sessions, checking runtime permissions, and deriving further delegations.

- Updated dependencies [877097d]
  - @tinycloud/node-sdk@3.0.0-beta.20
  - @tinycloud/operations@0.3.3-beta.18

## 1.0.0-beta.22

### Patch Changes

- Updated dependencies [70e6c95]
  - @tinycloud/sdk-core@3.0.0-beta.19
  - @tinycloud/node-sdk@3.0.0-beta.19
  - @tinycloud/share-sdk@1.0.0-beta.9
  - @tinycloud/operations@0.3.3-beta.17

## 1.0.0-beta.21

### Patch Changes

- a132b77: `tc share publish` refuses a session whose authority for an anyone-with-link share carries signed restrictions (caveats) before storing anything, so a refused publish no longer leaves an orphaned file. It exits 5 with `PERMISSION_DENIED` and says to approve Share publishing without restrictions on a new, dedicated profile (`tc init --name publisher --key-only && tc --profile publisher enable share`). A caveat only on authority the link does not use (such as `tinycloud.capabilities/read` or the addressed `shares/` prefix) does not block publishing, and a session that lacks the link's authority altogether is also refused with `PERMISSION_DENIED` before upload. Addressed (`--to`) shares and signer-backed local-key profiles are unchanged.

  `SharingService.preflightGenerate({ path, actions, expiry })` reports, without side effects, whether the session's own authority can issue the delegation `generate` would create: `"ok"`, `"caveated"` (only caveated entries cover it) or `"not-covered"`. It does not consult `onRootDelegationNeeded`.

- Updated dependencies [a132b77]
  - @tinycloud/sdk-core@3.0.0-beta.18
  - @tinycloud/node-sdk@3.0.0-beta.18
  - @tinycloud/operations@0.3.3-beta.16

## 1.0.0-beta.20

### Patch Changes

- bf6fbd1: Share publication now applies the share viewer's filename policy: names are NFC-normalized, and control, format (such as U+200B zero-width space and U+202E bidi override), surrogate, and U+2028/U+2029 code points are refused before any content is read or uploaded. share-sdk exports `canonicalShareFilename` and `hasUnsafeFilenameCodePoint`, and `publishTargetShare` reports "filename contains control or invisible characters". `tc share publish` refuses every such filename with `UNSAFE_FILENAME` (exit 8), and addressed shares display the NFC-normalized name.
- Updated dependencies [bf6fbd1]
  - @tinycloud/share-sdk@1.0.0-beta.8
  - @tinycloud/sdk-core@3.0.0-beta.17
  - @tinycloud/node-sdk@3.0.0-beta.17
  - @tinycloud/operations@0.3.3-beta.15

## 1.0.0-beta.19

### Patch Changes

- c79f5f4: TC-575: Report OpenKey device sign-in rate limits as `DEVICE_AUTH_RATE_LIMITED` with a wait hint and any `Retry-After` window.

## 1.0.0-beta.18

### Patch Changes

- b3db51a: `tc share publish` no longer fails with `PERMISSION_DENIED` when a filename contains spaces. A name that has characters other than `A-Z a-z 0-9 . _ -`, starts with anything but a letter or digit, contains `..`, or is longer than 128 characters is stored under a readable URI-safe name (`Edge test (A).md` is stored as `Edge-test-A.md`). It keeps its extension when that is 1-16 ASCII letters or digits; a leading dot is dropped (`.env` becomes `share.env`), and a name without such an extension never gains one. Anyone-with-link pages and `tc share receive` show the stored name; addressed shares keep the original display filename. A full storage quota reports `STORAGE_QUOTA_EXCEEDED`, with used and limit sizes when the node includes them, and other upload failures report `UPLOAD_FAILED`, never server text. `tc kv get`, `put`, `head`, `delete` and `list --prefix` refuse keys with spaces or control characters (`USAGE_ERROR`) before authenticating, because the SDK sends keys unescaped in the node resource URI, and `tc kv put` reports a full quota as `STORAGE_QUOTA_EXCEEDED` (exit 1). Permission errors advise checking the existing scope before requesting it again.

## 1.0.0-beta.17

### Minor Changes

- 48eca36: TC-540: `tc auth login --device --manifest FILE [--expiry DUR] [--owner DID] [--replace-session]` and `tc auth request --manifest FILE --grant --device` request exactly a KV-scoped manifest's permissions through OpenKey device authorization (SQL stays on browser login). The signed SIWE ReCap is the authority: the CLI accepts an approval only when OpenKey's binding and relayed delegation state exactly the signed permissions, which must stay inside the request and match the session key, owner, origins and lifetime; `permissions`/`declined` are derived from the signed grant, and OpenKey `invalid_scope` surfaces as `SCOPE_REJECTED`. A profile that recorded an owner is pinned to it on scoped and device login (except local-owner-key profiles); device login refuses local-owner-key profiles (`LOCAL_OWNER_PROFILE`) and will not replace a live session with a different scope without `--replace-session` (`SESSION_IN_USE`). Device logins honor the profile's self-hosted `openkeyHost`, accept verification pages only on the OpenKey site, and name OpenKey when it is unreachable. Owner addresses compare case-insensitively (EIP-55 or lowercase) while chain id and space name compare exactly. `--device` requires `--manifest`; non-interactive `auth login` no longer switches to device mode or waits silently on a browser (`INTERACTIVE_LOGIN_REQUIRED`). The built-in `builtin:share-publishing` manifest requests only `tinycloud.capabilities/read` on `""` (OpenKey requires it to sign any delegation), KV get/put on `xyz.tinycloud.share/shares/` and get/metadata/put/list on `shares/`; `tc enable share` uses it.

  `--expiry` is enforced against the signed session on every login path; OpenKey `--expiry` takes durations only (ISO dates are refused up front, since OpenKey signs approval time plus a lifetime). Logins commit under the profile lock after re-reading profile, key and session: a change while approval was pending refuses with `PROFILE_CHANGED_DURING_LOGIN`, and a live session is replaced only by an approved scope that keeps all of it (`SESSION_IN_USE` otherwise, for scoped browser and device login alike). Every login keeps the profile's recorded owner and records only a signature-verified owner. Browser `--expiry` reaches OpenKey as seconds. Login commits and the `ProfileManager` profile, key and session writers take the profile lock, and read-modify-write updates hold it for the whole transaction. A failed commit write restores the pre-commit state, attempting every restore write; if restoring fails too, or interrupted state is found (including a session naming an owner the profile does not record), it surfaces as `PROFILE_STATE_INCONSISTENT`. A profile lock timeout reaching the CLI error handler is reported as `PROFILE_LOCK_TIMEOUT` with a retry hint. Signed ReCap caveats (including JSON `null` values, which the WASM verifier returns as `undefined`) are recorded with the session's permissions, and a renewal that adds a caveat to an action the live session holds unrestricted counts as narrowing (`SESSION_IN_USE`). An unscoped login whose callback carries no complete proof saves no SIWE or signature, so an unsigned expiry is never read back. Session authority fields (owner, permissions, expiry, signed-scope marker) are set only from verified proofs; `tc init` uses the same verified commit. `withProfileLock` in operations is reentrant only for the acquiring call chain and lock path while the acquisition lasts, takes the lock with an exclusive `mkdir` (the primitive older releases use) and holds it only once it has `link`ed a fully written owner record into it (`link` never replaces; EEXIST or ENOENT means not acquired, and the attempt retries), never renames anything onto the lock or its owner record, and reclaims an ownerless lock directory older than the stale threshold only by `rmdir`, so only while it is empty; claim files left by a process killed mid-recovery are removed first (never `owner.json`), and owner files a crashed acquirer staged are removed once aged. Dead-holder recovery claims the owner record with a hard link instead of moving it, so a recoverer acting on an outdated observation can no longer move a live holder's record away and restore it after that holder released (which left the lock blocked until the stale threshold); release removes its own verified record. Recovery is fenced: a recoverer that took longer than half the stale threshold between its claim and removing the dead holder's record, or a cleanup between its age check and removing claims, abandons that step (dropping only its own claim) and retries, so a recoverer paused while cleanup and a new holder moved on can never remove that holder's record. Port manifest-scoped first login (`auth login --manifest/--owner/--expiry` with signed-proof verification), the `tc context` command, and the packaged core `tc-cli` skill (SKILL, AUTH, REFERENCE, INSTALL, release.json) from the 0.10 line. The default host is now `https://tee.node.tinycloud.xyz` in the CLI, operations and MCP HTTP CLI; only an explicit `--host` is stored on a profile. Profile state is written 0600 in 0700 directories, and directories or grant history created by older releases are tightened on the next write.

  `tc share publish` authorization hints for OpenKey profiles now name `tc --profile <name> auth login --device --manifest builtin:share-publishing` (or `tc --profile <name> enable share`), and scope denials name the `builtin:share-publishing` scope; local-key profiles keep `auth login --method local`. The packaged `tc-cli` skill requires CLI `>=1.0.0-beta.17`, the first release with these commands. Device login validates that OpenKey's relay key is a P-256 point before deriving the relay secret. `tc auth request --grant --device` keeps signed ReCap caveats on the granted resources, in the stored delegation and in the reported grant, so a caveated grant is never replayed as unrestricted.

### Patch Changes

- Updated dependencies [48eca36]
- Updated dependencies [48eca36]
  - @tinycloud/operations@0.3.3-beta.14
  - @tinycloud/node-sdk@3.0.0-beta.16

## 1.0.0-beta.16

### Patch Changes

- 2e9db6e: Owner-only (email-addressed) Share links published by the CLI now open in the Share viewer, and CLI `--to domain:` shares now work. The CLI commits the recipient's mailbox credential in the policy (Policy/v2) and publishes the owner's node location record before publishing.
  - `publishAddressedShare` refuses an exact-email share without a credential requirement bound to the address. Previously such a share was signed as Policy/v1, which no receiver accepts.
  - The new `addressedCredentialRequirement(target)` builds the commitment for email and email-domain targets.
  - The new `prepareAddressedShare(request)` runs every target, recipient, filename and action check, with no side effects. The CLI calls it before publishing the location record or uploading, so a refused share (for example `--to domain:… --action edit`) leaves nothing behind.
  - `notifyShare` matches, keys and delivers on the canonical mailbox, so `tc share publish --to email:Foo@x.com --notify` and `tc share notify --to Foo@x.com` invite `foo@x.com`. The CLI canonicalizes `--to` mailboxes and domains up front, and an invalid one reports the specific reason.
  - A location registry outage during `tc share publish` (network error, 5xx, 408 or 429) reports `UNAVAILABLE` (exit 4) with a retry hint. A registry rejection (any other 4xx, or an invalid record) reports `REGISTRY_REJECTED` (exit 6) and says that retrying will not help. sdk-core throws the new `LocationRegistryHttpError`, which carries the HTTP `status`, for registry HTTP failures; the message text is unchanged.
  - `canonicalMailbox`, `canonicalEmailDomain`, `isCanonicalEmailDomain` and `mailboxBelongsToDomain` now live in `@tinycloud/share-envelope`. `@tinycloud/sdk-core` re-exports them unchanged.

- Updated dependencies [2e9db6e]
  - @tinycloud/share-envelope@1.0.0-beta.5
  - @tinycloud/share-sdk@1.0.0-beta.7
  - @tinycloud/sdk-core@3.0.0-beta.15
  - @tinycloud/node-sdk@3.0.0-beta.15
  - @tinycloud/operations@0.3.3-beta.13

## 1.0.0-beta.15

### Patch Changes

- d8b122e: Bind restored-session share publication to the signed owner space, compare EIP-155 owner addresses without case sensitivity, classify authority failures, and constrain implicit share expiry to session lifetime.
- d8b122e: Preserve actionable sharing and KV authorization diagnostics while keeping CLI output safe and session expiry guidance prioritized.
- d8b122e: Restore backwards-compatible auth codes and preserve typed session and authorization diagnostics across SDK boundaries.
- d8b122e: Harden share publication expiry clamping and map restored-session and authorization failures to typed, safe errors.
- d8b122e: Resolve Share publication's owner space from restored OpenKey sessions while retaining the configured Share-origin binding.
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
- Updated dependencies [d8b122e]
  - @tinycloud/node-sdk@3.0.0-beta.14
  - @tinycloud/share-sdk@1.0.0-beta.6
  - @tinycloud/operations@0.3.3-beta.12

## 1.0.0-beta.14

### Patch Changes

- Updated dependencies [036ce34]
  - @tinycloud/node-sdk@3.0.0-beta.13
  - @tinycloud/operations@0.3.3-beta.11

## 1.0.0-beta.13

### Patch Changes

- Updated dependencies [cc27c3a]
  - @tinycloud/share-sdk@1.0.0-beta.5
  - @tinycloud/node-sdk@3.0.0-beta.12
  - @tinycloud/operations@0.3.3-beta.10

## 1.0.0-beta.12

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.11
- @tinycloud/operations@0.3.3-beta.9

## 1.0.0-beta.11

### Major Changes

- b852650: Seal Policy/v3 recipient metadata as the canonical AES-256-GCM
  `version || nonce || ciphertext+tag` blob before constructing an addressed
  share link. Delivery authorization now binds that sealed blob and its
  fragment-only key, rather than accepting a plaintext `?tc2` envelope. Remove
  the public plaintext Policy/v3 inline URL codec; only sealed fragment links
  are accepted for addressed shares. Add the reusable app-neutral
  OpenCredentials invitation client and bind notification retries to the signed
  delivery JTI/nonce used by Node and OpenCredentials deduplication.

### Patch Changes

- Updated dependencies [b852650]
  - @tinycloud/share-envelope@1.0.0-beta.4
  - @tinycloud/share-sdk@1.0.0-beta.4
  - @tinycloud/node-sdk@3.0.0-beta.10
  - @tinycloud/operations@0.3.3-beta.8

## 1.0.0-beta.10

### Major Changes

- c690844: Complete the TC-498/TC-500 native-sharing beta cutover. The legacy
  broker-backed Share APIs, link/transport compatibility paths, and retired CLI
  Share flags are intentionally removed. Use owner-Node native bearer
  delegations or signed Policy/v3 addressed shares; this release does not retain
  a parallel legacy broker authority plane.

### Patch Changes

- c690844: Reject addressed-share ciphertext whose exact owner-KV bytes do not match the
  signed source digest before key unwrap or rendering. Revoke addressed shares
  through the existing signed Policy/v3 root-revocation path, which cuts off
  active sessions as well as fresh admission and delivery.
- Updated dependencies [c690844]
- Updated dependencies [c690844]
  - @tinycloud/share-envelope@1.0.0-beta.3
  - @tinycloud/share-sdk@1.0.0-beta.3
  - @tinycloud/node-sdk@3.0.0-beta.9
  - @tinycloud/operations@0.3.3-beta.7

## 0.9.1-beta.9

### Patch Changes

- Updated dependencies [46c83a7]
  - @tinycloud/node-sdk@3.0.0-beta.8
  - @tinycloud/operations@0.3.3-beta.6

## 0.9.1-beta.8

### Patch Changes

- Updated dependencies [026bf15]
  - @tinycloud/share-sdk@0.3.0-beta.2
  - @tinycloud/share-envelope@0.2.1-beta.2
  - @tinycloud/node-sdk@3.0.0-beta.7
  - @tinycloud/operations@0.3.3-beta.5

## 0.9.1-beta.7

### Patch Changes

- 08f5bad: Route hosted Share device authorization through the canonical OpenKey API origin while preserving the browser approval origin and explicit self-hosted overrides.

## 0.9.1-beta.6

### Patch Changes

- aee2308: Add Share-first, end-to-end-encrypted OpenKey device authorization for first-time remote publishing, plus explicit `tc auth login --device` and `tc enable share` commands.

## 0.9.1-beta.5

### Patch Changes

- 9cc11ca: Honor Share subcommands' `--json` flag when the root CLI also defines that option, restoring machine-readable success output for inspect, receive, and lifecycle commands.

## 0.9.1-beta.4

### Patch Changes

- Updated dependencies [31043b5]
  - @tinycloud/node-sdk@3.0.0-beta.6
  - @tinycloud/operations@0.3.3-beta.4

## 0.9.1-beta.3

### Patch Changes

- Updated dependencies [dc92402]
  - @tinycloud/share-envelope@0.2.1-beta.1
  - @tinycloud/share-sdk@0.3.0-beta.1
  - @tinycloud/node-sdk@3.0.0-beta.5
  - @tinycloud/operations@0.3.3-beta.3

## 0.9.1-beta.2

### Patch Changes

- Updated dependencies [b0069f7]
  - @tinycloud/share-sdk@0.3.0-beta.0
  - @tinycloud/share-envelope@0.2.1-beta.0
  - @tinycloud/node-sdk@3.0.0-beta.2
  - @tinycloud/operations@0.3.3-beta.2

## 0.9.1-beta.1

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.1
- @tinycloud/operations@0.3.3-beta.1

## 0.9.1-beta.0

### Patch Changes

- @tinycloud/node-sdk@3.0.0-beta.0
- @tinycloud/operations@0.3.3-beta.0

## 0.9.0

### Minor Changes

- b38dd12: Add versioned OpenKey authorization protocol (v1) types and consumer wiring.
  - `sdk-core` exports `TinyCloudAuthorizationRequestV1`, `TinyCloudAuthorizationResultV1`, `CapabilityPresentationEnvelopeV1`, `validateAuthorizationResultV1`, `isPlausibleOpenKeyActionId`, `OPENKEY_ACTION_ID_SEPARATOR`.
  - `sdk-core` also exports narrowing-verification helpers `extractImmutableSiweFields`, `diffImmutableSiweFields`, `extractRecapAttenuations`, `unauthorizedRecapCapabilities` (with `ImmutableSiweFields` and `RecapAttenuation` types) so consumers can prove that a widget-signed SIWE is a strict narrowing of the SDK's original prepared SIWE.
  - `node-sdk` adds `NodeUserAuthorization.signInWithOpenKeyResult()` which completes the session with the exact `signedMessage` the OpenKey widget returned (not the caller's original prepared SIWE). Its `prepared` argument now REQUIRES `siwe` (the SDK-generated reference SIWE). Validates that the signature verifies against the returned bytes, that the recovered signer matches the local signer, that every immutable SIWE header field (domain, address, URI, version, chainId, nonce, issuedAt) is preserved byte-for-byte, that the ReCap capability set is a subset of the original request, and that `selectedActionKeys` are covered by that set. Note: `statement` handling was refined in `sol-final-continuation-fixes.md` — earlier drafts of this changeset incorrectly implied statement drift was always allowed; the delivered rule is that statement is byte-immutable for plain SIWEs and validated via the ReCap subset check for ReCap-bearing SIWEs.
  - `cli` browser-auth advertises `protocolVersion=1` on the /delegate URL, validates every callback payload before persisting (including structural checks on the optional `permissions[]` array), and (when the response includes effective `permissions`) refuses any grant that broadens the requested set.
  - `sdk-core.unauthorizedRecapCapabilities` now enforces EXACT MULTISET EQUALITY on the caveat list for every surviving (resource, ability) pair. Removing an entire ability or resource from the child is still permitted (that is genuine narrowing), but for any (resource, ability) that survives, the child's caveat list must equal the parent's caveat list as a multiset — i.e. same set of canonicalized caveat objects with the SAME duplicate counts. Concretely: (a) adding a caveat not present in the parent is rejected, (b) removing an alternative from a non-empty parent caveat list is rejected (removing all caveats to broaden from "restricted" to "unrestricted" is the special case of this), (c) replacing a caveat with a different one is rejected, (d) changing the number of times a duplicated caveat appears is rejected, and (e) the empty-parent case requires the child to also be empty on that ability (both sides carry zero caveats — neither imposes a restriction). Order within a caveat object's own keys is normalized via canonical JSON serialization before counting, so key reordering inside a single caveat is not itself a difference; only differences in the multiset of caveat objects matter.
  - `node-sdk.signInWithOpenKeyResult` now enforces stricter selectedActionKeys/permissions consistency: `selectedActionKeys` must cover every non-required capability in `signedMessage`; every returned `permissions` entry action must appear in `signedMessage`; broader `permissions` entries are rejected; empty `permissions[]` with a capability-bearing SIWE is rejected; duplicate `selectedActionKeys` entries are rejected; and the resource-substring fallback used to resolve permission entries has been replaced with a canonical two-form resolver (space or space+path) that fails on ambiguity.
  - `node-sdk` adds `NodeUserAuthorization.signInWithOpenKey(authorizeFn, opts)` — the production entry point that wires `prepareSessionForSigning` → OpenKey `authorizeTinyCloud()` → `signInWithOpenKeyResult` into one call. Callers provide a thin `authorizeFn` bridge to the OpenKey SDK; the node-sdk enforces every subset/immutable-field invariant before creating any session state.
  - `cli.parseDelegationExpiryField` numeric-seconds test fixture corrected (was passing `4_071_849_600` = Jan 11 2099, but expected Jan 1 2099 = `4_070_908_800`).
  - `node-sdk.signInWithOpenKeyResult` REJECTS legacy two-part `resource\0action` selectedActionKeys — Sol continuation contract requires the CANONICAL four-part `service\0space\0path\0ability` shape. The prior suffix-match fallback silently accepted IDs that did not carry a validated service namespace; four-part canonical IDs are the only accepted format.
  - `node-sdk` adds `wireOpenKeyAuthorize(openkey)` — a production adapter that translates any structurally-OpenKey object (typically `@openkey/sdk`'s `OpenKey` instance) into the `authorizeFn` callback `signInWithOpenKey` expects. The bridge does not fabricate protocol fields — every value flows through unchanged, and wire drift (missing `signedMessage`, unsupported `protocolVersion`, malformed selection) throws at the boundary. Enables real production consumers to wire OpenKey into `NodeUserAuthorization` without either package taking a direct build dependency on the other.

- 2a77ebc: Add bounded Markdown bearer publishing plus stdin-safe Share inspect and receive commands backed by the canonical headless SDK.
- 4ce36a6: Add typed recipient-DID/device authorization, exact-email and domain policy publication/claim resume seams, idempotent notification outcomes, encrypted sender history views, target-aware revocation, and explicit read-only tc1 migration helpers to the canonical Share SDK and CLI.

### Patch Changes

- 746cb02: Stop implicitly probing `127.0.0.1` during TinyCloud host discovery. Loopback
  discovery now requires an explicit `localNodeUrl`, while configured and
  registry-discovered `*.local.tinycloud.link` nodes continue to work.
- 44ecf56: Release the exact-head session invocation APIs and canonical recipient-DID policy support used by Share.
- 17d5662: Pin addressed verification to an injected signer trust root, require detached node proof verification for authorized content, and keep Share command authority seams explicit and redacted.
- 705685e: Keep Share machine output redacted, make unavailable addressed revocation fail
  non-zero, and route browser consumers through the compiled receive contract.
- 07e3c85: Add an explicit read-only `share migrate` bridge for `tc1:` links and expose
  authenticated Share upload adapters to the modern CLI publisher.
- d4ec80a: Harden addressed Share content verification, restore CLI command dispatch and
  nonce-bound production upload authorization, and close filesystem and lifecycle
  edge cases in the Share command surface.
- 1103359: Route addressed Share verification through the canonical SDK, keep Node uploads fail-closed without explicit authority, and make the Share/help CLI entry independent of optional WASM authentication modules.
- e525137: Address Sol continuation-review rejection blockers on the OpenKey
  authorization consolidation.
  - `sdk-core.ImmutableSiweFields` now covers the full immutable header set:
    `expirationTime`, `notBefore`, `requestId`, `statement`, and
    `nonRecapResources`. `extractImmutableSiweFields` parses them and
    `diffImmutableSiweFields` includes them so a widget swapping any
    of these fields fails the SDK's byte-for-byte immutable check.
  - `sdk-core.unauthorizedRecapCapabilities` now enforces STRICT normalized
    caveat-multiset equality. Dropping alternatives from a disjunction,
    adding restrictions to an unrestricted parent, and any lexical caveat
    change all reject. Formal attenuation may relax this later.
  - `node-sdk.signInWithOpenKeyResult` requires the returned `permissions`
    array to equal the signed authority for EVERY resource/action pair,
    including structurally-required capabilities (e.g.
    `tinycloud.capabilities/read`). Missing entries and extras both fail
    hard (was: only non-required coverage was required).
  - `node-sdk.signInWithOpenKey` accepts an optional `openkeyKeyId` option
    and forwards it to the `authorizeFn` bridge so callers can pin the
    OpenKey key ID used by the widget.
  - `cli.auth request --grant` reports EFFECTIVE grants (from the signed
    delegation) rather than the originally-requested set — the previous
    behaviour over-reported authority when the user narrowed the request
    in the OpenKey UI. Applies to both OpenKey-backed and local-key flows.
  - `node-sdk` production TypeScript build no longer includes test sources
    or test-support modules, so `tsc --noEmit -p packages/node-sdk/tsconfig.json`
    now exits 0.
  - `node-sdk.signInWithOpenKey` resolves the actual TinyCloud activation host
    before preparing or sending the OpenKey authorization request. A per-call
    host override is installed as the session host, so the host bound into the
    OpenKey context and the host later used for activation cannot diverge.

- Updated dependencies [746cb02]
- Updated dependencies [d1d675b]
- Updated dependencies [44ecf56]
- Updated dependencies [b38dd12]
- Updated dependencies [68faad4]
- Updated dependencies [17d5662]
- Updated dependencies [2a77ebc]
- Updated dependencies [705685e]
- Updated dependencies [d4ec80a]
- Updated dependencies [1103359]
- Updated dependencies [9fd8752]
- Updated dependencies [4ce36a6]
- Updated dependencies [cc75957]
- Updated dependencies [a7e3668]
- Updated dependencies [e525137]
- Updated dependencies [ba9c983]
- Updated dependencies [f0842d8]
- Updated dependencies [d894c57]
- Updated dependencies [7805213]
  - @tinycloud/node-sdk@2.11.0
  - @tinycloud/operations@0.3.2
  - @tinycloud/node-sdk-wasm@1.7.6
  - @tinycloud/share-sdk@0.2.0
  - @tinycloud/share-envelope@0.2.0

## 0.9.0-beta.11

### Patch Changes

- Updated dependencies [7805213]
  - @tinycloud/share-envelope@0.2.0-beta.1
  - @tinycloud/share-sdk@0.2.0-beta.2
  - @tinycloud/node-sdk@2.11.0-beta.12
  - @tinycloud/operations@0.3.2-beta.11

## 0.9.0-beta.10

### Patch Changes

- Updated dependencies [d894c57]
  - @tinycloud/node-sdk@2.11.0-beta.11
  - @tinycloud/operations@0.3.2-beta.10

## 0.9.0-beta.9

### Minor Changes

- b38dd12: Add versioned OpenKey authorization protocol (v1) types and consumer wiring.
  - `sdk-core` exports `TinyCloudAuthorizationRequestV1`, `TinyCloudAuthorizationResultV1`, `CapabilityPresentationEnvelopeV1`, `validateAuthorizationResultV1`, `isPlausibleOpenKeyActionId`, `OPENKEY_ACTION_ID_SEPARATOR`.
  - `sdk-core` also exports narrowing-verification helpers `extractImmutableSiweFields`, `diffImmutableSiweFields`, `extractRecapAttenuations`, `unauthorizedRecapCapabilities` (with `ImmutableSiweFields` and `RecapAttenuation` types) so consumers can prove that a widget-signed SIWE is a strict narrowing of the SDK's original prepared SIWE.
  - `node-sdk` adds `NodeUserAuthorization.signInWithOpenKeyResult()` which completes the session with the exact `signedMessage` the OpenKey widget returned (not the caller's original prepared SIWE). Its `prepared` argument now REQUIRES `siwe` (the SDK-generated reference SIWE). Validates that the signature verifies against the returned bytes, that the recovered signer matches the local signer, that every immutable SIWE header field (domain, address, URI, version, chainId, nonce, issuedAt) is preserved byte-for-byte, that the ReCap capability set is a subset of the original request, and that `selectedActionKeys` are covered by that set. Note: `statement` handling was refined in `sol-final-continuation-fixes.md` — earlier drafts of this changeset incorrectly implied statement drift was always allowed; the delivered rule is that statement is byte-immutable for plain SIWEs and validated via the ReCap subset check for ReCap-bearing SIWEs.
  - `cli` browser-auth advertises `protocolVersion=1` on the /delegate URL, validates every callback payload before persisting (including structural checks on the optional `permissions[]` array), and (when the response includes effective `permissions`) refuses any grant that broadens the requested set.
  - `sdk-core.unauthorizedRecapCapabilities` now enforces EXACT MULTISET EQUALITY on the caveat list for every surviving (resource, ability) pair. Removing an entire ability or resource from the child is still permitted (that is genuine narrowing), but for any (resource, ability) that survives, the child's caveat list must equal the parent's caveat list as a multiset — i.e. same set of canonicalized caveat objects with the SAME duplicate counts. Concretely: (a) adding a caveat not present in the parent is rejected, (b) removing an alternative from a non-empty parent caveat list is rejected (removing all caveats to broaden from "restricted" to "unrestricted" is the special case of this), (c) replacing a caveat with a different one is rejected, (d) changing the number of times a duplicated caveat appears is rejected, and (e) the empty-parent case requires the child to also be empty on that ability (both sides carry zero caveats — neither imposes a restriction). Order within a caveat object's own keys is normalized via canonical JSON serialization before counting, so key reordering inside a single caveat is not itself a difference; only differences in the multiset of caveat objects matter.
  - `node-sdk.signInWithOpenKeyResult` now enforces stricter selectedActionKeys/permissions consistency: `selectedActionKeys` must cover every non-required capability in `signedMessage`; every returned `permissions` entry action must appear in `signedMessage`; broader `permissions` entries are rejected; empty `permissions[]` with a capability-bearing SIWE is rejected; duplicate `selectedActionKeys` entries are rejected; and the resource-substring fallback used to resolve permission entries has been replaced with a canonical two-form resolver (space or space+path) that fails on ambiguity.
  - `node-sdk` adds `NodeUserAuthorization.signInWithOpenKey(authorizeFn, opts)` — the production entry point that wires `prepareSessionForSigning` → OpenKey `authorizeTinyCloud()` → `signInWithOpenKeyResult` into one call. Callers provide a thin `authorizeFn` bridge to the OpenKey SDK; the node-sdk enforces every subset/immutable-field invariant before creating any session state.
  - `cli.parseDelegationExpiryField` numeric-seconds test fixture corrected (was passing `4_071_849_600` = Jan 11 2099, but expected Jan 1 2099 = `4_070_908_800`).
  - `node-sdk.signInWithOpenKeyResult` REJECTS legacy two-part `resource\0action` selectedActionKeys — Sol continuation contract requires the CANONICAL four-part `service\0space\0path\0ability` shape. The prior suffix-match fallback silently accepted IDs that did not carry a validated service namespace; four-part canonical IDs are the only accepted format.
  - `node-sdk` adds `wireOpenKeyAuthorize(openkey)` — a production adapter that translates any structurally-OpenKey object (typically `@openkey/sdk`'s `OpenKey` instance) into the `authorizeFn` callback `signInWithOpenKey` expects. The bridge does not fabricate protocol fields — every value flows through unchanged, and wire drift (missing `signedMessage`, unsupported `protocolVersion`, malformed selection) throws at the boundary. Enables real production consumers to wire OpenKey into `NodeUserAuthorization` without either package taking a direct build dependency on the other.

### Patch Changes

- e525137: Address Sol continuation-review rejection blockers on the OpenKey
  authorization consolidation.
  - `sdk-core.ImmutableSiweFields` now covers the full immutable header set:
    `expirationTime`, `notBefore`, `requestId`, `statement`, and
    `nonRecapResources`. `extractImmutableSiweFields` parses them and
    `diffImmutableSiweFields` includes them so a widget swapping any
    of these fields fails the SDK's byte-for-byte immutable check.
  - `sdk-core.unauthorizedRecapCapabilities` now enforces STRICT normalized
    caveat-multiset equality. Dropping alternatives from a disjunction,
    adding restrictions to an unrestricted parent, and any lexical caveat
    change all reject. Formal attenuation may relax this later.
  - `node-sdk.signInWithOpenKeyResult` requires the returned `permissions`
    array to equal the signed authority for EVERY resource/action pair,
    including structurally-required capabilities (e.g.
    `tinycloud.capabilities/read`). Missing entries and extras both fail
    hard (was: only non-required coverage was required).
  - `node-sdk.signInWithOpenKey` accepts an optional `openkeyKeyId` option
    and forwards it to the `authorizeFn` bridge so callers can pin the
    OpenKey key ID used by the widget.
  - `cli.auth request --grant` reports EFFECTIVE grants (from the signed
    delegation) rather than the originally-requested set — the previous
    behaviour over-reported authority when the user narrowed the request
    in the OpenKey UI. Applies to both OpenKey-backed and local-key flows.
  - `node-sdk` production TypeScript build no longer includes test sources
    or test-support modules, so `tsc --noEmit -p packages/node-sdk/tsconfig.json`
    now exits 0.
  - `node-sdk.signInWithOpenKey` resolves the actual TinyCloud activation host
    before preparing or sending the OpenKey authorization request. A per-call
    host override is installed as the session host, so the host bound into the
    OpenKey context and the host later used for activation cannot diverge.

- Updated dependencies [b38dd12]
- Updated dependencies [cc75957]
- Updated dependencies [a7e3668]
- Updated dependencies [e525137]
- Updated dependencies [ba9c983]
  - @tinycloud/node-sdk@2.11.0-beta.10
  - @tinycloud/operations@0.3.2-beta.9

## 0.9.0-beta.8

### Patch Changes

- @tinycloud/node-sdk@2.11.0-beta.9
- @tinycloud/operations@0.3.2-beta.8

## 0.9.0-beta.7

### Patch Changes

- Updated dependencies [68faad4]
  - @tinycloud/node-sdk-wasm@1.7.6-beta.0
  - @tinycloud/node-sdk@2.11.0-beta.8
  - @tinycloud/operations@0.3.2-beta.7

## 0.9.0-beta.6

### Minor Changes

- 2a77ebc: Add bounded Markdown bearer publishing plus stdin-safe Share inspect and receive commands backed by the canonical headless SDK.
- 4ce36a6: Add typed recipient-DID/device authorization, exact-email and domain policy publication/claim resume seams, idempotent notification outcomes, encrypted sender history views, target-aware revocation, and explicit read-only tc1 migration helpers to the canonical Share SDK and CLI.

### Patch Changes

- 44ecf56: Release the exact-head session invocation APIs and canonical recipient-DID policy support used by Share.
- 17d5662: Pin addressed verification to an injected signer trust root, require detached node proof verification for authorized content, and keep Share command authority seams explicit and redacted.
- 705685e: Keep Share machine output redacted, make unavailable addressed revocation fail
  non-zero, and route browser consumers through the compiled receive contract.
- 07e3c85: Add an explicit read-only `share migrate` bridge for `tc1:` links and expose
  authenticated Share upload adapters to the modern CLI publisher.
- d4ec80a: Harden addressed Share content verification, restore CLI command dispatch and
  nonce-bound production upload authorization, and close filesystem and lifecycle
  edge cases in the Share command surface.
- 1103359: Route addressed Share verification through the canonical SDK, keep Node uploads fail-closed without explicit authority, and make the Share/help CLI entry independent of optional WASM authentication modules.
- Updated dependencies [44ecf56]
- Updated dependencies [17d5662]
- Updated dependencies [2a77ebc]
- Updated dependencies [705685e]
- Updated dependencies [d4ec80a]
- Updated dependencies [1103359]
- Updated dependencies [9fd8752]
- Updated dependencies [4ce36a6]
  - @tinycloud/node-sdk@2.11.0-beta.7
  - @tinycloud/operations@0.3.2-beta.6
  - @tinycloud/share-sdk@0.2.0-beta.0
  - @tinycloud/share-envelope@0.2.0-beta.0

## 0.8.3-beta.4

### Patch Changes

- Updated dependencies [f0842d8]
  - @tinycloud/node-sdk@2.11.0-beta.5
  - @tinycloud/operations@0.3.2-beta.4

## 0.8.3-beta.3

### Patch Changes

- 746cb02: Stop implicitly probing `127.0.0.1` during TinyCloud host discovery. Loopback
  discovery now requires an explicit `localNodeUrl`, while configured and
  registry-discovered `*.local.tinycloud.link` nodes continue to work.
- Updated dependencies [746cb02]
  - @tinycloud/node-sdk@2.11.0-beta.4
  - @tinycloud/operations@0.3.2-beta.3

## 0.8.3-beta.2

### Patch Changes

- @tinycloud/node-sdk@2.11.0-beta.3
- @tinycloud/operations@0.3.2-beta.2

## 0.8.3-beta.1

### Patch Changes

- Updated dependencies [d1d675b]
  - @tinycloud/node-sdk@2.11.0-beta.1
  - @tinycloud/operations@0.3.2-beta.1

## 0.8.3-beta.0

### Patch Changes

- @tinycloud/node-sdk@2.11.0-beta.0
- @tinycloud/operations@0.3.2-beta.0

## 0.8.2

### Patch Changes

- Updated dependencies [28cc430]
  - @tinycloud/node-sdk@2.10.0
  - @tinycloud/operations@0.3.1

## 0.8.2-beta.1

### Patch Changes

- @tinycloud/node-sdk@2.10.0-beta.1
- @tinycloud/operations@0.3.1-beta.1

## 0.8.2-beta.0

### Patch Changes

- Updated dependencies [28cc430]
  - @tinycloud/node-sdk@2.10.0-beta.0
  - @tinycloud/operations@0.3.1-beta.0

## 0.8.1

### Patch Changes

- Updated dependencies [f0febf1]
  - @tinycloud/operations@0.3.0

## 0.8.1-beta.0

### Patch Changes

- Updated dependencies [f0febf1]
  - @tinycloud/operations@0.3.0-beta.0

## 0.8.0

### Minor Changes

- 9afb09c: Add localhost-first node resolution with identity pinning. Before falling back to registry/hosted resolution, `resolveTinyCloudHosts` now probes for a locally-running TinyCloud node (loopback, then `*.local.tinycloud.link`) and uses it if it answers and passes DID identity verification (trust-on-first-use, pinned per consumer). New opt-out and config knobs: `autoDiscoverLocalNode` (default true), `localNodeUrl`, `localLinkName`, `expectedNodeDid`, surfaced on node-sdk, web-sdk, and the CLI. Explicit host configuration (`host`, `--host`/`TC_HOST`) continues to skip discovery entirely.

### Patch Changes

- Updated dependencies [9afb09c]
  - @tinycloud/node-sdk@2.9.0
  - @tinycloud/operations@0.2.1

## 0.7.8

### Patch Changes

- Updated dependencies [7ecd455]
- Updated dependencies [7ecd455]
  - @tinycloud/operations@0.2.0
  - @tinycloud/node-sdk@2.8.0

## 0.7.8-beta.0

### Patch Changes

- Updated dependencies [7ecd455]
- Updated dependencies [7ecd455]
  - @tinycloud/operations@0.2.0-beta.0
  - @tinycloud/node-sdk@2.8.0-beta.0

## 0.7.7

### Patch Changes

- 1269a58: Add canonical delegated account-space, application, and generic non-secrets KV exploration operations. Publish the beta MCP package with four corresponding read-only tools and a documented exact request, owner grant, import, restart, and retry workflow. Allow a fresh delegate profile to bootstrap from its first request-bound delegation while preserving canonical import validation.
- 565b5fd: Reject unrecoverable public-only profile sessions before SDK restore and report missing private JWK material as an authentication problem with a sign-in hint instead of a network failure.
- 28e4ae8: Allow a fresh `delegate-session` profile to request permissions using logical space names before it knows the granting owner's address.
- 5c32147: Add the I5 Commander coverage ledger and deterministic registration check,
  cross-surface canonical-envelope fixtures, generated coverage references,
  source-boundary checks, and Node 20 packed-artifact conformance gates. MCP
  publication remains deferred while the SDK v2 beta gate is `unpublishable-defer`.
- a5b557a: Resolve explicit-key secret spaces against the authenticated owner and keep
  local-owner acquisition and its single retry on one live runtime session.
- 2721f9d: Add the experimental operations package foundation and depend on its exact prerelease from the CLI.
- f5b1c75: Repair I2 release artifacts: bundle ESM-only multiformats dependencies for Node CommonJS consumers, preserve safe delegation mismatch details, and publish the canonical CLI auth import route.
- b982b90: Declare Node 20 or newer as the supported runtime floor for the complete published SDK and Operations graph, including the CLI and Node WASM bindings.
- 206533a: Route request-bound v1 delegation imports through TinyCloud operations while retaining legacy auth-import compatibility paths.
- abe8083: Implement the canonical `tinycloud.secrets.get` operation and route `tc secrets get` through it while preserving Commander rendering and owner authorization behavior.
- decbb25: Allow a fresh `delegate-session` profile to establish its first authenticated session by importing a delegation targeted at its generated session key.
- Updated dependencies [492a656]
- Updated dependencies [940ff1d]
- Updated dependencies [367c17c]
- Updated dependencies [1269a58]
- Updated dependencies [5172cf9]
- Updated dependencies [f6048b7]
- Updated dependencies [5c32147]
- Updated dependencies [a5b557a]
- Updated dependencies [2721f9d]
- Updated dependencies [f7a1d4f]
- Updated dependencies [f5b1c75]
- Updated dependencies [39cc055]
- Updated dependencies [4dee0a9]
- Updated dependencies [b982b90]
- Updated dependencies [96b9e21]
- Updated dependencies [160c16e]
- Updated dependencies [d6d5ef1]
- Updated dependencies [8777823]
- Updated dependencies [abe8083]
- Updated dependencies [cd8c11f]
- Updated dependencies [1606a6f]
- Updated dependencies [c62f72a]
- Updated dependencies [1c73181]
- Updated dependencies [96b9e21]
  - @tinycloud/operations@0.1.0
  - @tinycloud/node-sdk-wasm@1.7.5
  - @tinycloud/node-sdk@2.7.0

## 0.7.7-beta.8

### Patch Changes

- 1269a58: Add canonical delegated account-space, application, and generic non-secrets KV exploration operations. Publish the beta MCP package with four corresponding read-only tools and a documented exact request, owner grant, import, restart, and retry workflow. Allow a fresh delegate profile to bootstrap from its first request-bound delegation while preserving canonical import validation.
- Updated dependencies [1269a58]
  - @tinycloud/operations@0.1.0-beta.2
  - @tinycloud/node-sdk@2.7.0-beta.5

## 0.7.7-beta.7

### Patch Changes

- 5c32147: Add the I5 Commander coverage ledger and deterministic registration check,
  cross-surface canonical-envelope fixtures, generated coverage references,
  source-boundary checks, and Node 20 packed-artifact conformance gates. MCP
  publication remains deferred while the SDK v2 beta gate is `unpublishable-defer`.
- a5b557a: Resolve explicit-key secret spaces against the authenticated owner and keep
  local-owner acquisition and its single retry on one live runtime session.
- 2721f9d: Add the experimental operations package foundation and depend on its exact prerelease from the CLI.
- f5b1c75: Repair I2 release artifacts: bundle ESM-only multiformats dependencies for Node CommonJS consumers, preserve safe delegation mismatch details, and publish the canonical CLI auth import route.
- b982b90: Declare Node 20 or newer as the supported runtime floor for the complete published SDK and Operations graph, including the CLI and Node WASM bindings.
- 206533a: Route request-bound v1 delegation imports through TinyCloud operations while retaining legacy auth-import compatibility paths.
- abe8083: Implement the canonical `tinycloud.secrets.get` operation and route `tc secrets get` through it while preserving Commander rendering and owner authorization behavior.
- Updated dependencies [492a656]
- Updated dependencies [940ff1d]
- Updated dependencies [5172cf9]
- Updated dependencies [5c32147]
- Updated dependencies [a5b557a]
- Updated dependencies [2721f9d]
- Updated dependencies [f5b1c75]
- Updated dependencies [39cc055]
- Updated dependencies [b982b90]
- Updated dependencies [96b9e21]
- Updated dependencies [160c16e]
- Updated dependencies [d6d5ef1]
- Updated dependencies [8777823]
- Updated dependencies [abe8083]
- Updated dependencies [cd8c11f]
- Updated dependencies [1606a6f]
- Updated dependencies [c62f72a]
- Updated dependencies [1c73181]
- Updated dependencies [96b9e21]
  - @tinycloud/operations@0.1.0-beta.1
  - @tinycloud/node-sdk-wasm@1.7.5-beta.0
  - @tinycloud/node-sdk@2.7.0-beta.4

## 0.7.7-beta.6

### Patch Changes

- Updated dependencies [f7a1d4f]
  - @tinycloud/node-sdk@2.7.0-beta.3

## 0.7.7-beta.5

### Patch Changes

- Updated dependencies [4dee0a9]
  - @tinycloud/node-sdk@2.7.0-beta.2

## 0.7.7-beta.4

### Patch Changes

- 28e4ae8: Allow a fresh `delegate-session` profile to request permissions using logical space names before it knows the granting owner's address.

## 0.7.7-beta.3

### Patch Changes

- decbb25: Allow a fresh `delegate-session` profile to establish its first authenticated session by importing a delegation targeted at its generated session key.

## 0.7.7-beta.2

### Patch Changes

- Updated dependencies [367c17c]
  - @tinycloud/node-sdk@2.6.4-beta.1

## 0.7.7-beta.1

### Patch Changes

- 565b5fd: Reject unrecoverable public-only profile sessions before SDK restore and report missing private JWK material as an authentication problem with a sign-in hint instead of a network failure.

## 0.7.7-beta.0

### Patch Changes

- Updated dependencies [f6048b7]
  - @tinycloud/node-sdk@2.6.4-beta.0

## 0.7.6

### Patch Changes

- Updated dependencies [3841be4]
  - @tinycloud/node-sdk@2.6.3

## 0.7.6-beta.0

### Patch Changes

- Updated dependencies [3841be4]
  - @tinycloud/node-sdk@2.6.3-beta.0

## 0.7.5

### Patch Changes

- Updated dependencies [b4d1e45]
  - @tinycloud/node-sdk@2.6.2

## 0.7.5-beta.0

### Patch Changes

- Updated dependencies [b4d1e45]
  - @tinycloud/node-sdk@2.6.2-beta.0

## 0.7.4

### Patch Changes

- Updated dependencies [bf31506]
  - @tinycloud/node-sdk@2.6.1

## 0.7.4-beta.1

### Patch Changes

- @tinycloud/node-sdk@2.6.1-beta.1

## 0.7.4-beta.0

### Patch Changes

- Updated dependencies [bf31506]
  - @tinycloud/node-sdk@2.6.1-beta.0

## 0.7.3

### Patch Changes

- Updated dependencies [ac48f85]
- Updated dependencies [2f31800]
- Updated dependencies [3ad0635]
- Updated dependencies [e07823b]
  - @tinycloud/node-sdk@2.6.0

## 0.7.3-beta.3

### Patch Changes

- Updated dependencies [e07823b]
  - @tinycloud/node-sdk@2.6.0-beta.3

## 0.7.3-beta.2

### Patch Changes

- Updated dependencies [3ad0635]
  - @tinycloud/node-sdk@2.6.0-beta.2

## 0.7.3-beta.1

### Patch Changes

- Updated dependencies [ac48f85]
  - @tinycloud/node-sdk@2.6.0-beta.1

## 0.7.3-beta.0

### Patch Changes

- Updated dependencies [2f31800]
  - @tinycloud/node-sdk@2.6.0-beta.0

## 0.7.2

### Patch Changes

- Updated dependencies [3b23940]
  - @tinycloud/node-sdk@2.5.1

## 0.7.2-beta.0

### Patch Changes

- Updated dependencies [3b23940]
  - @tinycloud/node-sdk@2.5.1-beta.0

## 0.7.1

### Patch Changes

- Updated dependencies [cbd5dcc]
- Updated dependencies [dda499e]
  - @tinycloud/node-sdk@2.5.0

## 0.7.1-beta.1

### Patch Changes

- Updated dependencies [dda499e]
  - @tinycloud/node-sdk@2.5.0-beta.1

## 0.7.1-beta.0

### Patch Changes

- Updated dependencies [cbd5dcc]
  - @tinycloud/node-sdk@2.4.1-beta.0

## 0.7.0

### Minor Changes

- 6b554d6: Add shared account APIs for applications and delegations, expose them from the node and web SDK clients, and add the `tc account` CLI command group.
- 75bebb1: Add account registry write-through indexing, account space registry APIs, and matching `tc account spaces` / `tc account index status` CLI commands.

  Manifest registration now records an indexed manifest hash and skips durable KV rewrites when the indexed record is current. Sign-in schedules best-effort background registry sync for application manifests and accessible spaces, while every discovered or hosted space is written through to the account registry index.

- 0e8ccc6: Add `TinyCloudNode.hostOwnedSpace(name)` and wire `tc space create`/`tc space host` to it.

  Hosting an owned space (e.g. `applications`) by name now registers it on the server via the host-SIWE delegation flow, so subsequent KV/SQL writes to that space succeed instead of returning `404 - Space not found`. Unlike the internal `ensureOwnedSpaceHosted`, this always submits the host delegation rather than inferring hosting from session activation — a space the current session has never referenced is reported neither `activated` nor `skipped`, which previously caused the host to be silently skipped. The host SIWE is idempotent server-side, so re-hosting an existing space is a safe no-op.

  The `tc space create <name>` command (which previously POSTed the unsupported `tinycloud.space/create` action and failed with `401 Unauthorized`) now hosts the caller's owned space; `tc space host <name>` is added as an alias.

- 934534d: Auth/hosting developer experience for the delegate-asks-owner-to-host model.
  - **`tc space host-request <name> --emit <file>`** (delegate-only): emits a `tinycloud.host.request` artifact naming the space and its resolved owner DID so an agent can surface it to the owner, who then runs `tc space host <name>`. If the caller IS the root authority of the resolved space, it refuses (`ALREADY_ROOT_AUTHORITY`) and tells them to host directly — no request is emitted. The command is a pure local emit and never contacts the node.
  - **Identity-aware `SPACE_NOT_HOSTED`**: an unhosted-space write/read previously surfaced as an opaque `404 - Space not found`. The kv and sql commands now normalize **only** that exact condition (404 + "Space not found" body) to a `SPACE_NOT_HOSTED` error carrying an identity-aware `hint`. The branch key `is_root_authority(space, active session)` is computed locally from the profile address + space DID (no network): the owner is told to run `tc space host <name>`, a delegate is told they cannot host and to emit `tc space host-request <name> --emit`. A wrong db/table/path or permission error is left untouched. A `delegate-session` profile is never treated as the root authority even when its stored ownerDid is the space owner, so a delegate always gets the host-request hint. `KVService` get/head/delete now preserve the `Space not found` 404 body (previously collapsed to `KV_NOT_FOUND` before the body was read), so unhosted-space **reads** normalize too, while a genuine missing key still reports `KV_NOT_FOUND`.
  - **SDK `grantAuthRequest(authority, request, options?)`** (`@tinycloud/node-sdk`): takes a delegation request artifact and returns a grant artifact (`tinycloud.auth.delegation`) by signing through `delegateTo`, so the request→grant handshake is callable programmatically. `tc auth grant` is now a thin wrapper over it. Adds the `AuthRequestArtifact`, `AuthDelegationArtifact`, and `DelegationAuthority` types.

- 5737b67: Add `tc secrets get <NAME> --delegation <file-or-imported-profile>` for reading a secret you were delegated access to. The `--delegation` source can be a delegation JSON file or the name of a profile that imported the delegation (resolved from `additional-delegations.json`). The read path validates that the delegation covers both the secret's `tinycloud.kv/get` path and the envelope's `tinycloud.encryption/decrypt` network, then activates the delegation in wallet mode via `node.useDelegation(...)` to fetch and decrypt the value. Adds a `smoke:delegated-secrets` script that exercises the full owner-delegate flow against a live node.
- 1f69109: `tc secrets {get,put,delete,list,doctor}` now targets the literal `secrets` space (matching the secret-manager web app's `SECRETS_SPACE` in `src/lib/tinycloud-manifest.ts`) instead of the active profile's default space, so CLI-issued permission grants line up with secrets stored by the web app. Restores `--space <space>` as a real flag distinct from `--scope <scope>` (previously `--space` was a silent alias for `--scope`); `--space` overrides the permission-grant space. Permission paths remain `vault/secrets/<NAME>` / `vault/secrets/scoped/<scope>/<NAME>` — the `vault/` prefix is the wire-level KV path that `DataVaultService` writes to and that `tinycloud.vault` permissions expand to via `vaultActionExpansion()` in `sdk-core`, not a CLI-only artifact.

  Known limitation: `--space` currently only flows through to permission-grant requests; the underlying `node.secrets.{get,put,delete,list}` calls still resolve their own space via the SDK. Lighting `--space` up end-to-end requires SDK work outside this CLI package.

### Patch Changes

- 0d397a8: Treat the account SQLite index as a materialized cache for user-facing account reads. Account application, space, and delegation list calls can now prefer the index while falling back to canonical account data when index tables are missing or empty, and account writes no longer fail when a best-effort index update fails.
- 6622043: Expose `account.index.ensure()` and `tc account index ensure` for lightweight account SQLite schema bootstrap, and start schema bootstrap with background account registry sync.
- 5737b67: Fix `tc auth import` rejecting cross-user delegations. Import unconditionally called `node.useRuntimeDelegation(...)`, which requires the delegation to target the active session key and so threw `Runtime delegation targets did:pkh:... but this session key is did:key:...` for a delegation received from another user (audience = your stable identity DID). Import now routes by audience: a delegation that targets the active session key is still installed as a runtime grant, while a cross-user delegation is persisted to `additional-delegations.json` and later activated at read time via `node.useDelegation(...)`. The `imported` output now includes an `activated` flag indicating whether a runtime grant was installed.
- a61f935: Delegate-mode secrets commands now honor `TC_PRIVATE_KEY` / `--private-key` for headless auth. Previously `tc secrets get --delegation` (and the other `--private-key`-advertising secrets commands) threw `AUTH_REQUIRED` when only an explicit private key was supplied, because `ensureAuthenticated` consulted `options.privateKey` only after its profile/session gate. An explicitly provided private key is now treated as a first-class headless identity and accepted before that gate, so a delegate can authenticate with no persisted profile and no login session — exactly what the flags and env var already advertised.
- 0219c37: Fix `tc kv` and `tc sql` failing with `Missing private key parameter in JWK` after an OpenKey login. The OpenKey delegation flow sends only the public JWK (no `d`) to OpenKey, and the public-only JWK that OpenKey echoes back was being persisted verbatim to `session.json`, shadowing the full keypair in `key.json` whenever the SDK reconstructed the WASM signer. Two-pronged fix: (1) on read, `sdk.ts` falls back to `key.json` whenever `session.jwk` lacks the `d` parameter, and (2) on write, `refreshOpenKeySession` merges `d` from `key.json` into the persisted session JWK so future invocations don't hit the same path. `tc auth status` and `tc secrets get` were unaffected because neither hits the WASM signer in this code path.

  Affected users on existing installs can unblock without re-authenticating by jq-merging `key.json`'s `d` into `session.json`'s `.jwk` field.

- bd8a60f: Remove the deprecated `SQLAction.DDL` export and the `tinycloud.sql/ddl` permission display path. SQL schema changes use `SQLAction.SCHEMA` and `tinycloud.sql/schema`.
- c94b81b: Fix `tc kv put`/`kv delete --space` and binary KV round-trips.
  - `tc kv put` and `tc kv delete` now accept `--space <name|uri>`, routing through
    the space-scoped KV (`kvForSpace`) like `get`/`list`/`head` already did. KV
    writes to a non-primary space (e.g. an `applications` space) are now possible
    from the CLI.
  - Binary KV values now round-trip byte-identically. `KVService.put` sends
    Blob/ArrayBuffer/typed-array/Buffer values as raw bytes
    (`application/octet-stream`, honoring an explicit `contentType`) instead of
    JSON-stringifying them into `{"type":"Buffer","data":[...]}`. A new
    `KVGetOptions.binary` returns the raw response bytes as a `Uint8Array`, and the
    CLI's `kv get -o <file>` / `--raw` use it so images and other binaries are
    written out unchanged.

- 7603d1f: Support concise app manifest knowledge pointers. The SDK now validates `knowledge: true` and `knowledge/*.md` roots, exposes a helper for resolving the effective knowledge root, and `tc manifest resolve` includes that root in its output.
- cdcb227: Send a user-facing `reason` when TinyCloud CLI opens OpenKey permission approval flows, so the consent page can show why the requested capabilities are needed.
- 0187e64: Fix `OPENKEY_SCOPE_MISMATCH` on `tc auth request --grant` for OpenKey profiles, and batch multiple `--cap` on one space into a single OpenKey round-trip.

  The CLI compared the space the OpenKey node returned against the space it built for the request byte-for-byte. OpenKey returns the EIP-55 **checksummed** eip155 address (`0xd559CCd9...dE93cf412`) while the CLI builds the **lowercase** form, so a grant for a valid space spuriously failed with `OPENKEY_SCOPE_MISMATCH`. Ethereum addresses are case-insensitive; space comparison now normalizes (lowercases) the address segment on both sides.

  The same normalization is applied when grouping requested caps by space, so multiple `--cap` for the same space — even if one is typed checksummed and another lowercase — batch into a single OpenKey browser round-trip instead of one per casing.

- e2c3bb1: Add `tc secrets doctor` and include default secrets decrypt permissions when app manifests request readable secrets.
- a22a7f0: Rename the SDK-emitted SQL schema-change permission from `tinycloud.sql/ddl` to `tinycloud.sql/schema`, including manifest defaults and account-registry grants.

  TinyCloudWeb now treats a restored persisted session as stale when it does not cover the currently configured manifest permissions, then runs the normal manifest sign-in flow instead of letting apps request those manifest permissions separately after login.

- Updated dependencies [6b554d6]
- Updated dependencies [0d397a8]
- Updated dependencies [895804a]
- Updated dependencies [6622043]
- Updated dependencies [75bebb1]
- Updated dependencies [0e8ccc6]
- Updated dependencies [934534d]
- Updated dependencies [79dd26c]
- Updated dependencies [08e292d]
- Updated dependencies [7c5fe21]
- Updated dependencies [eb44380]
- Updated dependencies [27f97d8]
- Updated dependencies [aa050d1]
- Updated dependencies [8e8f7e8]
- Updated dependencies [fa4a7c7]
- Updated dependencies [d4a0a69]
- Updated dependencies [a22a7f0]
- Updated dependencies [42f1235]
- Updated dependencies [b6c3fd8]
  - @tinycloud/node-sdk@2.4.0

## 0.7.0-beta.23

### Minor Changes

- 1f69109: `tc secrets {get,put,delete,list,doctor}` now targets the literal `secrets` space (matching the secret-manager web app's `SECRETS_SPACE` in `src/lib/tinycloud-manifest.ts`) instead of the active profile's default space, so CLI-issued permission grants line up with secrets stored by the web app. Restores `--space <space>` as a real flag distinct from `--scope <scope>` (previously `--space` was a silent alias for `--scope`); `--space` overrides the permission-grant space. Permission paths remain `vault/secrets/<NAME>` / `vault/secrets/scoped/<scope>/<NAME>` — the `vault/` prefix is the wire-level KV path that `DataVaultService` writes to and that `tinycloud.vault` permissions expand to via `vaultActionExpansion()` in `sdk-core`, not a CLI-only artifact.

  Known limitation: `--space` currently only flows through to permission-grant requests; the underlying `node.secrets.{get,put,delete,list}` calls still resolve their own space via the SDK. Lighting `--space` up end-to-end requires SDK work outside this CLI package.

### Patch Changes

- 0219c37: Fix `tc kv` and `tc sql` failing with `Missing private key parameter in JWK` after an OpenKey login. The OpenKey delegation flow sends only the public JWK (no `d`) to OpenKey, and the public-only JWK that OpenKey echoes back was being persisted verbatim to `session.json`, shadowing the full keypair in `key.json` whenever the SDK reconstructed the WASM signer. Two-pronged fix: (1) on read, `sdk.ts` falls back to `key.json` whenever `session.jwk` lacks the `d` parameter, and (2) on write, `refreshOpenKeySession` merges `d` from `key.json` into the persisted session JWK so future invocations don't hit the same path. `tc auth status` and `tc secrets get` were unaffected because neither hits the WASM signer in this code path.

  Affected users on existing installs can unblock without re-authenticating by jq-merging `key.json`'s `d` into `session.json`'s `.jwk` field.

## 0.7.0-beta.22

### Patch Changes

- Updated dependencies [42f1235]
  - @tinycloud/node-sdk@2.4.0-beta.19

## 0.7.0-beta.21

### Patch Changes

- a61f935: Delegate-mode secrets commands now honor `TC_PRIVATE_KEY` / `--private-key` for headless auth. Previously `tc secrets get --delegation` (and the other `--private-key`-advertising secrets commands) threw `AUTH_REQUIRED` when only an explicit private key was supplied, because `ensureAuthenticated` consulted `options.privateKey` only after its profile/session gate. An explicitly provided private key is now treated as a first-class headless identity and accepted before that gate, so a delegate can authenticate with no persisted profile and no login session — exactly what the flags and env var already advertised.

## 0.7.0-beta.20

### Patch Changes

- Updated dependencies [08e292d]
  - @tinycloud/node-sdk@2.4.0-beta.18

## 0.7.0-beta.19

### Patch Changes

- 6622043: Expose `account.index.ensure()` and `tc account index ensure` for lightweight account SQLite schema bootstrap, and start schema bootstrap with background account registry sync.
- Updated dependencies [6622043]
  - @tinycloud/node-sdk@2.4.0-beta.17

## 0.7.0-beta.18

### Patch Changes

- Updated dependencies [eb44380]
  - @tinycloud/node-sdk@2.4.0-beta.16

## 0.7.0-beta.17

### Patch Changes

- bd8a60f: Remove the deprecated `SQLAction.DDL` export and the `tinycloud.sql/ddl` permission display path. SQL schema changes use `SQLAction.SCHEMA` and `tinycloud.sql/schema`.
  - @tinycloud/node-sdk@2.4.0-beta.15

## 0.7.0-beta.16

### Patch Changes

- a22a7f0: Rename the SDK-emitted SQL schema-change permission from `tinycloud.sql/ddl` to `tinycloud.sql/schema`, including manifest defaults and account-registry grants.

  TinyCloudWeb now treats a restored persisted session as stale when it does not cover the currently configured manifest permissions, then runs the normal manifest sign-in flow instead of letting apps request those manifest permissions separately after login.

- Updated dependencies [a22a7f0]
  - @tinycloud/node-sdk@2.4.0-beta.14

## 0.7.0-beta.15

### Patch Changes

- 7603d1f: Support concise app manifest knowledge pointers. The SDK now validates `knowledge: true` and `knowledge/*.md` roots, exposes a helper for resolving the effective knowledge root, and `tc manifest resolve` includes that root in its output.
  - @tinycloud/node-sdk@2.4.0-beta.13

## 0.7.0-beta.14

### Patch Changes

- Updated dependencies [fa4a7c7]
  - @tinycloud/node-sdk@2.4.0-beta.12

## 0.7.0-beta.13

### Patch Changes

- Updated dependencies [aa050d1]
  - @tinycloud/node-sdk@2.4.0-beta.11

## 0.7.0-beta.12

### Patch Changes

- Updated dependencies [27f97d8]
- Updated dependencies [d4a0a69]
  - @tinycloud/node-sdk@2.4.0-beta.10

## 0.7.0-beta.11

### Patch Changes

- 0d397a8: Treat the account SQLite index as a materialized cache for user-facing account reads. Account application, space, and delegation list calls can now prefer the index while falling back to canonical account data when index tables are missing or empty, and account writes no longer fail when a best-effort index update fails.
- Updated dependencies [0d397a8]
  - @tinycloud/node-sdk@2.4.0-beta.9

## 0.7.0-beta.10

### Patch Changes

- Updated dependencies [895804a]
  - @tinycloud/node-sdk@2.4.0-beta.8

## 0.7.0-beta.9

### Minor Changes

- 75bebb1: Add account registry write-through indexing, account space registry APIs, and matching `tc account spaces` / `tc account index status` CLI commands.

  Manifest registration now records an indexed manifest hash and skips durable KV rewrites when the indexed record is current. Sign-in schedules best-effort background registry sync for application manifests and accessible spaces, while every discovered or hosted space is written through to the account registry index.

### Patch Changes

- cdcb227: Send a user-facing `reason` when TinyCloud CLI opens OpenKey permission approval flows, so the consent page can show why the requested capabilities are needed.
- Updated dependencies [75bebb1]
  - @tinycloud/node-sdk@2.4.0-beta.7

## 0.7.0-beta.8

### Minor Changes

- 6b554d6: Add shared account APIs for applications and delegations, expose them from the node and web SDK clients, and add the `tc account` CLI command group.

### Patch Changes

- Updated dependencies [6b554d6]
  - @tinycloud/node-sdk@2.4.0-beta.6

## 0.7.0-beta.7

### Patch Changes

- Updated dependencies [7c5fe21]
  - @tinycloud/node-sdk@2.4.0-beta.5

## 0.7.0-beta.6

### Patch Changes

- e2c3bb1: Add `tc secrets doctor` and include default secrets decrypt permissions when app manifests request readable secrets.

## 0.7.0-beta.5

### Patch Changes

- Updated dependencies [8e8f7e8]
  - @tinycloud/node-sdk@2.4.0-beta.3

## 0.7.0-beta.4

### Minor Changes

- 934534d: Auth/hosting developer experience for the delegate-asks-owner-to-host model.
  - **`tc space host-request <name> --emit <file>`** (delegate-only): emits a `tinycloud.host.request` artifact naming the space and its resolved owner DID so an agent can surface it to the owner, who then runs `tc space host <name>`. If the caller IS the root authority of the resolved space, it refuses (`ALREADY_ROOT_AUTHORITY`) and tells them to host directly — no request is emitted. The command is a pure local emit and never contacts the node.
  - **Identity-aware `SPACE_NOT_HOSTED`**: an unhosted-space write/read previously surfaced as an opaque `404 - Space not found`. The kv and sql commands now normalize **only** that exact condition (404 + "Space not found" body) to a `SPACE_NOT_HOSTED` error carrying an identity-aware `hint`. The branch key `is_root_authority(space, active session)` is computed locally from the profile address + space DID (no network): the owner is told to run `tc space host <name>`, a delegate is told they cannot host and to emit `tc space host-request <name> --emit`. A wrong db/table/path or permission error is left untouched. A `delegate-session` profile is never treated as the root authority even when its stored ownerDid is the space owner, so a delegate always gets the host-request hint. `KVService` get/head/delete now preserve the `Space not found` 404 body (previously collapsed to `KV_NOT_FOUND` before the body was read), so unhosted-space **reads** normalize too, while a genuine missing key still reports `KV_NOT_FOUND`.
  - **SDK `grantAuthRequest(authority, request, options?)`** (`@tinycloud/node-sdk`): takes a delegation request artifact and returns a grant artifact (`tinycloud.auth.delegation`) by signing through `delegateTo`, so the request→grant handshake is callable programmatically. `tc auth grant` is now a thin wrapper over it. Adds the `AuthRequestArtifact`, `AuthDelegationArtifact`, and `DelegationAuthority` types.

### Patch Changes

- Updated dependencies [934534d]
  - @tinycloud/node-sdk@2.4.0-beta.2

## 0.7.0-beta.3

### Patch Changes

- 0187e64: Fix `OPENKEY_SCOPE_MISMATCH` on `tc auth request --grant` for OpenKey profiles, and batch multiple `--cap` on one space into a single OpenKey round-trip.

  The CLI compared the space the OpenKey node returned against the space it built for the request byte-for-byte. OpenKey returns the EIP-55 **checksummed** eip155 address (`0xd559CCd9...dE93cf412`) while the CLI builds the **lowercase** form, so a grant for a valid space spuriously failed with `OPENKEY_SCOPE_MISMATCH`. Ethereum addresses are case-insensitive; space comparison now normalizes (lowercases) the address segment on both sides.

  The same normalization is applied when grouping requested caps by space, so multiple `--cap` for the same space — even if one is typed checksummed and another lowercase — batch into a single OpenKey browser round-trip instead of one per casing.

## 0.7.0-beta.2

### Minor Changes

- 0e8ccc6: Add `TinyCloudNode.hostOwnedSpace(name)` and wire `tc space create`/`tc space host` to it.

  Hosting an owned space (e.g. `applications`) by name now registers it on the server via the host-SIWE delegation flow, so subsequent KV/SQL writes to that space succeed instead of returning `404 - Space not found`. Unlike the internal `ensureOwnedSpaceHosted`, this always submits the host delegation rather than inferring hosting from session activation — a space the current session has never referenced is reported neither `activated` nor `skipped`, which previously caused the host to be silently skipped. The host SIWE is idempotent server-side, so re-hosting an existing space is a safe no-op.

  The `tc space create <name>` command (which previously POSTed the unsupported `tinycloud.space/create` action and failed with `401 Unauthorized`) now hosts the caller's owned space; `tc space host <name>` is added as an alias.

### Patch Changes

- c94b81b: Fix `tc kv put`/`kv delete --space` and binary KV round-trips.
  - `tc kv put` and `tc kv delete` now accept `--space <name|uri>`, routing through
    the space-scoped KV (`kvForSpace`) like `get`/`list`/`head` already did. KV
    writes to a non-primary space (e.g. an `applications` space) are now possible
    from the CLI.
  - Binary KV values now round-trip byte-identically. `KVService.put` sends
    Blob/ArrayBuffer/typed-array/Buffer values as raw bytes
    (`application/octet-stream`, honoring an explicit `contentType`) instead of
    JSON-stringifying them into `{"type":"Buffer","data":[...]}`. A new
    `KVGetOptions.binary` returns the raw response bytes as a `Uint8Array`, and the
    CLI's `kv get -o <file>` / `--raw` use it so images and other binaries are
    written out unchanged.

- Updated dependencies [0e8ccc6]
  - @tinycloud/node-sdk@2.4.0-beta.1

## 0.7.0-beta.1

### Minor Changes

- 5737b67: Add `tc secrets get <NAME> --delegation <file-or-imported-profile>` for reading a secret you were delegated access to. The `--delegation` source can be a delegation JSON file or the name of a profile that imported the delegation (resolved from `additional-delegations.json`). The read path validates that the delegation covers both the secret's `tinycloud.kv/get` path and the envelope's `tinycloud.encryption/decrypt` network, then activates the delegation in wallet mode via `node.useDelegation(...)` to fetch and decrypt the value. Adds a `smoke:delegated-secrets` script that exercises the full owner-delegate flow against a live node.

### Patch Changes

- 5737b67: Fix `tc auth import` rejecting cross-user delegations. Import unconditionally called `node.useRuntimeDelegation(...)`, which requires the delegation to target the active session key and so threw `Runtime delegation targets did:pkh:... but this session key is did:key:...` for a delegation received from another user (audience = your stable identity DID). Import now routes by audience: a delegation that targets the active session key is still installed as a runtime grant, while a cross-user delegation is persisted to `additional-delegations.json` and later activated at read time via `node.useDelegation(...)`. The `imported` output now includes an `activated` flag indicating whether a runtime grant was installed.

## 0.6.1-beta.0

### Patch Changes

- Updated dependencies [b6c3fd8]
  - @tinycloud/node-sdk@2.3.1-beta.0

## 0.6.0

### Minor Changes

- 9550c18: Add CLI auth artifact handoff flows for owner/delegate workflows.

  `tc auth request` now emits and stores a `tinycloud.auth.request` artifact by
  default, with `--grant` preserving the immediate grant behavior. Profiles now
  track canonical posture/operator metadata so a local key, OpenKey owner, or
  delegate session can be represented explicitly.

  New commands:
  - `tc auth grant <request>` consumes a request artifact as an owner profile and
    emits a `tinycloud.auth.delegation` artifact to stdout. Local-key owner
    grants can use `--yes` for non-interactive approval.
  - `tc auth import <artifact>` installs delegation artifacts and preserves their
    originating request id.
  - `tc auth retry <requestId|--last> --exec` reruns the captured command once the
    requested permissions are covered.

  Local-key CLI profiles now persist and restore their TinyCloud session key
  identity so request artifacts target the same session key that later imports the
  delegation. `@tinycloud/node-sdk` now accepts runtime delegations targeted at the
  fragmentless form of the current session DID (`did:key:...`) as equivalent to
  the session verification method DID URL (`did:key:...#...`).

- fb96a1e: Rename owner/delegate identity surfaces from primary/principal terminology to owner terminology.

  CLI profiles and auth request artifacts now use `ownerDid` and `sessionDid`. Encryption network descriptors and discovery APIs now expose the owner identity as `ownerDid`.

### Patch Changes

- 9ee7404: Harden encryption-network decrypt flows, add CLI secrets coverage, and fix web WASM initialization.
- a92819d: Add canonical EVM address and `did:pkh:eip155` helpers, then use them when building and comparing TinyCloud DIDs and space IDs.
- ac2dde4: Add `tc auth rotate` for rotating the active CLI profile session key and refreshing auth.
- 74161ce: Show the installed CLI version in the default `tc` help output.
- 836915f: Add `tc status` to show local profile, session, delegation, and permission state in human and JSON formats.

  TinyCloud secrets commands now request the required owner delegation and retry once when a secrets operation fails because the active session or permission grant is missing or expired.

- ddab8fa: Add `TinyCloudNode.kvForSpace(spaceId)` and a `--space` option on `tc kv get/list/head`, mirroring the existing `sqlForSpace` / `tc sql --space`. This lets KV reads target a non-primary space — e.g. reading a manifest app's data kept under the owner's `applications` space (such as Listen's transcripts at `applications/kv/<app-id>/transcript/<id>`) when the session already holds a covering delegation.
- f2d0014: Strip private JWK fields before sending delegate key material to OpenKey.
- d606baf: Accept equivalent `did:pkh:eip155` owner DID address casing when validating encryption network descriptors, including legacy `principal` descriptors, so `tc secrets` can read existing network metadata. Pin the Rust WASM source to the released `tinycloud-node` `v1.4.2` tag.
- fb1ef97: Request fully-qualified TinyCloud actions when OpenKey grants secrets permissions.
- 91f2025: Refresh expired owner OpenKey sessions before running TinyCloud secrets commands.
- Updated dependencies [9ee7404]
- Updated dependencies [a92819d]
- Updated dependencies [90bdc18]
- Updated dependencies [9550c18]
- Updated dependencies [f615a19]
- Updated dependencies [ddab8fa]
- Updated dependencies [fb96a1e]
- Updated dependencies [d606baf]
- Updated dependencies [c7676d6]
- Updated dependencies [f11e468]
  - @tinycloud/node-sdk@2.3.0
  - @tinycloud/node-sdk-wasm@1.7.4

## 0.6.0-beta.11

### Patch Changes

- ddab8fa: Add `TinyCloudNode.kvForSpace(spaceId)` and a `--space` option on `tc kv get/list/head`, mirroring the existing `sqlForSpace` / `tc sql --space`. This lets KV reads target a non-primary space — e.g. reading a manifest app's data kept under the owner's `applications` space (such as Listen's transcripts at `applications/kv/<app-id>/transcript/<id>`) when the session already holds a covering delegation.
- Updated dependencies [ddab8fa]
- Updated dependencies [f11e468]
  - @tinycloud/node-sdk@2.3.0-beta.8

## 0.6.0-beta.10

### Patch Changes

- @tinycloud/node-sdk@2.3.0-beta.7

## 0.6.0-beta.9

### Patch Changes

- ac2dde4: Add `tc auth rotate` for rotating the active CLI profile session key and refreshing auth.
- fb1ef97: Request fully-qualified TinyCloud actions when OpenKey grants secrets permissions.

## 0.6.0-beta.8

### Patch Changes

- f2d0014: Strip private JWK fields before sending delegate key material to OpenKey.

## 0.6.0-beta.7

### Patch Changes

- 836915f: Add `tc status` to show local profile, session, delegation, and permission state in human and JSON formats.

  TinyCloud secrets commands now request the required owner delegation and retry once when a secrets operation fails because the active session or permission grant is missing or expired.

- 91f2025: Refresh expired owner OpenKey sessions before running TinyCloud secrets commands.
- Updated dependencies [c7676d6]
  - @tinycloud/node-sdk@2.3.0-beta.6

## 0.6.0-beta.6

### Patch Changes

- 74161ce: Show the installed CLI version in the default `tc` help output.

## 0.6.0-beta.5

### Patch Changes

- d606baf: Accept equivalent `did:pkh:eip155` owner DID address casing when validating encryption network descriptors, including legacy `principal` descriptors, so `tc secrets` can read existing network metadata. Pin the Rust WASM source to the released `tinycloud-node` `v1.4.2` tag.
- Updated dependencies [d606baf]
  - @tinycloud/node-sdk@2.3.0-beta.5
  - @tinycloud/node-sdk-wasm@1.7.4-beta.1

## 0.6.0-beta.4

### Patch Changes

- Updated dependencies [90bdc18]
  - @tinycloud/node-sdk@2.3.0-beta.4

## 0.6.0-beta.3

### Patch Changes

- a92819d: Add canonical EVM address and `did:pkh:eip155` helpers, then use them when building and comparing TinyCloud DIDs and space IDs.
- Updated dependencies [a92819d]
  - @tinycloud/node-sdk@2.3.0-beta.3

## 0.6.0-beta.2

### Minor Changes

- fb96a1e: Rename owner/delegate identity surfaces from primary/principal terminology to owner terminology.

  CLI profiles and auth request artifacts now use `ownerDid` and `sessionDid`. Encryption network descriptors and discovery APIs now expose the owner identity as `ownerDid`.

### Patch Changes

- Updated dependencies [fb96a1e]
  - @tinycloud/node-sdk@2.3.0-beta.2

## 0.6.0-beta.1

### Minor Changes

- 9550c18: Add CLI auth artifact handoff flows for owner/delegate workflows.

  `tc auth request` now emits and stores a `tinycloud.auth.request` artifact by
  default, with `--grant` preserving the immediate grant behavior. Profiles now
  track canonical posture/operator metadata so a local key, OpenKey owner, or
  delegate session can be represented explicitly.

  New commands:
  - `tc auth grant <request>` consumes a request artifact as an owner profile and
    emits a `tinycloud.auth.delegation` artifact to stdout. Local-key owner
    grants can use `--yes` for non-interactive approval.
  - `tc auth import <artifact>` installs delegation artifacts and preserves their
    originating request id.
  - `tc auth retry <requestId|--last> --exec` reruns the captured command once the
    requested permissions are covered.

  Local-key CLI profiles now persist and restore their TinyCloud session key
  identity so request artifacts target the same session key that later imports the
  delegation. `@tinycloud/node-sdk` now accepts runtime delegations targeted at the
  fragmentless form of the current session DID (`did:key:...`) as equivalent to
  the session verification method DID URL (`did:key:...#...`).

### Patch Changes

- Updated dependencies [9550c18]
  - @tinycloud/node-sdk@2.2.1-beta.1

## 0.5.1-beta.0

### Patch Changes

- 9ee7404: Harden encryption-network decrypt flows, add CLI secrets coverage, and fix web WASM initialization.
- Updated dependencies [9ee7404]
- Updated dependencies [f615a19]
  - @tinycloud/node-sdk@2.2.1-beta.0
  - @tinycloud/node-sdk-wasm@1.7.4-beta.0

## 0.5.0

### Minor Changes

- 9ff4b34: CLI: agent-friendly permission management and cross-space SQL.
  - `tc auth request` requests additional runtime permissions via the SDK's
    `grantRuntimePermissions` flow. Accepts `--cap <spec>`, `--permission <file>`,
    or `--manifest <fileOrBase64>`. OpenKey path forwards the requested entries
    through the `/delegate` URL so the consent UI shows what's being asked for.
  - `tc auth caps` lists appended runtime delegations and their granted
    capabilities. `--diff <spec>` reports whether the active session covers a
    capability without granting it. `--history` shows the audit log.
  - `tc manifest resolve <fileOrUrl>` is a read-only diagnostic that prints the
    effective space URI, capability paths, and SQL database basenames for an
    app manifest.
  - `tc sql query|execute|export --space <name|uri>` routes through a
    per-space SQL service so non-primary-space data is reachable. Backed by a
    new `TinyCloudNode.sqlForSpace(spaceId)` helper that mirrors the per-space
    KV factory pattern.
  - `tc sql copy --from-space S --from-db D --to-space S2 --to-db D2 [--table T...] [--dry-run]`
    copies rows between databases (optionally across spaces). Refuses self-copy.
  - AUTH_UNAUTHORIZED errors emit a copy-pasteable
    `tc auth request --cap "..."` hint derived from the unauthorized resource
    and required action.
  - NETWORK_ERROR emits a hint listing alternate profiles and their hosts when
    the active profile's host is unreachable.
  - `ProfileConfig.openkeyHost` (or `TC_OPENKEY_HOST` env var) overrides the
    OpenKey base URL per profile, enabling self-hosted or local OpenKey
    deployments for testing accounts. Default unchanged.
  - Persists appended runtime delegations alongside the existing session in
    `~/.tinycloud/profiles/<p>/additional-delegations.json` and replays them
    via `useRuntimeDelegation()` on next CLI invocation. Grants logged to
    `auth-grants.jsonl`.

  node-sdk: adds `TinyCloudNode.sqlForSpace(spaceId): ISQLService` so callers
  that already hold a delegation covering a non-primary space can issue SQL
  queries without restoring a fresh session.

- 9ff4b34: Default delegation lifetime bumped to 7 days; default session lifetime
  bumped to 7 days; CLI gains `tc auth request --expiry`.

  Why: 1-hour grants forced agent workflows to re-prompt the user for caps
  they had already approved on every CLI invocation past the first hour.
  The session itself defaulted to 1 hour too, so even an explicit
  `--expiry 30d` couldn't outlive its parent. Both defaults moved to 7
  days so the common agent loop runs unattended for a week.
  - `delegateToHelpers.resolveExpiryMs(undefined)` now returns
    `DEFAULT_DELEGATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000`.
  - `TinyCloudNodeConfig.sessionExpirationMs` default is now
    `DEFAULT_SESSION_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000`. Existing
    callers passing an explicit value are unaffected. Wallet-mode SIWE
    sessions cap at 1 hour by protocol — that limit is independent of
    this default.
  - `tc auth request --expiry <duration>` accepts a ms-format string
    (`"7d"`, `"30m"`) or raw millisecond integer. Forwarded to
    `node.grantRuntimePermissions(permissions, { expiry })` for the
    local-key path and encoded into the OpenKey `/delegate?expiry=...`
    URL parameter for the OpenKey path. OpenKey-side support landed
    separately in TinyCloudLabs/openkey.

### Patch Changes

- 010ee0f: Fix `restoreSession` so runtime-permission-grant operations work after
  session restore (notably the OpenKey-backed CLI path).

  `TinyCloudNode.restoreSession` populated `_serviceContext.session` (the
  `ServiceSession` used by service invokers) but never set
  `auth.tinyCloudSession` (the richer `TinyCloudSession` that surfaces the
  SIWE recap, address, chain, etc.). Methods that read from the latter —
  `hasRuntimePermissions`, `getRuntimePermissionDelegations`,
  `useRuntimeDelegation`, `grantRuntimePermissions` — therefore threw
  `SessionExpiredError(new Date(0))` immediately after every restore.

  Symptoms:
  - `tc auth request --cap …` fails with `Session expired at 1970-01-01T00:00:00.000Z`
  - Persisted runtime delegations replayed via `useRuntimeDelegation` are
    rejected, so `tc auth caps` reports `granted: []` even when
    `additional-delegations.json` has live entries.

  Changes:
  - `restoreSession` now accepts optional `siwe` and `signature` fields.
  - When `siwe` + `address` + `chainId` are provided, a full
    `TinyCloudSession` is rehydrated. In wallet mode it lands on
    `auth.tinyCloudSession` via the new
    `NodeUserAuthorization.setRestoredTinyCloudSession`. In session-only
    mode (no auth layer — typical for OpenKey-restored CLIs) it lands on
    a new `TinyCloudNode._restoredTcSession` field.
  - A new private `currentTinyCloudSession()` helper resolves the active
    session from either surface. The four runtime-permission readers
    (`hasRuntimePermissions`, `getRuntimePermissionDelegations`,
    `useRuntimeDelegation`, `grantRuntimePermissions`) now consult it.

  CLI side (`@tinycloud/cli`): `replayAdditionalDelegations` exposes a
  `TC_DEBUG_REPLAY=1` env switch that prints which stored delegations
  fail to install and why. Useful for diagnosing future restore-related
  issues.

  Backwards compatible: `restoreSession`'s new parameters are optional;
  old callers continue to work, they just don't get runtime-grant
  support until they pass `siwe`. The CLI was already passing `siwe` —
  the SDK was just dropping it.

- Updated dependencies [9ab4644]
- Updated dependencies [9ff4b34]
- Updated dependencies [0401ff8]
- Updated dependencies [04a0d5c]
- Updated dependencies [0e049d7]
- Updated dependencies [9dc2e8c]
- Updated dependencies [9ff4b34]
- Updated dependencies [9ff4b34]
- Updated dependencies [b9a24b5]
- Updated dependencies [6561589]
- Updated dependencies [010ee0f]
- Updated dependencies [8367cef]
- Updated dependencies [35212bb]
- Updated dependencies [46f126a]
- Updated dependencies [f43143d]
- Updated dependencies [78ef7eb]
  - @tinycloud/node-sdk@2.2.0
  - @tinycloud/node-sdk-wasm@1.7.3

## 0.5.0-beta.13

### Patch Changes

- @tinycloud/node-sdk@2.2.0-beta.13

## 0.5.0-beta.12

### Patch Changes

- 010ee0f: Fix `restoreSession` so runtime-permission-grant operations work after
  session restore (notably the OpenKey-backed CLI path).

  `TinyCloudNode.restoreSession` populated `_serviceContext.session` (the
  `ServiceSession` used by service invokers) but never set
  `auth.tinyCloudSession` (the richer `TinyCloudSession` that surfaces the
  SIWE recap, address, chain, etc.). Methods that read from the latter —
  `hasRuntimePermissions`, `getRuntimePermissionDelegations`,
  `useRuntimeDelegation`, `grantRuntimePermissions` — therefore threw
  `SessionExpiredError(new Date(0))` immediately after every restore.

  Symptoms:
  - `tc auth request --cap …` fails with `Session expired at 1970-01-01T00:00:00.000Z`
  - Persisted runtime delegations replayed via `useRuntimeDelegation` are
    rejected, so `tc auth caps` reports `granted: []` even when
    `additional-delegations.json` has live entries.

  Changes:
  - `restoreSession` now accepts optional `siwe` and `signature` fields.
  - When `siwe` + `address` + `chainId` are provided, a full
    `TinyCloudSession` is rehydrated. In wallet mode it lands on
    `auth.tinyCloudSession` via the new
    `NodeUserAuthorization.setRestoredTinyCloudSession`. In session-only
    mode (no auth layer — typical for OpenKey-restored CLIs) it lands on
    a new `TinyCloudNode._restoredTcSession` field.
  - A new private `currentTinyCloudSession()` helper resolves the active
    session from either surface. The four runtime-permission readers
    (`hasRuntimePermissions`, `getRuntimePermissionDelegations`,
    `useRuntimeDelegation`, `grantRuntimePermissions`) now consult it.

  CLI side (`@tinycloud/cli`): `replayAdditionalDelegations` exposes a
  `TC_DEBUG_REPLAY=1` env switch that prints which stored delegations
  fail to install and why. Useful for diagnosing future restore-related
  issues.

  Backwards compatible: `restoreSession`'s new parameters are optional;
  old callers continue to work, they just don't get runtime-grant
  support until they pass `siwe`. The CLI was already passing `siwe` —
  the SDK was just dropping it.

- Updated dependencies [0e049d7]
- Updated dependencies [010ee0f]
- Updated dependencies [f43143d]
  - @tinycloud/node-sdk-wasm@1.7.3-beta.2
  - @tinycloud/node-sdk@2.2.0-beta.12

## 0.5.0-beta.11

### Minor Changes

- 9ff4b34: CLI: agent-friendly permission management and cross-space SQL.
  - `tc auth request` requests additional runtime permissions via the SDK's
    `grantRuntimePermissions` flow. Accepts `--cap <spec>`, `--permission <file>`,
    or `--manifest <fileOrBase64>`. OpenKey path forwards the requested entries
    through the `/delegate` URL so the consent UI shows what's being asked for.
  - `tc auth caps` lists appended runtime delegations and their granted
    capabilities. `--diff <spec>` reports whether the active session covers a
    capability without granting it. `--history` shows the audit log.
  - `tc manifest resolve <fileOrUrl>` is a read-only diagnostic that prints the
    effective space URI, capability paths, and SQL database basenames for an
    app manifest.
  - `tc sql query|execute|export --space <name|uri>` routes through a
    per-space SQL service so non-primary-space data is reachable. Backed by a
    new `TinyCloudNode.sqlForSpace(spaceId)` helper that mirrors the per-space
    KV factory pattern.
  - `tc sql copy --from-space S --from-db D --to-space S2 --to-db D2 [--table T...] [--dry-run]`
    copies rows between databases (optionally across spaces). Refuses self-copy.
  - AUTH_UNAUTHORIZED errors emit a copy-pasteable
    `tc auth request --cap "..."` hint derived from the unauthorized resource
    and required action.
  - NETWORK_ERROR emits a hint listing alternate profiles and their hosts when
    the active profile's host is unreachable.
  - `ProfileConfig.openkeyHost` (or `TC_OPENKEY_HOST` env var) overrides the
    OpenKey base URL per profile, enabling self-hosted or local OpenKey
    deployments for testing accounts. Default unchanged.
  - Persists appended runtime delegations alongside the existing session in
    `~/.tinycloud/profiles/<p>/additional-delegations.json` and replays them
    via `useRuntimeDelegation()` on next CLI invocation. Grants logged to
    `auth-grants.jsonl`.

  node-sdk: adds `TinyCloudNode.sqlForSpace(spaceId): ISQLService` so callers
  that already hold a delegation covering a non-primary space can issue SQL
  queries without restoring a fresh session.

- 9ff4b34: Default delegation lifetime bumped to 7 days; default session lifetime
  bumped to 7 days; CLI gains `tc auth request --expiry`.

  Why: 1-hour grants forced agent workflows to re-prompt the user for caps
  they had already approved on every CLI invocation past the first hour.
  The session itself defaulted to 1 hour too, so even an explicit
  `--expiry 30d` couldn't outlive its parent. Both defaults moved to 7
  days so the common agent loop runs unattended for a week.
  - `delegateToHelpers.resolveExpiryMs(undefined)` now returns
    `DEFAULT_DELEGATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000`.
  - `TinyCloudNodeConfig.sessionExpirationMs` default is now
    `DEFAULT_SESSION_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000`. Existing
    callers passing an explicit value are unaffected. Wallet-mode SIWE
    sessions cap at 1 hour by protocol — that limit is independent of
    this default.
  - `tc auth request --expiry <duration>` accepts a ms-format string
    (`"7d"`, `"30m"`) or raw millisecond integer. Forwarded to
    `node.grantRuntimePermissions(permissions, { expiry })` for the
    local-key path and encoded into the OpenKey `/delegate?expiry=...`
    URL parameter for the OpenKey path. OpenKey-side support landed
    separately in TinyCloudLabs/openkey.

### Patch Changes

- Updated dependencies [9ff4b34]
- Updated dependencies [9ff4b34]
- Updated dependencies [9ff4b34]
  - @tinycloud/node-sdk@2.2.0-beta.11

## 0.4.8-beta.10

### Patch Changes

- Updated dependencies [35212bb]
  - @tinycloud/node-sdk@2.2.0-beta.10

## 0.4.8-beta.9

### Patch Changes

- Updated dependencies [78ef7eb]
  - @tinycloud/node-sdk@2.2.0-beta.9

## 0.4.8-beta.8

### Patch Changes

- Updated dependencies [8367cef]
  - @tinycloud/node-sdk@2.2.0-beta.8

## 0.4.8-beta.7

### Patch Changes

- Updated dependencies [46f126a]
  - @tinycloud/node-sdk@2.2.0-beta.7

## 0.4.8-beta.6

### Patch Changes

- Updated dependencies [b9a24b5]
  - @tinycloud/node-sdk@2.2.0-beta.6

## 0.4.8-beta.5

### Patch Changes

- Updated dependencies [9ab4644]
- Updated dependencies [9dc2e8c]
  - @tinycloud/node-sdk@2.2.0-beta.5
  - @tinycloud/node-sdk-wasm@1.7.3-beta.1

## 0.4.8-beta.4

### Patch Changes

- Updated dependencies [0401ff8]
  - @tinycloud/node-sdk@2.2.0-beta.4

## 0.4.8-beta.3

### Patch Changes

- @tinycloud/node-sdk@2.2.0-beta.3

## 0.4.8-beta.2

### Patch Changes

- Updated dependencies [04a0d5c]
  - @tinycloud/node-sdk@2.2.0-beta.2

## 0.4.8-beta.1

### Patch Changes

- @tinycloud/node-sdk@2.2.0-beta.1

## 0.4.8-beta.0

### Patch Changes

- Updated dependencies [6561589]
  - @tinycloud/node-sdk@2.2.0-beta.0
  - @tinycloud/node-sdk-wasm@1.7.3-beta.0

## 0.4.7

### Patch Changes

- fa130e0: Improve `tc sql` help output with SQLite workflow examples, parameter binding guidance, named database usage, and documented query/execute/export output shapes.
- Updated dependencies [303a8eb]
- Updated dependencies [8abfb4e]
- Updated dependencies [b55ffbd]
- Updated dependencies [b88728a]
- Updated dependencies [c586568]
- Updated dependencies [9dad135]
- Updated dependencies [4fac901]
- Updated dependencies [9a9fae1]
- Updated dependencies [fb1d3fd]
- Updated dependencies [61c031d]
  - @tinycloud/node-sdk@2.1.0
  - @tinycloud/node-sdk-wasm@1.7.2

## 0.4.7-beta.7

### Patch Changes

- Updated dependencies [4fac901]
  - @tinycloud/node-sdk@2.1.0-beta.6

## 0.4.7-beta.6

### Patch Changes

- fa130e0: Improve `tc sql` help output with SQLite workflow examples, parameter binding guidance, named database usage, and documented query/execute/export output shapes.

## 0.4.7-beta.5

### Patch Changes

- Updated dependencies [303a8eb]
  - @tinycloud/node-sdk@2.1.0-beta.5

## 0.4.7-beta.4

### Patch Changes

- Updated dependencies [c586568]
  - @tinycloud/node-sdk@2.1.0-beta.4

## 0.4.7-beta.3

### Patch Changes

- Updated dependencies [b88728a]
  - @tinycloud/node-sdk@2.1.0-beta.3

## 0.4.7-beta.2

### Patch Changes

- Updated dependencies [9dad135]
  - @tinycloud/node-sdk@2.1.0-beta.2
  - @tinycloud/node-sdk-wasm@1.7.2-beta.2

## 0.4.7-beta.1

### Patch Changes

- Updated dependencies [8abfb4e]
  - @tinycloud/node-sdk@2.1.0-beta.1
  - @tinycloud/node-sdk-wasm@1.7.2-beta.1

## 0.4.7-beta.0

### Patch Changes

- Updated dependencies [b55ffbd]
- Updated dependencies [9a9fae1]
- Updated dependencies [61c031d]
  - @tinycloud/node-sdk-wasm@1.7.2-beta.0
  - @tinycloud/node-sdk@2.1.0-beta.0

## 0.4.6-beta.0

### Patch Changes

- Updated dependencies [fb1d3fd]
  - @tinycloud/node-sdk@2.0.4-beta.0

## 0.4.5

### Patch Changes

- Updated dependencies [e7e6ee7]
- Updated dependencies [1379b11]
- Updated dependencies [e422647]
  - @tinycloud/node-sdk@2.0.3
  - @tinycloud/node-sdk-wasm@1.7.1

## 0.4.5-beta.2

### Patch Changes

- Updated dependencies [1379b11]
- Updated dependencies [e422647]
  - @tinycloud/node-sdk@2.0.3-beta.3

## 0.4.5-beta.1

### Patch Changes

- @tinycloud/node-sdk@2.0.3-beta.2

## 0.4.5-beta.0

### Patch Changes

- Updated dependencies [e7e6ee7]
  - @tinycloud/node-sdk@2.0.3-beta.0

## 0.4.4

### Patch Changes

- Updated dependencies [3401b3c]
  - @tinycloud/node-sdk@2.0.2

## 0.4.3

### Patch Changes

- 99219f8: Read version from package.json instead of hardcoding
  - @tinycloud/node-sdk@2.0.1

## 0.4.2

### Patch Changes

- Updated dependencies [6eebc29]
  - @tinycloud/node-sdk@2.0.0

## 0.4.1

### Patch Changes

- 3c82019: Add local Ethereum key authentication to `tc auth login`. Users can now choose between OpenKey (browser-based) and local key (Ethereum private key) auth methods. Local key auth generates a `did:pkh` identity and signs in directly without a browser, making it suitable for agents, CI/CD, and headless environments. Use `--method local` to skip the interactive prompt.

## 0.4.0

### Minor Changes

- f841493: Add `tc upgrade` command for self-updating the CLI to the latest published version. Detects the package manager used for the global install (bun or npm) and runs the appropriate upgrade command.

## 0.3.1

### Patch Changes

- Updated dependencies [8649de8]
- Updated dependencies [def099d]
  - @tinycloud/node-sdk-wasm@1.7.0
  - @tinycloud/node-sdk@1.7.0

## 0.3.0

### Minor Changes

- 153e9bb: Add `tc sql` and `tc duckdb` command groups to the CLI. SQL commands support `query`, `execute`, and `export`. DuckDB commands support `query`, `execute`, `describe`, `export`, and `import`. Both command groups accept `--db` for named databases and `--params` for bind parameters.

### Patch Changes

- Updated dependencies [db50ae4]
- Updated dependencies [bea6063]
  - @tinycloud/node-sdk@1.6.0
  - @tinycloud/node-sdk-wasm@1.6.0

## 0.2.0

### Minor Changes

- 349ae57: Add `tc secrets` and `tc vars` CLI commands for managing encrypted secrets (vault) and plaintext variables (KV) with `secrets/` and `variables/` prefixes.
- 8c08161: Updated CLI with usability improvements

### Patch Changes

- 96ce2b3: Add `tc secrets manage` command to open the Secrets Manager web UI and `--space` flag for cross-space secret listing
  - @tinycloud/node-sdk@1.5.0

## 0.1.1

### Patch Changes

- Updated dependencies [da5a499]
  - @tinycloud/node-sdk-wasm@1.4.1
  - @tinycloud/node-sdk@1.4.1

## 0.1.0

### Minor Changes

- fd25623: Add browser-based delegate auth flow for CLI login via OpenKey. The CLI opens a `/delegate` page where users authenticate with a passkey, select a key, and approve a delegation. `TinyCloudNode.restoreSession()` allows injecting stored delegation data without a private key. Also fixes `kv list` result parsing and CLI process hang after auth.

### Patch Changes

- Updated dependencies [fd25623]
  - @tinycloud/node-sdk@1.4.0

## 0.0.2

### Patch Changes

- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
- Updated dependencies [94ad509]
  - @tinycloud/node-sdk@1.3.0

## 0.0.1

### Patch Changes

- fe83edb: Initial release
- Updated dependencies [2014a20]
- Updated dependencies [bcbebbe]
- Updated dependencies [ca9b2c6]
  - @tinycloud/node-sdk@1.2.0
