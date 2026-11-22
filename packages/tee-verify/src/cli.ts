import { TeeVerifyRefused } from "./errors.js";
import { verifyService } from "./service.js";
import type { ServiceName } from "./trust.js";

const USAGE = `usage: tinycloud-tee-verify <url> [--service tinycloud-node|openkey] [--signer <signer>] [--allow-unattested-keys] [--json]

Asks the service for a hardware quote over a fresh nonce and checks it:
Intel's signature and TCB status, the production OS measurements, the
released app ID, compose hash and KMS, and the signer the quote binds.
OpenKey is also refused if it serves a key its quote does not cover;
--allow-unattested-keys reports those keys instead, to diagnose a rotation.
Exit 0: verified. Exit 1: refused. Exit 2: usage.`;

// openkey#706 docs/tee-overview.md: its signing keys live in its database, not the TEE.
const OPENKEY_CAVEAT =
  "OpenKey's signing keys are stored in its database: this proves the measured code holds them, not that no other system does";

interface Args {
  url: string;
  service: ServiceName;
  signer?: string;
  allowUnattestedKeys: boolean;
  json: boolean;
}

function parse(argv: string[]): Args | null {
  let url: string | undefined;
  let service: ServiceName = "tinycloud-node";
  let signer: string | undefined;
  let allowUnattestedKeys = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") json = true;
    else if (arg === "--allow-unattested-keys") allowUnattestedKeys = true;
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
  if (allowUnattestedKeys && service !== "openkey") return null;
  return url ? { url, service, ...(signer ? { signer } : {}), allowUnattestedKeys, json } : null;
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  if (!args) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  try {
    const v = await verifyService(args.url, {
      service: args.service,
      ...(args.signer ? { identity: args.signer } : {}),
      ...(args.allowUnattestedKeys ? { allowUnattestedKeys: true } : {}),
    });
    const warnings = [
      ...(args.service === "openkey" ? [OPENKEY_CAVEAT] : []),
      ...(args.allowUnattestedKeys
        ? [
            v.unattestedKeys?.length
              ? `--allow-unattested-keys: served keys NOT covered by the quote: ${v.unattestedKeys.join(",")}; do not trust tokens they sign`
              : "--allow-unattested-keys was set",
          ]
        : []),
    ];
    if (args.json) process.stdout.write(`${JSON.stringify({ verified: true, ...v, warnings })}\n`);
    else {
      process.stdout.write(
        [
          "verified",
          `  service:      ${v.service} ${v.version}`,
          `  os image:     ${v.osImage.name} (${v.osImage.hash})`,
          `  app id:       ${v.appId}`,
          `  compose hash: ${v.composeHash}`,
          `  kms:          ${v.keyProvider.name} ${v.keyProvider.id}`,
          `  signer:       ${v.identity}`,
          `  tcb:          ${v.tcbStatus}`,
          ...warnings.map((w) => `  warning:      ${w}`),
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
