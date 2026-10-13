---
"@tinycloud/cli": patch
---

The browser login's local callback is narrower (TC-1058). It now:
- listens on an unguessable `/callback/<random>` path;
- answers only requests whose `Origin` is OpenKey's (others, including requests with no `Origin`, get 403);
- refuses bodies over 1 MiB (413);
- ignores a structurally invalid or foreign request without ending the login;
- closes any held-open connection once the login settles, so a stray socket can't keep `tc` running.

This doesn't authenticate the sender: a local process that learns the path, which appears in the printed URL and the browser's command line, can forge the header and send a well-formed payload. At worst that ends the login with a proof error, because the CLI verifies OpenKey's signed proof before saving anything. Binding each approval to one login attempt needs an OpenKey nonce.

When a login (browser, paste or device) first pins a profile's owner and you didn't pass `--owner`, the CLI now prints that owner on stderr. Plain `auth login --method openkey` also reports `ownerDid` in its JSON.
