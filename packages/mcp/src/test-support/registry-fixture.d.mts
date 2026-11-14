import type { Server } from "node:http";

export declare function registerMcpFixtureServer(server: Server): void;
export declare function installMcpRegistryFixture(origin?: string): void;
export declare function resetMcpRegistryFixture(): void;
