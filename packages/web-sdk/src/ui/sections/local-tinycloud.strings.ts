/**
 * Copy for the Local TinyCloud section. Keys are prefixed with the section id
 * so they cannot clash with strings.ts or another section. Registered by the
 * section module at load.
 */
export const LOCAL_TINYCLOUD_STRINGS = {
  "local-tinycloud.summary": "Use a TinyCloud node on this computer",
  "local-tinycloud.intro":
    "Use a TinyCloud that runs on this computer, next to your browser, instead of only your hosted one.",
  "local-tinycloud.switch": "Use TinyCloud on this computer",
  "local-tinycloud.switch.on": "On",
  "local-tinycloud.switch.off": "Off",
  "local-tinycloud.sub.off": "Off for this app",
  "local-tinycloud.sub.looking": "Checking this computer…",
  "local-tinycloud.sub.found": "Connected to a TinyCloud on this computer",
  "local-tinycloud.sub.not_found": "Switched on, but nothing answered",
  "local-tinycloud.sub.unavailable": "Not available in this app yet",
  "local-tinycloud.app_fallback": "This app",
  "local-tinycloud.glance.found": "Found",
  "local-tinycloud.glance.looking": "Looking",
  "local-tinycloud.glance.not_found": "Not found",
  "local-tinycloud.glance.off": "Off",
  "local-tinycloud.off.body":
    "{app} talks to your hosted TinyCloud only. Turn this on and it looks for a TinyCloud running on this computer.",
  "local-tinycloud.looking.title": "Looking for TinyCloud on this computer…",
  "local-tinycloud.looking.permission":
    "Your browser may ask to let {app} reach devices on your network. Allow it so the check can finish.",
  "local-tinycloud.looking.cancel": "Cancel",
  "local-tinycloud.found.recheck": "Check again",
  "local-tinycloud.found.node_id": "Node ID",
  "local-tinycloud.found.version": "Version",
  "local-tinycloud.found.host": "Host",
  "local-tinycloud.unknown": "Unknown",
  "local-tinycloud.copy.node_id_label": "Copy node ID",
  "local-tinycloud.copy.host_label": "Copy host",
  "local-tinycloud.copy.command_label": "Copy command",
  "local-tinycloud.copied": "Copied",
  "local-tinycloud.copy_failed": "Couldn't copy. Select the text and copy it by hand.",
  "local-tinycloud.not_found.title": "We couldn't find TinyCloud on this computer.",
  "local-tinycloud.not_found.unchanged": "Nothing has changed: {app} still uses your hosted TinyCloud.",
  "local-tinycloud.not_found.steps_title": "To start it",
  "local-tinycloud.not_found.step_open": "Open TinyCloud on this computer, or start it from a terminal.",
  "local-tinycloud.not_found.step_command": "tinycloud start",
  "local-tinycloud.not_found.step_listen": "Check that it's listening on 127.0.0.1:8787.",
  "local-tinycloud.not_found.step_retry": "Come back here and choose Try again.",
  "local-tinycloud.not_found.retry": "Try again",
  "local-tinycloud.unavailable.line": "Local TinyCloud can't be checked from this app.",
  "local-tinycloud.unavailable.explain":
    "This app can't turn TinyCloud on this computer on or off yet, so the switch is off.",
  "local-tinycloud.error": "Couldn't change TinyCloud on this computer. Try again.",
} as const satisfies Readonly<Record<string, string>>;
