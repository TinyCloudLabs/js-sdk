/**
 * Publishes the rendered height of `el` as a CSS custom property on `target`.
 * Returns a disposer. Without ResizeObserver the property is never set and the
 * CSS fallback (`0px`) applies.
 */
export function publishHeight(
  el: HTMLElement,
  target: HTMLElement,
  name: string,
  format: (px: number) => string = (px) => `${px}px`,
): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver(() => {
    target.style.setProperty(name, format(el.getBoundingClientRect().height));
  });
  observer.observe(el);
  return () => observer.disconnect();
}
