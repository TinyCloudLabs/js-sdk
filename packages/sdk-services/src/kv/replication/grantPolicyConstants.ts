/** Grant lifetime constants without browser storage identifiers. */
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Default device-grant lifetime from install (24 h). All durations are milliseconds. */
export const DEFAULT_GRANT_TTL_MS = DAY_MS;
/** `grantTtlMs` above this (7 d) is a config error: TypeError at construction. */
export const MAX_GRANT_TTL_MS = 7 * DAY_MS;
/** Consent deadline = consent anchor + this window (7 d). */
export const CONSENT_WINDOW_MS = 7 * DAY_MS;
/** Silent renewal starts when remaining effective lifetime < this fraction of the effective lifetime. */
export const RENEW_BELOW_FRACTION = 0.25;
