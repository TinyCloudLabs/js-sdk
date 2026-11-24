---
"@tinycloud/web-sdk": patch
---

Browser sign-in through OpenKey's versioned approval works in bundles that do not provide Node's `Buffer`. `extractRecapAttenuations` decodes the signed message's recap with `atob` and `TextDecoder`; a recap payload that is not valid base64 is refused with the error "Failed to decode urn:recap: payload".

Details: TC-3639
