/** A shared platform lock fixture; storage reads/writes and registry policy stay real. */
export function installTestWebLocks() {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const tails = new Map<string, Promise<unknown>>();
  const locks = {
    request<Result>(name: string, action: () => Promise<Result>): Promise<Result> {
      const next = (tails.get(name) ?? Promise.resolve()).then(action);
      const settled = next.catch(() => undefined);
      tails.set(name, settled);
      void settled.then(() => { if (tails.get(name) === settled) tails.delete(name); });
      return next;
    },
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks } });
  return {
    locks,
    restore() {
      if (original) Object.defineProperty(globalThis, "navigator", original);
      else Reflect.deleteProperty(globalThis, "navigator");
    },
  };
}
