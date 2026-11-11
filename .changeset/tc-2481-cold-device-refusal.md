---
"@tinycloud/sdk-core": patch
"@tinycloud/operations": patch
"@tinycloud/sdk-services": patch
"@tinycloud/node-sdk": patch
"@tinycloud/cli": patch
"@tinycloud/replica": patch
---

Refuse live routing when storage settings cannot be reached and none are saved on the device, instead of selecting a configured or default server. Preserve first-time onboarding after a reachable, genuine no-entry response and the existing verified-cache fallback strictly younger than one hour. Keep the registry-unavailable error code and provide a value-free explanation for the cold-device refusal.

Compatibility: applications that previously continued on a default server during a cold outage must retry after storage settings are reachable. Offline session inspection remains local-only; this change does not add network access to restore or relax server-side verification.

Preserve typed routing failures through vault deletion and listing instead of reporting missing keys or generic storage errors. Secret get, put, delete and list now share the value-free `REGISTRY_UNAVAILABLE` CLI projection for unreachable storage settings, including the cold-device explanation; genuine HTTP authorization refusals, missing keys and other storage failures retain their existing classification.

Restore validated local replicas from the persisted session and host hints, retaining the existing capability check. Actual network operations still use current storage settings, including the cold-device refusal.

Classify the explicit no-saved-settings refusal as offline for replica synchronization, after HTTP and authority denials. Complete local reads retain consent, installed-grant and committed-write checks; unverifiable settings and revocation signals still prevent stale local delivery.

Details: TC-2481
