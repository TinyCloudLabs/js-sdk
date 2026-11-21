---
"@tinycloud/web-sdk": minor
---

Outside apps that use OpenKey can now offer TinyCloud setup in one tap when their sign-in refuses a brand-new account. The app's own error handler calls `tcw.handleAccountSetupRequired(error, { requestingApp })` after it catches `AccountSetupRequiredError`; the SDK invokes OpenKey's `authorizeTinyCloudSetup`, which shows the consent screen in a top-level OpenKey popup and (on the owner's tap) signs and publishes the owner's registry location record under their own `did:pkh`. The SDK then retries the sign-in. The outside app never sees the signed record, never influences the node selection, and never supplies the requesting origin; all three live inside OpenKey. A 24-hour per-owner-per-outside-app throttle in `localStorage` prevents the same app from re-showing the setup prompt for the same account more than once a day.

The SDK slice ships on its own: when OpenKey hasn't shipped the `authorizeTinyCloudSetup` endpoint yet, the handler returns `"no-openkey"` and the outside app falls back to the existing `AccountSetupRequiredError.setupUrl` (Home + `?finish-setup=registry`, from TC-3547).

Details: TC-3657.
