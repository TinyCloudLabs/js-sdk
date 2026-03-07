import "clsx";
function _layout($$renderer, $$props) {
  let { children } = $$props;
  $$renderer.push(`<div class="min-h-screen bg-gray-50"><header class="border-b border-gray-200 bg-white"><div class="mx-auto max-w-3xl px-4 py-4 flex items-center justify-between"><h1 class="text-lg font-semibold text-gray-900">TinyCloud Secrets</h1></div></header> <main>`);
  children($$renderer);
  $$renderer.push(`<!----></main></div>`);
}
export {
  _layout as default
};
