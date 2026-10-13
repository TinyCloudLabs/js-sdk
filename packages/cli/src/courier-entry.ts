/** Lazy entry for `tc courier`: Courier is bundled here so other commands never load it. */
import { main } from "@tinycloud/courier";
import { CLI_NAME } from "@tinycloud/operations/cli-name";

export function runCourier(argv: string[]): Promise<number> {
  return main(argv, { prog: `${CLI_NAME} courier` });
}
