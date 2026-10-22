/**
 * Stylesheet for the open shadow root. One inline string, no fonts, no
 * adoptedStyleSheets. Neutral palette only. Offsets are CSS custom properties
 * so an app can reserve space without an API.
 */
// Colours follow the TinyCloud panel mockup tokens (light: ink #09090b on
// #fff, dark: ink #fafafa on #151517). Copied as literals because the shadow
// root cannot import tokens.css. Dark scheme is prefers-color-scheme only.
// The drawer edge (#e4e4e7 / #69696b) is decorative, not a 3:1 target.
export const HOST_CSS = `
[hidden]{display:none!important}
.layer{--b:calc(env(safe-area-inset-bottom,0px) + var(--tinycloud-ui-offset-bottom,12px));position:fixed;inset:0;pointer-events:none;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111827}
.button{position:fixed;bottom:var(--b);width:44px;height:44px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:1px solid #71717a;border-radius:50%;background:#fff;color:#111827;box-shadow:0 1px 3px rgba(0,0,0,.16);cursor:pointer;pointer-events:auto}
.button svg{width:20px;height:20px}
.button:focus-visible,.nav-i:focus-visible,.action:focus-visible,.switch:focus-visible{outline:2px solid #111827;outline-offset:2px;box-shadow:0 0 0 6px #fafafa}
.dot{position:absolute;top:6px;right:6px;width:8px;height:8px;border-radius:50%;background:#4b5563;border:2px solid #fff}
.layer[data-position="bottom-right"] .button{right:var(--tinycloud-ui-offset-inline,12px)}
.layer[data-position="bottom-left"] .button{left:var(--tinycloud-ui-offset-inline,12px)}
.layer[data-position="bottom-center"] .button{left:50%;transform:translateX(-50%)}
.panel{position:fixed;top:12px;bottom:calc(var(--b) + 60px);right:12px;box-sizing:border-box;width:min(420px,calc(100vw - 24px));display:grid;grid-template-rows:auto auto minmax(0,1fr);grid-template-areas:"head" "nav" "main";overflow:hidden;border:1px solid #e4e4e7;border-radius:20px;background:#fff;color:#111827;box-shadow:0 8px 24px rgba(0,0,0,.18);pointer-events:auto;animation:tc-in .42s cubic-bezier(.2,.7,.2,1)}
.layer[data-position="bottom-right"] .panel,.layer[data-position="bottom-center"] .panel{right:var(--tinycloud-ui-offset-inline,12px)}
.layer[data-position="bottom-left"] .panel{left:var(--tinycloud-ui-offset-inline,12px);right:auto}
.layer .panel[data-layout="page"]{top:0;bottom:0;left:0;right:0;width:auto;border:0;border-radius:0;box-shadow:none;grid-template-rows:auto minmax(0,1fr);grid-template-columns:288px minmax(0,1fr);grid-template-areas:"head head" "nav main"}
.head{grid-area:head;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:12px 12px 8px 16px;background:#fafafa;border-bottom:1px solid #e4e4e7}
.title{margin:0;font-size:15px;font-weight:600}
.head-actions{display:flex;flex-wrap:wrap;gap:6px}
.status{font-size:12px;color:#4b5563}
.nav{grid-area:nav;display:flex;flex-wrap:wrap;gap:6px;padding:0 12px 12px;background:#fafafa;border-bottom:1px solid #e4e4e7}
.layer .panel[data-layout="page"] .nav{flex-direction:column;flex-wrap:nowrap;padding:12px;border-bottom:0;border-right:1px solid #e4e4e7}
.nav-i{display:inline-flex;align-items:center;min-height:44px;padding:0 13px;border:0;border-radius:999px;background:#f4f4f5;color:#111827;font:inherit;white-space:nowrap;cursor:pointer}
.nav-i[aria-current="page"]{font-weight:700;box-shadow:inset 0 0 0 1.5px #111827}
.layer .panel[data-layout="page"] .nav-i{min-height:48px;border-radius:14px}
.main{grid-area:main;min-height:0;overflow:auto;padding:16px}
.section+.section{margin-top:12px;padding-top:12px;border-top:1px solid #e4e4e7}
.action{min-width:44px;min-height:44px;padding:0 12px;border:1px solid;border-color:#71717a;border-radius:8px;background:#fff;color:#111827;font:inherit;cursor:pointer}
.row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:44px}
.label{font-weight:500}
.switch{display:inline-flex;align-items:center;width:52px;min-width:44px;height:44px;padding:0;border:0;background:none;cursor:pointer}
.switch:disabled{cursor:default;opacity:.6}
.knob{position:relative;display:block;width:40px;height:24px;border-radius:12px;background:#71717a}
.knob::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .15s ease}
.switch[aria-checked="true"] .knob{background:#111827}
.switch[aria-checked="true"] .knob::after{transform:translateX(16px)}
.busy,.note,.error{margin:6px 0 0;font-size:12px;color:#4b5563}
.note{text-wrap:pretty}
.action+.note,.note:not([hidden])+.action,.row~.action{margin-top:8px}
.error{color:#111827}
.confirm{margin-top:8px}
.confirm .actions{display:flex;gap:8px;margin:8px 0}
@keyframes tc-in{from{transform:translateX(104%)}to{transform:none}}
@keyframes tc-up{from{transform:translateY(104%)}to{transform:none}}
@media (max-width:639px){
.layer .panel[data-layout="drawer"]{left:8px;right:8px;top:auto;width:auto;max-height:min(70dvh,calc(100dvh - 96px));border-radius:20px;animation-name:tc-up}
.layer[data-position="bottom-left"] .panel{left:8px}
.layer .panel[data-layout="page"]{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto minmax(0,1fr);grid-template-areas:"head" "nav" "main"}
.layer .panel[data-layout="page"] .nav{flex-direction:row;flex-wrap:wrap;border-right:0;border-bottom:1px solid #e4e4e7}
}
@media (prefers-reduced-motion:reduce){
.panel,.knob::after{animation:none;transition:none}
}
@media (prefers-color-scheme: dark){
.layer{color:#fafafa}
.button{border-color:#71717a;background:#151517;color:#fafafa}
.button:focus-visible,.nav-i:focus-visible,.action:focus-visible,.switch:focus-visible{outline-color:#fafafa;box-shadow:0 0 0 6px #111827}
.dot{background:#a1a1aa;border-color:#151517}
.panel{border-color:#69696b;background:#151517;color:#fafafa}
.head{background:#151517;border-bottom-color:#69696b}
.nav{background:#151517;border-bottom-color:#69696b}
.layer .panel[data-layout="page"] .nav{border-right-color:#69696b}
.nav-i{background:#27272a;color:#fafafa}
.nav-i[aria-current="page"]{box-shadow:inset 0 0 0 1.5px #fafafa}
.status,.busy,.note{color:#a1a1aa}
.section+.section{border-top-color:#69696b}
.action{border-color:#71717a;background:#151517;color:#fafafa}
.error{color:#fafafa}
.knob{background:#71717a}
.knob::after{background:#151517}
.switch[aria-checked="true"] .knob{background:#fafafa}
}
`;
