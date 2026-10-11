export const CLEAR_PENDING_WARNING =
  "Clearing pending writes surrenders read-your-writes protection for the cleared keys. If a write whose record was cleared had an unknown outcome or never finished, it may commit now or later; this device can serve an older value until the next sync after that commit, as it would for a write from another device.";
