export declare const GUARD_MARKER: string;
export declare const ALLOW_VARIABLE: string;
export declare function isProductionLinksOrigin(value: string): boolean;
export declare function productionOriginLabel(value: string): string | undefined;
export declare function armProductionFetchGuard(
  target?: { fetch: typeof fetch },
  environment?: Record<string, string | undefined>,
): void;
export declare function armProductionOriginGuard(
  environment?: Record<string, string | undefined>,
  target?: { fetch: typeof fetch },
): void;
export declare function nodeOptionsWithGuard(existing: string | undefined, preloadUrl?: string): string;
