import { Command } from 'commander';

/** Register the complete Commander projection without parsing argv. */
declare function registerTinyCloudCommands(program: Command): void;

export { registerTinyCloudCommands };
