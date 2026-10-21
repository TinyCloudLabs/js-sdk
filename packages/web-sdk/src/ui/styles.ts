/**
 * Stylesheet for the open shadow root. One inline string, no fonts, no
 * adoptedStyleSheets. Neutral palette only. Offsets are CSS custom properties
 * so an app can reserve space without an API.
 */
// Dark scheme: prefers-color-scheme only, no data-tc-theme attribute, following
// the brand guide §4.1 "Dark candidate" column (PROPOSED). Values: surface #151517,
// ink #fafafa, dim #a1a1aa, hairline #69696b, control-edge #71717a, focus ink #fafafa.
// Copied as literals because the shadow root cannot import tokens.css. Light values
// are unchanged.
export const HOST_CSS = `
[hidden]{display:none!important}
.layer{--b:calc(env(safe-area-inset-bottom,0px) + var(--tinycloud-ui-offset-bottom,12px));position:fixed;inset:0;pointer-events:none;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111827}
.button{position:fixed;bottom:var(--b);width:44px;height:44px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:1px solid #6b7280;border-radius:50%;background:#fff;color:#111827;box-shadow:0 1px 3px rgba(0,0,0,.16);cursor:pointer;pointer-events:auto}
.button svg{width:20px;height:20px}
.button:focus-visible{outline:2px solid #111827;outline-offset:2px;box-shadow:0 0 0 6px #fafafa,0 1px 3px rgba(0,0,0,.16)}
.action:focus-visible,.switch:focus-visible{outline:2px solid #111827;outline-offset:2px;box-shadow:0 0 0 6px #fafafa}
.dot{position:absolute;top:6px;right:6px;width:8px;height:8px;border-radius:50%;background:#4b5563;border:2px solid #fff}
.panel{position:fixed;bottom:calc(var(--b) + 52px);box-sizing:border-box;width:min(360px,calc(100vw - 24px));max-width:min(360px,calc(100vw - 24px));max-height:calc(100dvh - 96px);overflow:auto;padding:12px;border:1px solid #d1d5db;border-radius:12px;background:#fff;box-shadow:0 8px 24px rgba(0,0,0,.18);pointer-events:auto}
.layer[data-position="bottom-right"] .button,.layer[data-position="bottom-right"] .panel{right:var(--tinycloud-ui-offset-inline,12px)}
.layer[data-position="bottom-left"] .button,.layer[data-position="bottom-left"] .panel{left:var(--tinycloud-ui-offset-inline,12px)}
.layer[data-position="bottom-center"] .button,.layer[data-position="bottom-center"] .panel{left:50%;transform:translateX(-50%)}
.header{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px}
.title{margin:0;font-size:15px;font-weight:600}
.status{font-size:12px;color:#4b5563}
.section+.section{margin-top:12px;padding-top:12px;border-top:1px solid #e5e7eb}
.footer{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.action{min-width:44px;min-height:44px;padding:0 12px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#111827;font:inherit;cursor:pointer}
.row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:44px}
.label{font-weight:500}
.switch{display:inline-flex;align-items:center;width:52px;min-width:44px;height:44px;padding:0;border:0;background:none;cursor:pointer}
.switch:disabled{cursor:default;opacity:.6}
.knob{position:relative;display:block;width:40px;height:24px;border-radius:12px;background:#6b7280}
.knob::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .15s ease}
.switch[aria-checked="true"] .knob{background:#111827}
.switch[aria-checked="true"] .knob::after{transform:translateX(16px)}
.busy,.note,.error{margin:6px 0 0;font-size:12px;color:#4b5563}
.error{color:#111827}
.confirm{margin-top:8px}
.confirm .actions{display:flex;gap:8px;margin:8px 0}
@media (prefers-color-scheme: dark){
.layer{color:#fafafa}
.button{border-color:#71717a;background:#151517;color:#fafafa}
.dot{background:#a1a1aa;border-color:#151517}
.button:focus-visible{outline-color:#fafafa;box-shadow:0 0 0 6px #111827,0 1px 3px rgba(0,0,0,.16)}
.action:focus-visible,.switch:focus-visible{outline-color:#fafafa;box-shadow:0 0 0 6px #111827}
.panel{border-color:#69696b;background:#151517}
.status,.busy,.note{color:#a1a1aa}
.error{color:#fafafa}
.section+.section{border-top-color:#69696b}
.action{border-color:#71717a;background:#151517;color:#fafafa}
.knob{background:#71717a}
.knob::after{background:#151517}
.switch[aria-checked="true"] .knob{background:#fafafa}
}
`;
