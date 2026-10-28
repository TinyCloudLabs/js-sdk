import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const deployEnvKeys = [
  "TINYCLOUD_MCP_IMAGE",
  "CLOUDFLARE_API_TOKEN",
  "TC_MCP_STATE_SECRET",
  "TC_MCP_INTROSPECTION_CLIENT_ID",
  "TC_MCP_INTROSPECTION_CLIENT_SECRET",
  "TC_MCP_NATIVE_SERVICE_CREDENTIAL",
  "CERTBOT_EMAIL",
];

export function mergeAllowedEnvKeys(currentAllowed, deployKeys) {
  return [...new Set([...currentAllowed, ...deployKeys])];
}

function missingKeys(allowed, required) {
  const names = new Set(allowed);
  return required.filter((name) => !names.has(name));
}

function envUpdateError(error) {
  if (error && typeof error === "object" && Number.isInteger(error.status)) return `HTTP ${error.status}`;
  if (error && typeof error === "object" && typeof error.name === "string") return error.name;
  return "unknown error";
}

async function syncAllowedEnvs() {
  const apiKey = process.env.PHALA_CLOUD_API_KEY;
  const cvmId = process.env.PHALA_CVM_ID;
  const envFile = process.env.ENV_FILE;
  if (!apiKey || !cvmId || !envFile) {
    throw new Error("PHALA_CLOUD_API_KEY, PHALA_CVM_ID and ENV_FILE are required");
  }

  const {
    createClient,
    encryptEnvVars,
    getCvmComposeFile,
    getCvmInfo,
    parseEnvVars,
    updateCvmEnvs,
  } = await import("@phala/cloud");
  const envs = parseEnvVars(await readFile(envFile, "utf8"));
  const envKeys = envs.map(({ key }) => key);
  const missingRequired = missingKeys(envKeys, deployEnvKeys);
  const unexpected = envKeys.filter((key) => !deployEnvKeys.includes(key));
  if (missingRequired.length > 0 || unexpected.length > 0 || envs.some(({ value }) => value.length === 0)) {
    const details = [
      missingRequired.length > 0 ? `missing=${missingRequired.join(",")}` : "",
      unexpected.length > 0 ? `unexpected=${unexpected.join(",")}` : "",
      envs.some(({ value }) => value.length === 0) ? "empty_value=true" : "",
    ].filter(Boolean).join("; ");
    throw new Error(`MCP deploy environment file is incomplete (${details})`);
  }

  const client = createClient({ apiKey });
  const cvmRef = { id: cvmId };
  const compose = await getCvmComposeFile(client, cvmRef);
  if (!Array.isArray(compose?.allowed_envs)) {
    throw new Error("Phala CVM response omitted allowed_envs; refusing to replace the existing allowlist");
  }
  const currentAllowed = compose.allowed_envs;
  const nextAllowed = mergeAllowedEnvKeys(currentAllowed, envKeys);
  const addedKeys = missingKeys(currentAllowed, envKeys);
  if (addedKeys.length === 0) {
    console.log(`Phala allowed_envs already contains all ${envKeys.length} deploy keys; no env update required.`);
    return;
  }

  const info = await getCvmInfo(client, cvmRef);
  if (info?.in_progress === true) throw new Error("CVM already has an operation in progress");
  const publicKey = info?.encrypted_env_pubkey ?? info?.kms_info?.encrypted_env_pubkey;
  if (!publicKey) throw new Error("Could not resolve the CVM environment encryption public key");

  const encryptedEnv = await encryptEnvVars(envs, publicKey);
  const result = await updateCvmEnvs(
    client,
    { ...cvmRef, encrypted_env: encryptedEnv, env_keys: nextAllowed },
    { schema: false },
  );
  if (result?.status === "precondition_required") {
    throw new Error("CVM env update requires on-chain compose authorization");
  }
  if (result?.status !== "in_progress") {
    throw new Error(`Unexpected Phala env update status: ${result?.status ?? "missing"}`);
  }

  console.log(
    `Phala allowed_envs update accepted: correlation=${result.correlation_id ?? "unknown"}; ` +
    `allowed_envs_changed=${result.allowed_envs_changed === true}; added=${addedKeys.join(",")}`,
  );

  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await sleep(5 * 60 * 1000);
    const current = await getCvmInfo(client, cvmRef);
    const status = String(current?.status ?? current?.cvm_status ?? "unknown").toLowerCase();
    console.log(`Phala env update status check ${attempt}/6: status=${status}; in_progress=${current?.in_progress === true}`);
    if (status === "failed" || status === "error") {
      throw new Error(`CVM env update ended with status ${status}`);
    }
    if (status !== "running" || current?.in_progress === true) continue;

    const after = await getCvmComposeFile(client, cvmRef);
    if (!Array.isArray(after?.allowed_envs)) {
      throw new Error("Phala CVM response omitted allowed_envs after update");
    }
    const stillMissing = missingKeys(after.allowed_envs, envKeys);
    if (stillMissing.length === 0) {
      console.log("Phala allowed_envs update complete: CVM running and all deploy env names registered.");
      return;
    }
    console.log(`Phala allowed_envs update pending; names not visible yet: ${stillMissing.join(",")}`);
  }

  throw new Error("CVM did not return to running with all deploy env names registered within 30 minutes");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  syncAllowedEnvs().catch((error) => {
    console.error(`MCP allowed_envs sync failed (${envUpdateError(error)}).`);
    process.exitCode = 1;
  });
}
