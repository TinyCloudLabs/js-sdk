import type { TinyCloudNode } from '@tinycloud/node-sdk';
import { k } from './keys.js';
import { listAll } from './store.js';

/**
 * Whether the node hosts the agents space for a restored Courier session: one read under the session's own prefix.
 * Only the node's "Space not found" means no; any other failure (auth, network) propagates, so a caller never takes it for an answer.
 * Install, resume and an `awaiting-space` profile's next command all ask this one question.
 */
export async function verifySpaceReady(node: TinyCloudNode): Promise<boolean> {
  try {
    await listAll(node.kv, k.mePrefix);
    return true;
  } catch (error) {
    if (/space not found/i.test(String((error as Error).message))) return false;
    throw error;
  }
}
