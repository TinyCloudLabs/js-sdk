import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT_VERSION = "2.11.0-beta.2";
const CONTRACT_EXPORTS = [
  "TinyCloudWeb",
  "createOpenKeyCallbackSigningStrategy",
  "establishOpenKeySession",
] as const;

export interface CoordinationOsVendorPackageMetadata {
  name: string;
  version: string;
}

export interface CoordinationOsVendorManifest {
  schemaVersion: 1;
  package: string;
  version: string;
  format: "esm";
  entry: string;
  sha384: string;
  exports: string[];
}

export function createCoordinationOsVendorManifest(
  bundleBytes: Uint8Array,
  packageMetadata: CoordinationOsVendorPackageMetadata,
): CoordinationOsVendorManifest {
  if (
    packageMetadata.name !== "@tinycloud/web-sdk" ||
    packageMetadata.version !== CONTRACT_VERSION
  ) {
    throw new Error("CoordinationOS vendor package metadata does not match the contract");
  }

  return {
    schemaVersion: 1,
    package: packageMetadata.name,
    version: packageMetadata.version,
    format: "esm",
    entry: `tinycloud-web-sdk-${CONTRACT_VERSION}.mjs`,
    sha384: `sha384-${createHash("sha384").update(bundleBytes).digest("base64")}`,
    exports: [...CONTRACT_EXPORTS],
  };
}

async function buildManifest(): Promise<void> {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const packageJsonPath = resolve(packageRoot, "package.json");
  const packageMetadata = JSON.parse(
    await readFile(packageJsonPath, "utf8"),
  ) as CoordinationOsVendorPackageMetadata;
  const entry = `tinycloud-web-sdk-${CONTRACT_VERSION}.mjs`;
  const bundlePath = resolve(packageRoot, "dist/vendor", entry);
  if (basename(bundlePath) !== entry) {
    throw new Error("CoordinationOS vendor bundle path is invalid");
  }

  const manifest = createCoordinationOsVendorManifest(
    await readFile(bundlePath),
    packageMetadata,
  );
  const manifestPath = resolve(
    packageRoot,
    "dist/vendor",
    `tinycloud-web-sdk-${CONTRACT_VERSION}.vendor.json`,
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (import.meta.main) {
  await buildManifest();
}
