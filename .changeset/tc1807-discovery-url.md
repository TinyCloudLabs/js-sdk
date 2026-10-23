---
"@tinycloud/web-sdk": patch
---

The default credential discovery URL is now `https://witness.credentials.org/.well-known/opencredentials`. A 2xx discovery response whose body is not JSON now rejects with a typed error whose `code` is `CREDENTIAL_DISCOVERY_FAILED`, carrying `host`, `status`, and `contentType`, instead of a raw parse error. A 503 still rejects with `ISSUER_UNREADY`, and other non-2xx responses and network failures still reject with `OFFLINE`.

Details: TC-1807
