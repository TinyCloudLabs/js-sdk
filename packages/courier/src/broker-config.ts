import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CourierError } from './errors.js';
import { loadProfile, profileDir, type Profile } from './profile.js';
import { profileId, agentHome } from './guard/install.js';
import { realpathBest } from './guard/paths.js';

export const TEST_TOKEN = `ghp_${'d'.repeat(36)}`;
const ID = /^[a-f0-9]{24}$/;
const PINNED = ['host', 'openkeyHost', 'spaceId', 'ownerDid', 'courierDid'] as const;
export interface BrokerConfig {
  v: 2;
  courierHome: string;
  profile: Pick<Profile, typeof PINNED[number]>;
  ghBin: string;
  ghIdentity: { dev: number; ino: number };
  testToken?: string;
}

/** Production discovery uses the OS account database, never HOME/XDG or a Courier pointer. */
export function brokerRoot(testOwnerRoot?: string): string {
  const owner = os.userInfo().homedir;
  if (testOwnerRoot !== undefined) {
    const root = realpathBest(testOwnerRoot);
    const scratch = realpathBest(path.join(owner, 'scratch'));
    if (!path.isAbsolute(testOwnerRoot) || root === realpathBest(owner) || !root.startsWith(`${scratch}${path.sep}`)) {
      throw new CourierError('usage', '--test-owner-root must be a private directory under the real OS user\'s ~/scratch/, never the real owner root');
    }
    if (fs.existsSync(root)) {
      const st = fs.statSync(root);
      if (st.uid !== os.userInfo().uid || (st.mode & 0o077)) throw new CourierError('usage', '--test-owner-root must be owner-private (0700)');
    }
    const broker = realpathBest(path.join(root, '.config/courier-broker'));
    if (!broker.startsWith(`${root}${path.sep}`)) throw new CourierError('usage', '--test-owner-root configuration must stay inside its private scratch root');
    return broker;
  }
  return path.join(owner, '.config/courier-broker');
}

export function brokerFile(id: string, testOwnerRoot?: string): string {
  if (!ID.test(id)) throw new CourierError('broker-not-configured', 'Invalid broker profile id');
  return path.join(brokerRoot(testOwnerRoot), id, 'config.json');
}

/** The agent may select an opaque profile id, never a path or a host for the broker. */
export function currentProfileId(home = profileDir()): string {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(path.dirname(home), '.courier-agent.json'), 'utf8'));
    if (marker.v === 1 && ID.test(marker.profileId)) return marker.profileId;
  } catch { /* owner invocation: derive the id from its Courier directory */ }
  return profileId(home);
}

export function pinProfile(profile: Profile): BrokerConfig['profile'] {
  return Object.fromEntries(PINNED.map(key => [key, profile[key]])) as BrokerConfig['profile'];
}
export function assertPinnedProfile(config: BrokerConfig, profile: Profile): void {
  for (const key of PINNED) if (config.profile[key] !== profile[key]) throw new CourierError('broker-profile-mismatch', 'Courier profile differs from the owner-pinned broker profile; nothing was consumed');
}

export function saveBrokerConfig(config: BrokerConfig, testOwnerRoot?: string): string {
  const file = brokerFile(profileId(config.courierHome), testOwnerRoot);
  for (const root of [config.courierHome, agentHome(config.courierHome)]) {
    if (realpathBest(file).startsWith(`${realpathBest(root)}${path.sep}`)) throw new CourierError('usage', 'Broker configuration must be outside Courier and the agent HOME');
  }
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
  return file;
}

export function loadBrokerConfig(id: string, testOwnerRoot?: string): BrokerConfig {
  const file = brokerFile(id, testOwnerRoot);
  try {
    for (const f of [path.dirname(file), file]) {
      const st = fs.lstatSync(f);
      if (st.isSymbolicLink() || st.uid !== os.userInfo().uid || (st.mode & 0o077)) throw Error('not owner-private');
    }
    const config: BrokerConfig = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (config.v !== 2 || !path.isAbsolute(config.courierHome) || profileId(config.courierHome) !== id || !path.isAbsolute(config.ghBin) || !config.ghIdentity || !config.profile?.host || !config.profile.spaceId) throw Error('malformed');
    if (testOwnerRoot !== undefined ? config.testToken !== TEST_TOKEN : config.testToken !== undefined) throw Error('test configuration requires explicit private test owner root and fixed dummy token');
    const st = fs.statSync(config.ghBin);
    if (st.dev !== config.ghIdentity.dev || st.ino !== config.ghIdentity.ino) throw Error('gh identity changed');
    assertPinnedProfile(config, loadProfile(config.courierHome));
    return config;
  } catch (error) {
    if (error instanceof CourierError) throw error;
    throw new CourierError('broker-not-configured', 'Broker is not configured or its owner-private configuration is invalid; your owner runs courier broker set-token');
  }
}
