import type { PublishedShare } from "./publish.js";

export interface LegacyShareReader<T> {
  read(link: string): Promise<T>;
}

export interface LegacyMigrationResult<T> {
  readonly protocol: "tinycloud-share";
  readonly version: 1;
  readonly legacy: true;
  readonly migrated: PublishedShare;
  readonly value: T;
}

export function isLegacyShareLink(value: string): boolean {
  return value.startsWith("tc1:");
}

/** Modern commands never call this function implicitly. */
export async function receiveLegacyShare<T>(link: string, reader: LegacyShareReader<T>): Promise<T> {
  if (!isLegacyShareLink(link)) throw new Error("legacy link must use tc1:");
  return reader.read(link);
}

/** Read tc1, then explicitly re-mint through the modern publisher. */
export async function migrateShare<T>(input: {
  readonly link: string;
  readonly reader: LegacyShareReader<T>;
  readonly publish: (value: T) => Promise<PublishedShare>;
}): Promise<LegacyMigrationResult<T>> {
  const value = await receiveLegacyShare(input.link, input.reader);
  return { protocol: "tinycloud-share", version: 1, legacy: true, value, migrated: await input.publish(value) };
}
