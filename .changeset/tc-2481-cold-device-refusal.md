---
"@tinycloud/sdk-core": patch
"@tinycloud/operations": patch
---

Refuse live routing when storage settings cannot be reached and none are saved on the device, instead of selecting a configured or default server. Preserve first-time onboarding after a reachable, genuine no-entry response and the existing verified-cache fallback strictly younger than one hour. Keep the registry-unavailable error code and provide a value-free explanation for the cold-device refusal.

Compatibility: applications that previously continued on a default server during a cold outage must retry after storage settings are reachable. Offline session inspection remains local-only; this change does not add network access to restore or relax server-side verification.

Details: TC-2481
