import type { HostPart } from "../slots";

/** Prompt host arrives with A3. Nothing is rendered until then. */
export const prompts: HostPart = {
  id: "prompts",
  start: () => () => undefined,
};
