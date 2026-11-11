// Test-only preload: reject unsafe environments before profile modules load.
import { assertPrivateTestEnvironment } from "./private-home.mjs";
assertPrivateTestEnvironment();
