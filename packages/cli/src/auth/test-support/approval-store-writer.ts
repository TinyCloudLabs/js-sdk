/**
 * Child process of the durability test: appends one more pending approval to the profile's file in a loop, reporting each
 * completed write on stdout, until the parent kills it (SIGKILL) at an arbitrary moment. Run as
 * `bun approval-store-writer.ts <profile> <template.json>` with HOME/TC_HOME already pointing at the test directory.
 */
import { readFileSync } from "node:fs";
import type { ApprovalEntry } from "@tinycloud/share-envelope/links";
import { updateApprovals } from "../approval-store.js";

const [, , profile, templatePath] = process.argv;
if (!profile || !templatePath) throw new Error("usage: approval-store-writer.ts <profile> <template.json>");
// The parent wrote this file from a valid entry; the store re-validates every entry it reads back.
const template: ApprovalEntry = JSON.parse(readFileSync(templatePath, "utf8"));

/** 26 characters of [a-z]: the link id grammar, one distinct id per index. */
const idOf = (index: number) => "writer".padEnd(24, "a") + String.fromCharCode(97 + Math.floor(index / 26) % 26) + String.fromCharCode(97 + index % 26);
for (let index = 0; ; index++) {
  await updateApprovals(profile, (entries) => [...entries, { ...template, requestId: idOf(index) }]);
  process.stdout.write(`wrote ${index + 1}\n`);
}
