---
"@tinycloud/sdk-core": patch
---

Policy root revocations (`revokePolicyRootV3`) are stamped in whole seconds. The Node refuses a revocation time it can't reproduce exactly, and its formatter drops trailing zeros from the fraction, so about one revocation in ten (any stamped at a millisecond ending in 0) was refused with `403 root-revocation-time-invalid` (TC-601). Share's Revoke button and `tc share revoke` both use this function.
