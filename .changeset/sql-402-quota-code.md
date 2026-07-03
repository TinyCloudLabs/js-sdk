---
"@tinycloud/sdk-services": patch
---

fix(sdk-services): map SQL 402 responses to SQL_QUOTA_EXCEEDED

The node returns a plain-text `402 Payment Required` for a storage-quota-exceeded
SQL write, but `SQLService.mapHttpStatusToErrorCode` had no 402 case, so the
error fell through to `NETWORK_ERROR`. Apps switching on the error code
mishandled SQL quota errors (KV already maps 402 correctly). Map 402 to
`SQL_QUOTA_EXCEEDED`, matching the existing 429 case.
