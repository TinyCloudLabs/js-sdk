/**
 * Id of the settings panel element. The launcher's aria-controls, the eager
 * pending element, and the lazy panel all use it. Lives outside button.ts and
 * panel.ts so the lazy panel chunk does not bundle the launcher.
 */
export const PANEL_ID = "tinycloud-ui-panel";
