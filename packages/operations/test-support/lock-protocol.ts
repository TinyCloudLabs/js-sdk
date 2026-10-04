// Which release's profile lock a lock fixture takes, from TC_TEST_LOCK_PROTOCOL:
// "current" (default, this source tree), "tc540" (TC-540/TC-548 releases) or
// "pre-tc540" (releases before TC-540, holding the lock from mkdir).
import { withProfileLock, type ProfileLockOptions } from "../src/state.js";
import { withPreTc540ProfileLock } from "./released-locks/pre-tc540.js";
import { withTc540ProfileLock } from "./released-locks/tc540.js";

export type WithLock = <T>(profile: string, action: () => Promise<T>, options?: ProfileLockOptions) => Promise<T>;

const protocols: Record<string, WithLock> = {
  current: withProfileLock,
  tc540: withTc540ProfileLock,
  "pre-tc540": withPreTc540ProfileLock,
};

const name = process.env.TC_TEST_LOCK_PROTOCOL ?? "current";
const selected = protocols[name];
if (!selected) throw new Error(`Unknown TC_TEST_LOCK_PROTOCOL "${name}".`);

export const withFixtureLock: WithLock = selected;
