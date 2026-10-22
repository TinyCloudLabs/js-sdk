/** Accepted `ui.position` values. Each `top-*` value places at the matching bottom position. */
export type UiPosition =
  | "top-right"
  | "top-left"
  | "top-center"
  | "bottom-right"
  | "bottom-left"
  | "bottom-center";

type BottomPosition = "bottom-right" | "bottom-left" | "bottom-center";

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
}

export interface ResolvedUiConfig {
  readonly button: boolean;
  readonly toasts: boolean;
  readonly developerMode: boolean;
  readonly position: BottomPosition;
  readonly appId: string | undefined;
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
  };
}
