import { e as escape_html, _ as derived } from "../../chunks/index.js";
import "@openkey/sdk";
import "clsx";
let error = "";
function getError() {
  return error;
}
function _page($$renderer, $$props) {
  $$renderer.component(($$renderer2) => {
    let storeError = derived(getError);
    $$renderer2.push(`<div class="mx-auto max-w-3xl px-4 py-8"><header class="mb-8"><h1 class="text-3xl font-bold text-gray-900">Secrets &amp; Variables</h1> <p class="mt-1 text-gray-500">Store and manage secrets and environment variables</p></header> `);
    if (storeError()) {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-red-600 text-sm">${escape_html(storeError())} <button class="ml-2 text-red-400 hover:text-red-600">x</button></div>`);
    } else {
      $$renderer2.push("<!--[-1-->");
    }
    $$renderer2.push(`<!--]--> `);
    {
      $$renderer2.push("<!--[0-->");
      $$renderer2.push(`<div class="rounded-xl border border-gray-200 bg-white p-0"><div class="py-16 text-center"><div class="mb-4"><svg xmlns="http://www.w3.org/2000/svg" class="mx-auto h-12 w-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"></path></svg></div> <h2 class="text-xl font-semibold text-gray-900 mb-2">Connect to Get Started</h2> <p class="text-gray-500 mb-6 max-w-md mx-auto">Connect with OpenKey to unlock your encrypted vault and manage secrets and variables.</p> <button class="rounded-lg bg-gray-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800">Connect with OpenKey</button></div></div>`);
    }
    $$renderer2.push(`<!--]--></div>`);
  });
}
export {
  _page as default
};
