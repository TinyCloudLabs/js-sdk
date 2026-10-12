#!/usr/bin/env node
import { main } from './main.js';

const code = await main(process.argv.slice(2));
if (code !== 0) process.exit(code);
