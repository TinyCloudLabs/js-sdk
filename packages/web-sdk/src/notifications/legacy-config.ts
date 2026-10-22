import type { UiConfig, UiPosition } from "../ui/config";

/**
 * Removed `notifications` keys, read only by JS callers that still pass them.
 * They are mapped onto `ui` and warned about once per page load.
 */
interface LegacyNotifications {
  popups?: unknown;
  position?: unknown;
  duration?: unknown;
  maxVisible?: unknown;
}

const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  try {
    console.warn(`[tinycloud] notifications.${key} ${message} (code: legacy-notification-key)`);
  } catch {
    // A failing console must never stop client construction.
  }
}

/**
 * Returns a shallow copy of `config` with legacy `notifications` keys mapped onto `ui`.
 * `popups: false` maps to `{ button: false, toasts: false }`, so SDK prompts still render.
 * The caller's object is never mutated. An explicit `ui` always wins over a legacy key.
 */
export function applyLegacyNotificationKeys<T extends { ui?: UiConfig | false; notifications?: object }>(
  config: T,
): T {
  const legacy = config.notifications as LegacyNotifications | undefined;
  if (!legacy) return config;
  const { popups, position, duration, maxVisible } = legacy;
  if (popups !== undefined) warnOnce("popups", "is deprecated, use ui");
  if (position !== undefined) warnOnce("position", "is deprecated, use ui.position");
  if (duration !== undefined) warnOnce("duration", "was removed and is ignored");
  if (maxVisible !== undefined) warnOnce("maxVisible", "was removed and is ignored");

  let ui = config.ui;
  if (popups === false && ui === undefined) ui = { button: false, toasts: false };
  if (position !== undefined && ui !== false && ui?.position === undefined) {
    ui = { ...ui, position: position as UiPosition };
  }
  return { ...config, ui };
}
