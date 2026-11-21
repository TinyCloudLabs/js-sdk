---
"@tinycloud/sdk-core": patch
"@tinycloud/web-sdk": patch
---

Browser sign-in through OpenKey's versioned approval works in bundles that do not provide Node's `Buffer`. `extractRecapAttenuations` decodes the signed message's recap with `atob` and `TextDecoder`; a recap payload that is not valid base64 is refused with the same "Failed to decode urn:recap: payload" error.

Details: TC-3639
