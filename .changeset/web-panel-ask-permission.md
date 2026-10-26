---
"@tinycloud/web-sdk": minor
---

The Delegations tab of the TinyCloud panel has an "Allow delegation list" button when the session cannot list delegations and the page can show the SDK's permission prompt (a page signer and a manifest). It asks for `tinycloud.delegation/list` on the app's own space only, for up to 7 days (the SDK shortens it to the session's expiry), and reloads the tab when approved. The node answers a `delegation/list` proof for any of the owner's spaces with the whole account's delegation list, so the tab says the list covers every app and link across the account and shows no keys or contents. A decline leaves the tab as it was; an error shows a short error line. Without a page signer or manifest the tab keeps its text and tells the user to sign in again.

The permission the panel requests is kept with the stored session record and activated again when the session is restored after a reload. Only the panel's own grant is kept: a grant that is anything more than that one entry (for example an app's larger grant that already covered the request) is not stored. On restore each grant is verified from its signed bytes (CID, expiry, audience and abilities come from the signature, not from stored fields) and must be exactly the panel's entry. A grant the node refuses for good is removed (expired, issued to another session key, rejected by the node); a grant that failed because the node could not be reached or answered 408, 429 or 5xx is kept for the next reload. A sign-out, a new sign-in or the session's expiry removes them. A storage or node failure at this step never fails the restore, and the restore waits at most 4 seconds for the node. `BrowserSessionStorage` has `saveRuntimeGrants` and `loadRuntimeGrants` for this; neither rejects.

New `ui.platform` option: `"web"` (default) or `"native"`. With `"native"` the Delegations tab shows the button disabled with an explanation, because a desktop or mobile shell cannot show the permission prompt from the page.

Details: TC-2113
