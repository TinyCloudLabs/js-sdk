export interface InterruptTarget {
  on(eventName: "SIGINT", listener: () => void): unknown;
  off(eventName: "SIGINT", listener: () => void): unknown;
}

export function installInterruptHandler(controller: AbortController, target: InterruptTarget = process): () => void {
  const onInterrupt = () => controller.abort("SIGINT");
  target.on("SIGINT", onInterrupt);
  return () => target.off("SIGINT", onInterrupt);
}
