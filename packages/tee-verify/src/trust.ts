import osImages from "../pins/os-images.json";
import releases from "../pins/releases.json";

/** Services this library knows how to verify. */
export type ServiceName = "tinycloud-node" | "openkey";

/**
 * A production dstack OS image as one VM shape measures it. RTMR0 covers the
 * virtual hardware (vCPUs, memory), so one image can have several entries.
 */
export interface OsImagePin {
  name: string;
  /** Hex SHA-256 the guest measures into RTMR3 as `os-image-hash`. */
  osImageHash: string;
  mrtd: string;
  rtmr0: string;
  rtmr1: string;
  rtmr2: string;
}

/** A known non-production image, named so the refusal can say which. */
export interface RefusedOsImage {
  name: string;
  osImageHash: string;
  why: string;
}

/** A released version of a service: its dstack app ID and compose hash. */
export interface ReleasePin {
  service: ServiceName;
  version: string;
  appId: string;
  composeHash: string;
}

export interface Trust {
  osImages: readonly OsImagePin[];
  refusedOsImages: readonly RefusedOsImage[];
  releases: readonly ReleasePin[];
}

const HEX32 = /^[0-9a-f]{64}$/;
const HEX48 = /^[0-9a-f]{96}$/;
const APP_ID = /^[0-9a-f]{40}$/;

/** Throws if any pin is malformed, so a bad list fails loudly rather than matching nothing. */
export function checkTrust(trust: Trust): Trust {
  for (const p of trust.osImages) {
    if (!p.name || !HEX32.test(p.osImageHash) || ![p.mrtd, p.rtmr0, p.rtmr1, p.rtmr2].every((m) => HEX48.test(m) && !/^0+$/.test(m))) {
      throw new Error(`invalid OS image pin ${JSON.stringify(p.name)}`);
    }
  }
  for (const p of trust.refusedOsImages) {
    if (!p.name || !HEX32.test(p.osImageHash) || !p.why) throw new Error(`invalid refused OS image ${JSON.stringify(p.name)}`);
  }
  for (const p of trust.releases) {
    if ((p.service !== "tinycloud-node" && p.service !== "openkey") || !p.version || !APP_ID.test(p.appId) || !HEX32.test(p.composeHash)) {
      throw new Error(`invalid release pin ${JSON.stringify(p.version)}`);
    }
  }
  return trust;
}

function freeze<T>(items: readonly T[]): readonly T[] {
  return Object.freeze(items.map((item) => Object.freeze({ ...item })));
}

/**
 * The published lists, reviewed in this repository (pins/README.md). Nothing at
 * runtime (environment, files, the service's response) can add to them.
 */
export const PUBLISHED_TRUST: Trust = Object.freeze(
  checkTrust({
    osImages: freeze(osImages.production as OsImagePin[]),
    refusedOsImages: freeze(osImages.refused),
    releases: freeze(releases as ReleasePin[]),
  }),
);
