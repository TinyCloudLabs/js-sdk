export type UiPosition = "bottom-right" | "bottom-left" | "bottom-center";

/** Config passed as `ui` on TinyCloudWeb. `ui: false` disables the UI entirely (see index.ts). */
export interface UiConfig {
  /** Default true. false hides the button; toasts, prompts, and open() still work. */
  button?: boolean;
  /** Default false. Shows the developer section when true. */
  developerMode?: boolean;
  /** Default "bottom-right". */
  position?: UiPosition;
  /** Explicit identity for the hide flag when no manifest is set. */
  appId?: string;
}

export interface ResolvedUiConfig {
  readonly button: boolean;
  readonly developerMode: boolean;
  readonly position: UiPosition;
  readonly appId: string | undefined;
}

const POSITIONS: Record<UiPosition, true> = {
  "bottom-right": true,
  "bottom-left": true,
  "bottom-center": true,
};

export function resolveUiConfig(ui: UiConfig | undefined): ResolvedUiConfig {
  const requested = ui?.position;
  const position: UiPosition =
    requested !== undefined && Object.prototype.hasOwnProperty.call(POSITIONS, requested)
      ? requested
      : "bottom-right";
  return {
    button: ui?.button !== false,
    developerMode: ui?.developerMode === true,
    position,
    appId: ui?.appId,
  };
}
