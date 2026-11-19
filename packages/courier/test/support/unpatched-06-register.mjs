// `node --import` entry for unpatched-06-hooks.mjs.
import { register } from 'node:module';

register('./unpatched-06-hooks.mjs', import.meta.url);
