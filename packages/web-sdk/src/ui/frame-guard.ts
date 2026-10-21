/**
 * Top-level page only. The TinyCloud UI never renders inside an iframe or an
 * opaque origin (sandboxed, data:, srcdoc). Evaluated at registration and at
 * every open(); never cached.
 */
export function canRenderUi(): boolean {
  try {
    if (typeof window === "undefined" || typeof document === "undefined") return false;
    if (window.top !== window) return false; // any iframe, same- or cross-origin
    if (window.location.origin === "null") return false; // opaque origin
    return true;
  } catch {
    return false; // a throwing guard means do not render
  }
}
