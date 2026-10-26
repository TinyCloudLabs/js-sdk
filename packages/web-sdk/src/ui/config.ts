/** Accepted `ui.position` values. Each `top-*` value places at the matching bottom position. */
export type UiPosition =
  | "top-right"
  | "top-left"
  | "top-center"
  | "bottom-right"
  | "bottom-left"
  | "bottom-center";

type BottomPosition = "bottom-right" | "bottom-left" | "bottom-center";

/**
 * Which layouts the settings panel offers. `"both"` (default) opens the sidebar
 * with an "Open full page" switch. `"sidebar"` offers the sidebar only. `"page"`
 * opens the full page directly.
 */
export type UiMode = "sidebar" | "page" | "both";

/**
 * Where the app runs. `"web"` (default) is a browser page with its own wallet signer. `"native"` is a
 * desktop or mobile shell that cannot show the permission prompt in the page: the panel then explains
 * that and offers no working "allow" button.
 */
export type UiPlatform = "web" | "native";

/** Config passed as `ui` on TinyCloudWeb. `ui: false` disables the UI entirely (see index.ts). */
export interface UiConfig {
  /** Default true. false hides the button only; the panel, prompts, and open() still work. */
  button?: boolean;
  /** Default true. false shows no toasts and stops the unhandled-rejection listener. Prompts still render. */
  toasts?: boolean;
  /** Default false. Shows the developer section when true. */
  developerMode?: boolean;
  /** Default "bottom-right". */
  position?: UiPosition;
  /** Explicit identity for the hide flag when no manifest is set. */
  appId?: string;
  /** Default "both". Which layouts the panel offers. */
  mode?: UiMode;
  /** Default "web". Set "native" in a desktop or mobile shell, where the panel cannot ask for a permission itself. */
  platform?: UiPlatform;
}

export interface ResolvedUiConfig {
  readonly button: boolean;
  readonly toasts: boolean;
  readonly developerMode: boolean;
  readonly position: BottomPosition;
  readonly appId: string | undefined;
  readonly mode: UiMode;
  readonly platform: UiPlatform;
}

const PLACEMENT: Record<UiPosition, BottomPosition> = {
  "top-right": "bottom-right",
  "top-left": "bottom-left",
  "top-center": "bottom-center",
  "bottom-right": "bottom-right",
  "bottom-left": "bottom-left",
  "bottom-center": "bottom-center",
};

export function resolveUiConfig(ui: UiConfig | undefined): ResolvedUiConfig {
  const requested = ui?.position;
  const position: BottomPosition =
    requested !== undefined && Object.prototype.hasOwnProperty.call(PLACEMENT, requested)
      ? PLACEMENT[requested]
      : "bottom-right";
  return {
    button: ui?.button !== false,
    toasts: ui?.toasts !== false,
    developerMode: ui?.developerMode === true,
    position,
    appId: ui?.appId,
    mode: ui?.mode === "sidebar" || ui?.mode === "page" ? ui.mode : "both",
    platform: ui?.platform === "native" ? "native" : "web",
  };
}
