import { describe, expect, test } from "bun:test";
import { resolveNpm } from "./npm-command.js";

const existing = (...files: string[]) => (file: string) => files.includes(file);

describe("finding npm for the updater", () => {
  test("POSIX: the first npm in an absolute PATH entry; relative entries (the current directory) never count", () => {
    const exists = existing("./npm", "bin/npm", "/opt/node/bin/npm", "/usr/bin/npm");
    expect(resolveNpm({ PATH: ".:bin::/opt/node/bin:/usr/bin" }, "linux", "/opt/node/bin/node", exists)).toEqual({ command: "/opt/node/bin/npm", args: [] });
    expect(resolveNpm({ PATH: ".:bin" }, "darwin", "/opt/node/bin/node", exists)).toBeNull();
    expect(resolveNpm({}, "linux", "/opt/node/bin/node", exists)).toBeNull();
  });

  test("Windows: npm-cli.js next to node.exe, run by node itself, so no .cmd file or shell is involved", () => {
    const exists = existing(
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      "C:\\Users\\u\\AppData\\Roaming\\npm\\npm.cmd",
      "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js",
    );
    expect(resolveNpm({ Path: "C:\\Users\\u\\AppData\\Roaming\\npm" }, "win32", "C:\\Program Files\\nodejs\\node.exe", exists)).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"],
    });
  });

  test("Windows: otherwise the npm.cmd on an absolute PATH entry, through its npm-cli.js; one in the current directory is ignored", () => {
    const exists = existing(
      "npm.cmd",
      ".\\npm.cmd",
      "node_modules\\npm\\bin\\npm-cli.js",
      "D:\\tools\\npm\\npm.cmd",
      "D:\\tools\\npm\\node_modules\\npm\\bin\\npm-cli.js",
    );
    expect(resolveNpm({ PATH: ".;;D:\\tools\\npm" }, "win32", "D:\\volta\\node.exe", exists)).toEqual({
      command: "D:\\volta\\node.exe",
      args: ["D:\\tools\\npm\\node_modules\\npm\\bin\\npm-cli.js"],
    });
    expect(resolveNpm({ PATH: "." }, "win32", "D:\\volta\\node.exe", exists)).toBeNull();
  });
});
