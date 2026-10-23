---
"@tinycloud/web-sdk": patch
---

The default credential discovery URL is now `https://witness.credentials.org/.well-known/opencredentials`. Discovery responses that are non-2xx or not JSON now reject with a typed error whose `code` is `CREDENTIAL_DISCOVERY_FAILED`, instead of a raw parse error or `ISSUER_UNREADY`/`OFFLINE`. Network failures still reject with `OFFLINE`. Details: TC-1807
