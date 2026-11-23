/**
 * Lifetime of an owner session, and of a runtime grant, that operations (and the MCP server,
 * which runs on it) sign without an explicit expiry. Owner tools keep 30 days; the SDK's own
 * default (`EXPIRY.SESSION_MS`) is shorter, so every call that would fall back to it passes this.
 */
export const OWNER_SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
