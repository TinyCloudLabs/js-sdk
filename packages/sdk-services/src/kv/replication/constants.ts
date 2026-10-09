export const CLEAR_PENDING_WARNING =
  "Clearing pending writes stops pinning keys whose last write had an unknown outcome or never finished. If such a write did commit, or commits later, this device can serve the older value for that key until the next sync after the commit, as it would for a write from another device.";
