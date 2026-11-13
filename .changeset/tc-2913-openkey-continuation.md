---
"@tinycloud/sdk-core": patch
"@tinycloud/node-sdk": minor
"@tinycloud/web-sdk": minor
---

Use OpenKey's advertised continuation API from the public signIn click to reserve one window before asynchronous preparation. Prepare, verify and complete the session with the request-pinned identity, preserving the configured manifest and validating the signed result before activation. Older clients and servers retain the existing authorization path.

Reject noncanonical SIWE and ReCap encodings during OpenKey verification. Custom WASM bindings must provide the strict parseVerifiedRecapFromSiwe verifier for ReCap sign-in.

Details: TC-2913
