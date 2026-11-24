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
    expect(help).toContain("at most 30d. Default 7d, renewing for up to 30 days unless the owner approves without renewal; at 30d there is no renewal");
  });
});
