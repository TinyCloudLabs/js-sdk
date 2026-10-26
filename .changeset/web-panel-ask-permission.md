---
"@tinycloud/web-sdk": minor
---

The Delegations tab of the TinyCloud panel has an "Allow delegation list" button when the session cannot list delegations and the page can show the SDK's permission prompt (a page signer and a manifest). It asks for `tinycloud.delegation/list` on the app's own space only, for up to 7 days (the SDK shortens it to the session's expiry), and reloads the tab when approved. The node answers a `delegation/list` proof for any of the owner's spaces with the whole account's delegation list, so the tab says the list covers every app and link across the account and shows no keys or contents. A decline leaves the tab as it was; an error shows a short error line. Without a page signer or manifest the tab keeps its text and tells the user to sign in again.

The granted permission is kept with the stored session record and registered again when the session is restored after a reload. A sign-out, a new sign-in or the session's expiry removes it, and an expired grant or one issued to another session key is not registered again. `BrowserSessionStorage` has `saveRuntimeGrants` and `loadRuntimeGrants` for this.

New `ui.platform` option: `"web"` (default) or `"native"`. With `"native"` the Delegations tab shows the button disabled with an explanation, because a desktop or mobile shell cannot show the permission prompt from the page.

Details: TC-2113
