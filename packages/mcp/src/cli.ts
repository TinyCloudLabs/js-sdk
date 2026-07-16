import { basename } from "node:path";

import { resolveInvocationProfileName } from "@tinycloud/operations/profile";

import { serveTinyCloudMcp, MCP_VERSION } from "./server.js";

export interface ParsedCliOptions {
  readonly profile?: string;
  readonly explicitProfile: boolean;
  readonly allowOwnerProfile: boolean;
  readonly help: boolean;
  readonly version: boolean;
}

const HELP = `TinyCloud delegated operations MCP server

Usage: tinycloud-mcp [options]

Options:
  --profile <name>       Pin the TinyCloud profile for this process
  --allow-owner-profile  Allow data execution for an explicitly selected owner profile
  --help                 Show this help
  --version              Show the package version
`;

export function parseCliOptions(arguments_: readonly string[]): ParsedCliOptions {
  let profile: string | undefined;
  let explicitProfile = false;
  let allowOwnerProfile = false;
  let help = false;
  let version = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--version" || argument === "-v") {
      version = true;
      continue;
    }
    if (argument === "--allow-owner-profile") {
      allowOwnerProfile = true;
      continue;
    }
    if (argument === "--profile") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--profile requires a non-empty profile name.");
      }
      profile = value;
      explicitProfile = true;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--profile=")) {
      const value = argument.slice("--profile=".length);
      if (value.length === 0) throw new Error("--profile requires a non-empty profile name.");
      profile = value;
      explicitProfile = true;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  return { profile, explicitProfile, allowOwnerProfile, help, version };
}

export async function main(arguments_: readonly string[] = process.argv.slice(2)): Promise<number> {
  let options: ParsedCliOptions;
  try {
    options = parseCliOptions(arguments_);
  } catch (error) {
    process.stderr.write("[tinycloud-mcp] Invalid command line.\n");
    return 2;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${MCP_VERSION}\n`);
    return 0;
  }

  let profile: string;
  try {
    profile = await resolveInvocationProfileName(options.profile);
  } catch {
    process.stderr.write("[tinycloud-mcp] Could not select a profile.\n");
    return 2;
  }

  // The selected profile is now a value captured by the server closure. Every
  // operation receives it explicitly and cannot re-read TC_PROFILE/config.
  serveTinyCloudMcp({
    profile,
    explicitProfile: options.explicitProfile,
    allowOwnerProfile: options.allowOwnerProfile,
  });
  return 0;
}

function isDirectInvocation(): boolean {
  const argv = process.argv[1];
  if (argv === undefined) return false;
  return basename(argv) === "cli.js" || basename(argv) === "tinycloud-mcp";
}

if (isDirectInvocation()) {
  void main().then((code) => {
    if (code !== 0) process.exitCode = code;
  }).catch(() => {
    process.stderr.write("[tinycloud-mcp] Startup failed.\n");
    process.exitCode = 1;
  });
}
