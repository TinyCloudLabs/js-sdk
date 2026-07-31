/**
 * RPC Provider types, enums, type guards, and Zod schemas.
 *
 * @packageDocumentation
 */

import { z } from "zod";
import type { AxiosRequestConfig } from "axios";
import type { ClientSession } from "@tinycloud/sdk-core";

export type ConnectionInfo = Record<string, unknown>;
export type Networkish =
  | string
  | number
  | { chainId: number | string; name?: string };

// RPC Provider Enum (TypeScript enum form)

/** Enum of supported EthersJS providers. */
export enum RPCProviders {
  AlchemyProvider = "alchemy",
  AnkrProvider = "ankr",
  CloudflareProvider = "cloudflare",
  CustomProvider = "custom",
  EtherscanProvider = "etherscan",
  InfuraProvider = "infura",
  PocketProvider = "pocket",
}

// Network Enums (TypeScript enum form)

/** Enum of supported networks for Etherscan. */
export enum EtherscanProviderNetworks {
  MAINNET = "homestead",
  ROPSTEN = "ropsten",
  RINKEBY = "rinkeby",
  GOERLI = "goerli",
  KOVAN = "kovan",
}

/** Enum of supported networks for Infura. */
export enum InfuraProviderNetworks {
  MAINNET = "homestead",
  ROPSTEN = "ropsten",
  RINKEBY = "rinkeby",
  GOERLI = "goerli",
  KOVAN = "kovan",
  POLYGON = "matic",
  POLYGON_MUMBAI = "maticmum",
  OPTIMISM = "optimism",
  OPTIMISM_KOVAN = "optimism-kovan",
  ARBITRUM = "arbitrum",
  ARBITRUM_RINKEBY = "arbitrum-rinkeby",
}

/** Enum of supported networks for Alchemy. */
export enum AlchemyProviderNetworks {
  MAINNET = "homestead",
  ROPSTEN = "ropsten",
  RINKEBY = "rinkeby",
  GOERLI = "goerli",
  KOVAN = "kovan",
  POLYGON = "matic",
  POLYGON_MUMBAI = "maticmum",
  OPTIMISM = "optimism",
  OPTIMISM_KOVAN = "optimism-kovan",
  ARBITRUM = "arbitrum",
  ARBITRUM_RINKEBY = "arbitrum-rinkeby",
}

/** Enum of supported networks for Pocket. */
export enum PocketProviderNetworks {
  MAINNET = "homestead",
  ROPSTEN = "ropsten",
  RINKEBY = "rinkeby",
  GOERLI = "goerli",
}

/** Enum of supported networks for Ankr. */
export enum AnkrProviderNetworks {
  MAINNET = "homestead",
  POLYGON = "matic",
  ARBITRUM = "arbitrum",
}

// Provider Types (TypeScript interface form)

/** Infura provider project settings. */
export type InfuraProviderProjectSettings = {
  projectId: string;
  projectSecret: string;
};

/** Etherscan provider settings. */
export type EtherscanProvider = {
  service: RPCProviders.EtherscanProvider;
  apiKey?: string;
  network?: EtherscanProviderNetworks;
};

/** Infura provider settings. */
export type InfuraProvider = {
  service: RPCProviders.InfuraProvider;
  apiKey: string | InfuraProviderProjectSettings;
  network?: InfuraProviderNetworks;
};

/** Alchemy provider settings. */
export type AlchemyProvider = {
  service: RPCProviders.AlchemyProvider;
  apiKey?: string;
  network?: AlchemyProviderNetworks;
};

/** Cloudflare provider settings. */
export type CloudflareProvider = {
  service: RPCProviders.CloudflareProvider;
};

/** Pocket provider settings. */
export type PocketProvider = {
  service: RPCProviders.PocketProvider;
  apiKey?: string;
  network?: PocketProviderNetworks;
};

/** Ankr provider settings. */
export type AnkrProvider = {
  service: RPCProviders.AnkrProvider;
  apiKey?: string;
  network?: AnkrProviderNetworks;
};

/** Custom provider settings. */
export type CustomProvider = {
  service: RPCProviders.CustomProvider;
  url?: string | ConnectionInfo;
  network?: Networkish;
};

/** Generic provider settings. */
export type GenericProvider = {
  service: RPCProviders;
  url?: string | ConnectionInfo;
  network?: Networkish;
  apiKey?: string | InfuraProviderProjectSettings;
};

/** Supported provider types. */
export type RPCProvider =
  | GenericProvider
  | EtherscanProvider
  | InfuraProvider
  | AlchemyProvider
  | CloudflareProvider
  | PocketProvider
  | AnkrProvider
  | CustomProvider;


/* Type-Guard for EtherscanProvider. */
export const isEtherscanProvider = (
  provider: RPCProvider
): provider is EtherscanProvider =>
  provider.service === RPCProviders.EtherscanProvider;

/* Type-Guard for InfuraProvider. */
export const isInfuraProvider = (
  provider: RPCProvider
): provider is InfuraProvider =>
  provider.service === RPCProviders.InfuraProvider;

/* Type-Guard for AlchemyProvider. */
export const isAlchemyProvider = (
  provider: RPCProvider
): provider is AlchemyProvider =>
  provider.service === RPCProviders.AlchemyProvider;

/* Type-Guard for CloudflareProvider. */
export const isCloudflareProvider = (
  provider: RPCProvider
): provider is CloudflareProvider =>
  provider.service === RPCProviders.CloudflareProvider;

/** Type-Guard for PocketProvider. */
export const isPocketProvider = (
  provider: RPCProvider
): provider is PocketProvider =>
  provider.service === RPCProviders.PocketProvider;

/** Type-Guard for AnkrProvider. */
export const isAnkrProvider = (
  provider: RPCProvider
): provider is AnkrProvider =>
  provider.service === RPCProviders.AnkrProvider;

/** Type-Guard for CustomProvider. */
export const isCustomProvider = (
  provider: RPCProvider
): provider is CustomProvider =>
  provider.service === RPCProviders.CustomProvider;


/** TCW Route Configuration.
 *  This configuration is used to override the default endpoint paths.
 * The config options here are a subset of the
 * [AxiosRequestConfig](https://axios-http.com/docs/req_config).
 * This type does not explicitly extend AxiosRequestConfig,
 * but those options are supported by the client.
 */
export interface RouteConfig {
  /** Endpoint path. */
  url?: string;
  /** Endpoint request method. */
  method?: "get" | "post" | "put" | "delete";
  /** Custom Operation.
   * Replace the tcw function called with a function of your own
   **/
  customAPIOperation?(
    params: ClientSession | Record<string, any> | any
  ): Promise<any>;
}

export interface ServerMiddlewareConfig {
  path: string;
  callback?: (req: any, body?: Record<string, any>) => Promise<void> | void;
}

/** Type-Guard for ServerMiddlewareConfig. */
export const isServerMiddlewareConfig = (
  config: ServerRouteEndpointType
): config is ServerMiddlewareConfig =>
  (config as ServerMiddlewareConfig)?.path !== undefined;

export type ServerRouteEndpointType =
  | Partial<RouteConfig>
  | AxiosRequestConfig
  | string
  | ServerMiddlewareConfig;

/** Server endpoints configuration. */
export interface ServerRoutes {
  /** Get nonce endpoint path. /tcw-nonce as default. */
  nonce?: ServerRouteEndpointType;
  /** Post login endpoint path. /tcw-login as default. */
  login?: ServerRouteEndpointType;
  /** Post logout endpoint path. /tcw-logout as default. */
  logout?: ServerRouteEndpointType;
}

/** Server endpoints name configuration. */
export interface ServerRouteNames {
  /** Get nonce endpoint path. /tcw-nonce as default. */
  nonce?: string;
  /** Post login endpoint path. /tcw-login as default. */
  login?: string;
  /** Post logout endpoint path. /tcw-logout as default. */
  logout?: string;
}


/** ENS data supported by TCW. */
export interface EnsData {
  /** ENS name/domain. */
  domain?: string | null;
  /** ENS avatar. */
  avatarUrl?: string | null;
}


/** ENS data schema. */
export const EnsDataSchema = z.object({
  /** ENS name/domain. */
  domain: z.string().nullable().optional(),
  /** ENS avatar. */
  avatarUrl: z.string().nullable().optional(),
});

/** Enum of supported EthersJS providers (Zod schema). */
export const RPCProvidersSchema = z.enum([
  "alchemy",
  "ankr",
  "cloudflare",
  "custom",
  "etherscan",
  "infura",
  "pocket",
]);

/**
 * Enum values for RPCProviders (const object form).
 * Both the enum and const object exist and serve different purposes:
 * the enum for type-level discrimination, the const for runtime factory constructors.
 */
export const RPCProvidersConst = {
  AlchemyProvider: "alchemy",
  AnkrProvider: "ankr",
  CloudflareProvider: "cloudflare",
  CustomProvider: "custom",
  EtherscanProvider: "etherscan",
  InfuraProvider: "infura",
  PocketProvider: "pocket",
} as const;

// Network enum schemas

export const EtherscanProviderNetworksSchema = z.enum([
  "homestead",
  "ropsten",
  "rinkeby",
  "goerli",
  "kovan",
]);

export const EtherscanProviderNetworksConst = {
  MAINNET: "homestead",
  ROPSTEN: "ropsten",
  RINKEBY: "rinkeby",
  GOERLI: "goerli",
  KOVAN: "kovan",
} as const;

export const InfuraProviderNetworksSchema = z.enum([
  "homestead",
  "ropsten",
  "rinkeby",
  "goerli",
  "kovan",
  "matic",
  "maticmum",
  "optimism",
  "optimism-kovan",
  "arbitrum",
  "arbitrum-rinkeby",
]);

export const InfuraProviderNetworksConst = {
  MAINNET: "homestead",
  ROPSTEN: "ropsten",
  RINKEBY: "rinkeby",
  GOERLI: "goerli",
  KOVAN: "kovan",
  POLYGON: "matic",
  POLYGON_MUMBAI: "maticmum",
  OPTIMISM: "optimism",
  OPTIMISM_KOVAN: "optimism-kovan",
  ARBITRUM: "arbitrum",
  ARBITRUM_RINKEBY: "arbitrum-rinkeby",
} as const;

export const AlchemyProviderNetworksSchema = z.enum([
  "homestead",
  "ropsten",
  "rinkeby",
  "goerli",
  "kovan",
  "matic",
  "maticmum",
  "optimism",
  "optimism-kovan",
  "arbitrum",
  "arbitrum-rinkeby",
]);

export const AlchemyProviderNetworksConst = {
  MAINNET: "homestead",
  ROPSTEN: "ropsten",
  RINKEBY: "rinkeby",
  GOERLI: "goerli",
  KOVAN: "kovan",
  POLYGON: "matic",
  POLYGON_MUMBAI: "maticmum",
  OPTIMISM: "optimism",
  OPTIMISM_KOVAN: "optimism-kovan",
  ARBITRUM: "arbitrum",
  ARBITRUM_RINKEBY: "arbitrum-rinkeby",
} as const;

export const PocketProviderNetworksSchema = z.enum([
  "homestead",
  "ropsten",
  "rinkeby",
  "goerli",
]);

export const PocketProviderNetworksConst = {
  MAINNET: "homestead",
  ROPSTEN: "ropsten",
  RINKEBY: "rinkeby",
  GOERLI: "goerli",
} as const;

export const AnkrProviderNetworksSchema = z.enum([
  "homestead",
  "matic",
  "arbitrum",
]);

export const AnkrProviderNetworksConst = {
  MAINNET: "homestead",
  POLYGON: "matic",
  ARBITRUM: "arbitrum",
} as const;

// Provider type schemas

export const InfuraProviderProjectSettingsSchema = z.object({
  projectId: z.string(),
  projectSecret: z.string(),
});

export const EtherscanProviderSchema = z.object({
  service: z.literal("etherscan"),
  apiKey: z.string().optional(),
  network: EtherscanProviderNetworksSchema.optional(),
});

export const InfuraProviderSchema = z.object({
  service: z.literal("infura"),
  apiKey: z.union([z.string(), InfuraProviderProjectSettingsSchema]),
  network: InfuraProviderNetworksSchema.optional(),
});

export const AlchemyProviderSchema = z.object({
  service: z.literal("alchemy"),
  apiKey: z.string().optional(),
  network: AlchemyProviderNetworksSchema.optional(),
});

export const CloudflareProviderSchema = z.object({
  service: z.literal("cloudflare"),
});

export const PocketProviderSchema = z.object({
  service: z.literal("pocket"),
  apiKey: z.string().optional(),
  network: PocketProviderNetworksSchema.optional(),
});

export const AnkrProviderSchema = z.object({
  service: z.literal("ankr"),
  apiKey: z.string().optional(),
  network: AnkrProviderNetworksSchema.optional(),
});

/** Custom provider schema. url and network are ethers types, validated as unknown. */
export const CustomProviderSchema = z.object({
  service: z.literal("custom"),
  url: z.unknown().optional(),
  network: z.unknown().optional(),
});

/** Generic provider schema. url and network are ethers types, validated as unknown. */
export const GenericProviderSchema = z.object({
  service: RPCProvidersSchema,
  url: z.unknown().optional(),
  network: z.unknown().optional(),
  apiKey: z.union([z.string(), InfuraProviderProjectSettingsSchema]).optional(),
});

/** Supported provider types (discriminated union schema). */
export const RPCProviderSchema = z.discriminatedUnion("service", [
  EtherscanProviderSchema,
  InfuraProviderSchema,
  AlchemyProviderSchema,
  CloudflareProviderSchema,
  PocketProviderSchema,
  AnkrProviderSchema,
  CustomProviderSchema,
]);

// Route configuration schemas

export const RouteConfigSchema = z.object({
  /** Endpoint path. */
  url: z.string().optional(),
  /** Endpoint request method. */
  method: z.enum(["get", "post", "put", "delete"]).optional(),
  /** Custom Operation - Replace the tcw function called with a function of your own. */
  customAPIOperation: z.function().optional(),
});

export const ServerMiddlewareConfigSchema = z.object({
  path: z.string(),
  callback: z.function().optional(),
});

export const ServerRouteEndpointTypeSchema = z.union([
  RouteConfigSchema.partial(),
  z.unknown(), // AxiosRequestConfig
  z.string(),
  ServerMiddlewareConfigSchema,
]);

export const ServerRoutesSchema = z.object({
  /** Get nonce endpoint path. /tcw-nonce as default. */
  nonce: ServerRouteEndpointTypeSchema.optional(),
  /** Post login endpoint path. /tcw-login as default. */
  login: ServerRouteEndpointTypeSchema.optional(),
  /** Post logout endpoint path. /tcw-logout as default. */
  logout: ServerRouteEndpointTypeSchema.optional(),
});

export const ServerRouteNamesSchema = z.object({
  /** Get nonce endpoint path. /tcw-nonce as default. */
  nonce: z.string().optional(),
  /** Post login endpoint path. /tcw-login as default. */
  login: z.string().optional(),
  /** Post logout endpoint path. /tcw-logout as default. */
  logout: z.string().optional(),
});


export interface ValidationError {
  code: string;
  message: string;
  issues?: unknown[];
}

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ValidationError };

export function validateEnsData(data: unknown): ValidationResult<EnsData> {
  const result = EnsDataSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: result.error.message,
        issues: result.error.issues,
      },
    };
  }
  return { ok: true, data: result.data };
}

export function validateRPCProvider(
  data: unknown
): ValidationResult<z.infer<typeof RPCProviderSchema>> {
  const result = RPCProviderSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: result.error.message,
        issues: result.error.issues,
      },
    };
  }
  return { ok: true, data: result.data };
}

export function validateServerRoutes(
  data: unknown
): ValidationResult<z.infer<typeof ServerRoutesSchema>> {
  const result = ServerRoutesSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: result.error.message,
        issues: result.error.issues,
      },
    };
  }
  return { ok: true, data: result.data };
}
