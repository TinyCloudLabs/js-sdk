import type { HostPart } from "../slots";

/** Toast stack arrives with A2. Nothing is rendered until then. */
export const toasts: HostPart = {
  id: "toasts",
  start: () => () => undefined,
};
