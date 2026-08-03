import { Command } from "commander";

import { registerAccountCommand } from "./commands/account.js";
import { registerAuthCommand } from "./commands/auth.js";
import { registerCompletionCommand } from "./commands/completion.js";
import { registerDelegationCommand } from "./commands/delegation.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerDuckdbCommand } from "./commands/duckdb.js";
import { registerInitCommand } from "./commands/init.js";
import { registerKvCommand } from "./commands/kv.js";
import { registerManifestCommand } from "./commands/manifest.js";
import { registerNodeCommand } from "./commands/node.js";
import { registerProfileCommand } from "./commands/profile.js";
import { registerSecretsCommand } from "./commands/secrets.js";
import { registerShareCommand } from "./commands/share.js";
import { registerSpaceCommand } from "./commands/space.js";
import { registerSqlCommand } from "./commands/sql.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerUpgradeCommand } from "./commands/upgrade.js";
import { registerVaultCommand } from "./commands/vault.js";
import { registerVarsCommand } from "./commands/vars.js";

/** Register the complete Commander projection without parsing argv. */
export function registerTinyCloudCommands(program: Command): void {
  registerInitCommand(program);
  registerAuthCommand(program);
  registerKvCommand(program);
  registerSpaceCommand(program);
  registerDelegationCommand(program);
  registerShareCommand(program);
  registerNodeCommand(program);
  registerProfileCommand(program);
  registerCompletionCommand(program);
  registerVaultCommand(program);
  registerSecretsCommand(program);
  registerVarsCommand(program);
  registerDoctorCommand(program);
  registerSqlCommand(program);
  registerDuckdbCommand(program);
  registerManifestCommand(program);
  registerUpgradeCommand(program);
  registerStatusCommand(program);
  registerAccountCommand(program);
}
