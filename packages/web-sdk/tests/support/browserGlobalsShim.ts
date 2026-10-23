// Import this module before any source module that touches HTMLElement or customElements at load time.
// ES modules evaluate imports in order, so a static import listed first runs first.
Object.assign(globalThis, {
  HTMLElement: class {},
  customElements: {
    define: () => undefined,
    get: () => undefined,
  },
});

export {};
