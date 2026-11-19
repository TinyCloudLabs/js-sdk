import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { registerOnboardCommand } from "./onboard.js";

describe("onboard --help", () => {
  const program = new Command();
  registerOnboardCommand(program);
  const help = program.commands.find((command) => command.name() === "onboard")!.helpInformation().replace(/\s+/g, " ");

  test("says apps,feed keeps the account listing that apps needs", () => {
    expect(help).toContain("apps,feed (keeps the account listing that apps needs)");
  });

  test("says the default lifetime is the shortest of the selected tasks' defaults, with the 30-day cap", () => {
    expect(help).toContain("at most 30d. Default: the shortest of the selected tasks' defaults (apps 30d, feed 7d), so 7d when --with includes feed");
  });
});
