import fs from 'node:fs';
import type { ParsedArgs } from './args.js';
import { CourierError } from './errors.js';
import { CREDENTIAL_MAX_BYTES } from './invite-schema.js';

/** What the invitee's proof is bound to. v1 sources ignore it; the inviter-side verifier checks it. */
export interface CredentialBinding {
  courierDid: string;
  inviteId: string;
}

/**
 * Supplies the email-ownership credential that `join` puts in hello.json.
 * v1 reads it from the operator (file or stdin). TC-1757 plugs an approve-once
 * source in behind this interface. Resolves undefined when no proof is available.
 */
export interface CredentialSource {
  getEmailProof(address: string, binding: CredentialBinding): Promise<string | undefined>;
}

function fromText(text: string, origin: string): string {
  const credential = text.trim();
  if (credential === '') throw new CourierError('usage', `${origin} is empty; expected an email credential.`);
  if (Buffer.byteLength(credential, 'utf8') > CREDENTIAL_MAX_BYTES) {
    throw new CourierError('usage', `${origin} is over ${CREDENTIAL_MAX_BYTES} bytes.`);
  }
  return credential;
}

/**
 * Builds the source from `--credential-file <path>` or `--credential-stdin`.
 * Returns undefined when neither flag is given. The credential is never echoed in errors.
 */
export function credentialSourceFromArgs(args: ParsedArgs): CredentialSource | undefined {
  const file = args.get('credential-file');
  const stdin = args.has('credential-stdin');
  if (file !== undefined && stdin) {
    throw new CourierError('usage', '--credential-file and --credential-stdin are mutually exclusive.');
  }
  if (file === undefined && !stdin) return undefined;
  if (file === 'true') throw new CourierError('usage', '--credential-file needs a path.');

  let loaded: string | undefined;
  const load = (): string => {
    if (loaded !== undefined) return loaded;
    if (file !== undefined) {
      const size = fs.statSync(file).size;
      if (size > CREDENTIAL_MAX_BYTES) throw new CourierError('usage', `--credential-file is over ${CREDENTIAL_MAX_BYTES} bytes.`);
      loaded = fromText(fs.readFileSync(file, 'utf8'), '--credential-file');
    } else {
      loaded = fromText(fs.readFileSync(0, 'utf8'), '--credential-stdin');
    }
    return loaded;
  };
  return {
    async getEmailProof() {
      return load();
    },
  };
}
