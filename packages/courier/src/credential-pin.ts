import type { CredentialFlowDescriptor } from '@tinycloud/sdk-core';

/*
 * Pinned trust root for `tinycloud.email-proof/v1` credentials (TC-712).
 *
 * The issuer key, kid, validity window and descriptor digest below are compared out of band with
 *   https://witness.credentials.org/.well-known/opencredentials/issuer
 *   https://issuer.credentials.org/.well-known/did.json
 * whenever they are updated. They are never fetched at verify time: verification performs no network I/O.
 * The descriptor is the golden email descriptor; its canonical digest must equal `descriptorDigest`
 * (asserted in test/verify-email-proof.test.mjs).
 */

export interface CredentialPinKey {
  readonly kty: 'OKP';
  readonly crv: 'Ed25519';
  readonly x: string;
}

export interface CredentialPin {
  readonly issuerDid: string;
  readonly kid: string;
  readonly jwk: CredentialPinKey;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly descriptor: CredentialFlowDescriptor;
  readonly descriptorDigest: string;
}

const EMAIL_PROOF_DESCRIPTOR: CredentialFlowDescriptor = {
  type: 'tinycloud.credentials/descriptor/v1',
  contractVersion: 1,
  protocol: 'tinycloud.credentials/acquisition/v1',
  profile: 'tinycloud.email-proof/v1',
  profileVersion: 1,
  display: {
    title: 'Email address',
    description: 'Prove control of your mailbox',
    consent: 'Prove control of your mailbox',
    securityTextLocked: true,
  },
  accessibility: {
    progressLabel: 'Credential acquisition progress',
    errorLiveRegion: 'assertive',
  },
  theme: {
    tokenVersion: 'tinycloud.credentials/tokens/v1',
    allowed: ['accentColor', 'fontFamily', 'borderRadius'],
  },
  issuer: {
    did: 'did:web:issuer.credentials.org',
    origin: 'https://witness.credentials.org',
    kid: 'did:web:issuer.credentials.org#controller',
  },
  interaction: {
    origin: 'https://credentials.org',
    pathTemplate: '/credentials/acquire/{requestId}',
  },
  format: {
    id: 'vc+sd-jwt',
    vct: 'opencredentials.email/v1',
  },
  claims: [
    {
      name: 'email',
      matching: 'normalized_exact',
      selectiveDisclosure: true,
    },
  ],
  subjectRelationship: 'holder_is_subject',
  inputs: [
    {
      id: 'email',
      label: 'Email address',
      schema: {
        type: 'string',
        format: 'email',
        minLength: 3,
        maxLength: 320,
      },
      prefill: 'privacy_hint_only',
      autocomplete: 'off',
    },
  ],
  steps: [
    { type: 'collect_input', version: 1 },
    { type: 'mailbox_otp', version: 1 },
    { type: 'holder_signature', version: 1 },
  ],
  holderBinding: {
    required: true,
    alg: 'EdDSA',
    domain: 'tinycloud.credentials/holder-binding/v1',
    version: 1,
  },
  endpoints: {
    request: 'request',
    state: 'state',
    challenge: 'challenge',
    proof: 'proof',
    holderBinding: 'holder_binding',
    holderSignature: 'holder_signature',
    issue: 'issue',
    result: 'result',
  },
  lifecycle: {
    requestTtlSeconds: 600,
    challengeTtlSeconds: 300,
    maxProofAttempts: 5,
    challengeConsumption: 'atomic_once',
    retry: 'bounded',
  },
  status: {
    type: 'none',
    freshnessSeconds: 300,
  },
  revocation: {
    supported: false,
  },
  presentation: {
    stateVersion: 'tinycloud.credentials/ux-states/v1',
    states: [
      'collecting',
      'challenging',
      'proving',
      'signing',
      'issuing',
      'verifying',
      'saving',
      'success',
      'recovery',
    ],
  },
};

export const EMAIL_PROOF_PIN: CredentialPin = {
  issuerDid: 'did:web:issuer.credentials.org',
  kid: 'did:web:issuer.credentials.org#controller',
  jwk: {
    kty: 'OKP',
    crv: 'Ed25519',
    x: 'eEJI4xEobto4HtQ7Pg9R1vBOwcpfGRTlXDG5QfqLnGQ',
  },
  validFrom: '2020-01-01T00:00:00Z',
  validUntil: '2100-01-01T00:00:00Z',
  descriptor: EMAIL_PROOF_DESCRIPTOR,
  descriptorDigest: '1tg-qphmKBVtNwzVg9xyz-xxqt_xtMXAsQyXw46m8S0',
};

/** Pinned Ed25519 key for `kid`, or null. Only the pinned kid resolves. */
export function issuerKeyFor(kid: string, pin: CredentialPin = EMAIL_PROOF_PIN): CredentialPinKey | null {
  return kid === pin.kid ? pin.jwk : null;
}
