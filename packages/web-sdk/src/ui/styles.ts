/**
 * Launcher stylesheet for the open shadow root. Eager: the only CSS the root
 * injects before the panel loads. Panel rules live in panel-styles.ts and
 * ship in the lazy panel chunk. One inline string, no fonts, no
 * adoptedStyleSheets. Neutral palette only. Offsets are CSS custom properties
 * so an app can reserve space without an API.
 */
// Colours follow the TinyCloud panel mockup tokens (light: ink #09090b on
// #fff, dark: ink #fafafa on #151517). Copied as literals because the shadow
// root cannot import tokens.css. Dark scheme is prefers-color-scheme only.
export const HOST_CSS = `
[hidden]{display:none!important}
.layer{--b:calc(env(safe-area-inset-bottom,0px) + var(--tinycloud-ui-offset-bottom,12px));position:fixed;inset:0;pointer-events:none;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111827}
.button{position:fixed;bottom:var(--b);width:44px;height:44px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:1px solid #71717a;border-radius:50%;background:#fff;color:#111827;box-shadow:0 1px 3px rgba(0,0,0,.16);cursor:pointer;pointer-events:auto}
.button svg{width:20px;height:20px}
.button:focus-visible{outline:2px solid #111827;outline-offset:2px;box-shadow:0 0 0 6px #fafafa}
.dot{position:absolute;top:6px;right:6px;width:8px;height:8px;border-radius:50%;background:#4b5563;border:2px solid #fff}
.layer[data-position="bottom-right"] .button{right:var(--tinycloud-ui-offset-inline,12px)}
.layer[data-position="bottom-left"] .button{left:var(--tinycloud-ui-offset-inline,12px)}
.layer[data-position="bottom-center"] .button{left:50%;transform:translateX(-50%)}
.pending{position:fixed;top:0;bottom:0;right:0;box-sizing:border-box;width:min(420px,100%);padding:max(20px,env(safe-area-inset-top,0px)) max(20px,env(safe-area-inset-right,0px)) max(20px,env(safe-area-inset-bottom,0px)) max(20px,env(safe-area-inset-left,0px));overflow:auto;border-left:1px solid #e4e4e7;background:#fff;color:#111827;box-shadow:-18px 0 48px -18px rgba(0,0,0,.35);pointer-events:auto}
.layer[data-position="bottom-left"] .pending{right:auto;left:0;border-left:0;border-right:1px solid #e4e4e7}
.pending p{margin:0 0 12px;color:#71717a}
.pending button{min-height:44px;padding:0 16px;border:1px solid #71717a;border-radius:12px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.pending .pclose{display:flex;align-items:center;justify-content:center;width:44px;padding:0;margin:0 0 8px auto;border-radius:50%}
.pending .pclose svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.pending button:focus-visible{outline:2px solid #111827;outline-offset:2px;box-shadow:0 0 0 6px #fafafa}
@media (prefers-color-scheme: dark){
.layer{color:#fafafa}
.button{border-color:#71717a;background:#151517;color:#fafafa}
.button:focus-visible{outline-color:#fafafa;box-shadow:0 0 0 6px #111827}
.dot{background:#a1a1aa;border-color:#151517}
.pending{border-left-color:#69696b;background:#151517;color:#fafafa;box-shadow:-18px 0 48px -18px rgba(0,0,0,.6)}
.layer[data-position="bottom-left"] .pending{border-right-color:#69696b}
.pending p{color:#a1a1aa}
.pending button:focus-visible{outline-color:#fafafa;box-shadow:0 0 0 6px #111827}
}
`;
