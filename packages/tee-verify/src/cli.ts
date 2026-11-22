import { TeeVerifyRefused } from "./errors.js";
import { verifyService } from "./service.js";
import type { ServiceName } from "./trust.js";

const USAGE = `usage: tinycloud-tee-verify <url> [--service tinycloud-node|openkey] [--signer <signer>] [--json]

Asks the service for a hardware quote over a fresh nonce and checks it:
Intel's signature and TCB status, the production OS measurements, the
released app ID and compose hash, and the signer the quote binds.
Exit 0: verified. Exit 1: refused. Exit 2: usage.`;

function parse(argv: string[]): { url: string; service: ServiceName; signer?: string; json: boolean } | null {
  let url: string | undefined;
  let service: ServiceName = "tinycloud-node";
  let signer: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") json = true;
    else if (arg === "--service") {
      const value = argv[++i];
      if (value !== "tinycloud-node" && value !== "openkey") return null;
      service = value;
    } else if (arg === "--signer") {
      signer = argv[++i];
      if (!signer) return null;
    } else if (!arg.startsWith("-") && url === undefined) url = arg;
    else return null;
  }
  return url ? { url, service, ...(signer ? { signer } : {}), json } : null;
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  if (!args) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  try {
    const v = await verifyService(args.url, { service: args.service, ...(args.signer ? { identity: args.signer } : {}) });
    if (args.json) process.stdout.write(`${JSON.stringify({ verified: true, ...v })}\n`);
    else {
      process.stdout.write(
        [
          "verified",
          `  service:      ${v.service} ${v.version}`,
          `  os image:     ${v.osImage.name} (${v.osImage.hash})`,
          `  app id:       ${v.appId}`,
          `  compose hash: ${v.composeHash}`,
          `  signer:       ${v.identity}`,
          `  tcb:          ${v.tcbStatus}`,
          "",
        ].join("\n"),
      );
    }
    return 0;
  } catch (error) {
    if (!(error instanceof TeeVerifyRefused)) throw error;
    if (args.json) process.stdout.write(`${JSON.stringify({ verified: false, code: error.code, reason: error.message })}\n`);
    else process.stdout.write(`refused: ${error.message}\n`);
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`tinycloud-tee-verify: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
