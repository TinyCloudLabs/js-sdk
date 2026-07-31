/**
 * Type declaration for undici's deep `Client` module path.
 *
 * undici ships types only at the package root (`undici/types/client.d.ts`,
 * aggregated via `undici/index.d.ts`), not alongside the deep runtime file
 * `lib/dispatcher/client.js` that `./nodeTransport.ts` imports (see that
 * file's header comment for why). This re-exports the real `Client` type
 * from the package root so the deep import stays fully typed.
 */
declare module "undici/lib/dispatcher/client.js" {
  import type { Client } from "undici";

  const ClientImpl: typeof Client;
  export default ClientImpl;
}
