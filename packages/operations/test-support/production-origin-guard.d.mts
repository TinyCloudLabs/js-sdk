export declare function isProductionLinksOrigin(value: string): boolean;
export declare function armProductionOriginGuard(
  environment?: Record<string, string | undefined>,
  target?: { fetch: typeof fetch },
): void;
export declare function nodeOptionsWithGuard(existing: string | undefined, preloadUrl?: string): string;
