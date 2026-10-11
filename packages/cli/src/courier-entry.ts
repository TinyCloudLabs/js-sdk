/** Lazy entry for `tc courier`: Courier is bundled here so other commands never load it. */
import { main } from "@tinycloud/courier";

export function runCourier(argv: string[]): Promise<number> {
  return main(argv, { prog: "tc courier" });
}
