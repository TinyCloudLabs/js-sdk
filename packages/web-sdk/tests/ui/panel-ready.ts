/**
 * Resolves once the lazy panel has replaced its pending stand-in in the TinyCloud
 * host's shadow root. The panel loads through a dynamic import, so the DOM and
 * stylesheet it renders are not there synchronously after open().
 */
export async function panelMounted(): Promise<void> {
  for (let tick = 0; tick < 500; tick++) {
    const root = document.querySelector<HTMLElement>("[data-tinycloud-ui]")?.shadowRoot;
    if (root?.querySelector(".panel") && !root.querySelector(".pending")) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("the lazy panel never mounted");
}
