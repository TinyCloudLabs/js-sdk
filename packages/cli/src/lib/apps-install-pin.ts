/**
 * Pinned catalog entries for `tinycloud apps install`.
 *
 * Bytes come from the Share origin, under the bundle root named below. Every
 * file is checked against its sha256 and size before anything is written.
 * Only `schema.sql` and `knowledge/**` are pinned: the installer never writes
 * `app/`, `manifest.json`, `release.json` or `install.json`.
 */
export const SHARE_ORIGIN = "https://share.tinycloud.xyz";

export interface PinnedFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface PinnedApp {
  readonly appId: string;
  /** SQLite database in the applications space that the app's schema.sql targets, named `<app_id>/<name>` as `--db` takes it. */
  readonly database: string;
  /** Bundle digest; the bundle root is `/apps/b/<bundleDigest>/`. */
  readonly bundleDigest: string;
  /** `schema.sql` plus every knowledge file. `knowledge/index.md` is last. */
  readonly files: readonly PinnedFile[];
}

const HEALTHLOG_ID = "xyz.tinycloud.sample.healthlog";

const PINNED: Readonly<Record<string, PinnedApp>> = {
  [HEALTHLOG_ID]: {
    appId: HEALTHLOG_ID,
    database: `${HEALTHLOG_ID}/healthlog`,
    bundleDigest: "dc3ec19fffce8fee350944469948531659a258347538a98aacdd5544deea5014",
    files: [
      { path: "schema.sql", sha256: "bb46ab35ac7887f672beba2f50b9f982c31d41607b3fa77ac9c2e72003edf199", size: 4105 },
      { path: "knowledge/app.md", sha256: "74a65d0332ba06fe5f7fb47c67243ebc6ca80435f3388cb5201712287240f4c7", size: 3994 },
      { path: "knowledge/kv/app.md", sha256: "1583fdefdf6261a8ce110d8de22843855f8393f760de9fa79c3491868924bd42", size: 1283 },
      { path: "knowledge/kv/knowledge.md", sha256: "1f3fb9d50e0ccea10dbe4a223efdbbde2b277bbed8f4790251331c5a7dcebc0f", size: 1170 },
      { path: "knowledge/kv/prefs.md", sha256: "0de88eb2cd8c2ad7302b84c2f6b972364d9e9354f15b70657349339167dd52e4", size: 831 },
      { path: "knowledge/log.md", sha256: "7753435d03afe51c36023c596330c7f04c597319586b5b39d4cf8a675512b1d0", size: 263 },
      { path: "knowledge/tables/meal.md", sha256: "1bc09271c8c2cf987ef81dfb99c4427234fdfbc795f5229a1d631aef0fbff795", size: 1921 },
      { path: "knowledge/tables/weight.md", sha256: "fbae8b103931f976b838024d3ec7ea2596f1b1af3e9834e8aaba1d216d227bc0", size: 1401 },
      { path: "knowledge/views/day_card.md", sha256: "f1ea0738b6905a4952ab1f9c269310f2f888c6606b16304c12bdf69dfb3fafbe", size: 1707 },
      { path: "knowledge/views/week_rollup.md", sha256: "b9773f2ae10fadb9b0ce5f5a78885c87f90bd202a00f7f157428911239c2077e", size: 1579 },
      { path: "knowledge/index.md", sha256: "06e54fa6a4f14ae13bdbcf2ad5ab22b6d561da90e04c27fc616787762e45811e", size: 945 },
    ],
  },
};

export function pinnedApp(appId: string): PinnedApp | undefined {
  return Object.hasOwn(PINNED, appId) ? PINNED[appId] : undefined;
}
