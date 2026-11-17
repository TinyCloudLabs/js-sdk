#!/usr/bin/env node
import { autoUpdate, runOnNewVersion } from './auto-update.js';

// After an update the files on disk are the new release, so the command runs in a fresh process and this one never loads them.
const { argv, entry, broken } = await autoUpdate(process.argv.slice(2));
// A failed update that could not be undone leaves no usable copy; the line saying so is already on stderr.
if (broken) process.exit(1);
if (entry) process.exit(await runOnNewVersion(entry, argv));

// Dynamic on purpose: a static import would load the command graph (and node-sdk) before the update decision, from files an update replaces.
const { main } = await import('./main.js');
const code = await main(argv);
if (code !== 0) process.exit(code);
