# OAuth canonical-key signer

`@tinycloud/sdk-core` exposes a generic signer for an OAuth client that has
been explicitly consented for `tinycloud:manage-key`. The shared adapter has
no application, space-name, or first-party session-token dependency.

Request the additional OAuth scope during the authorization redirect. The SDK
only uses it after the issuer returns a bearer token whose granted scopes
include it:

```ts
import {
  requestTinyCloudManageKeyScope,
  parseCanonicalTinyCloudIdentityClaims,
  createOpenKeyManageKeySigningStrategy,
} from "@tinycloud/sdk-core";

const scope = requestTinyCloudManageKeyScope("openid profile");
// Send `scope` to your OAuth issuer. After the redirect, validate the ID token
// with your OAuth library before passing its claims to the SDK.
const identity = parseCanonicalTinyCloudIdentityClaims(validatedIdTokenClaims);

const signStrategy = createOpenKeyManageKeySigningStrategy({
  endpoint: issuerManageKeyEndpoint,
  token: accessToken,
  scopes: grantedScopes,
  identity,
});
```

The identity claim is named
`https://tinycloud.xyz/canonical_identity` and must contain exactly
`version`, `keyId`, checksummed `address`, `chainId`, `did`, and `spaceId`.
The SDK derives the DID and space from the EIP-55 address and rejects any
claim that does not match. It sends the exact SIWE/ReCap string once, through
a bearer-only request with cookies omitted, and verifies the returned EIP-191
signature against that canonical address.

For the web SDK, use `establishManageKeySession` to install the signer and
perform the normal public `TinyCloudWeb.signIn()` flow. The helper deliberately
does not accept a provider, alternate signing strategy, or
`autoBootstrapAccount`: a manage-key grant can sign the one scoped session
SIWE but cannot silently authorize bootstrap requests. Browser session
persistence remains configurable through the remaining `TinyCloudWeb` config;
a restored session does not require another signature.

```ts
import { establishManageKeySession } from "@tinycloud/web-sdk";

const { client, identity, session } = await establishManageKeySession({
  identity: validatedIdTokenClaims[
    "https://tinycloud.xyz/canonical_identity"
  ],
  signer: {
    endpoint: issuerManageKeyEndpoint,
    token: accessToken,
    scopes: grantedScopes,
  },
  tinycloud: {
    capabilityRequest: requestedCapabilities,
    persistSession: true,
  },
});
```

`OpenKeyManageKeyError` is terminal (`retryable === false`) and has one of
`CONSENT_REQUIRED`, `GRANT_DISABLED`, `USER_EXCLUSIVE`, `TOKEN_EXPIRED`,
`MESSAGE_REJECTED`, or `IDENTITY_MISMATCH`. Do not retry it in a loop. When an
issuer supplies `approvalUrl`, the error preserves it so the application can
restart OAuth or show its consent route. Otherwise, restart the authorization
redirect with `requestTinyCloudManageKeyScope`.

The two independent example adapters in
`examples/manage-key-reference-clients/` show Notes consuming validated OIDC
claims and Tasks consuming the canonical claim supplied by its OAuth adapter.
For the same user both resolve the same canonical address, DID, and space.
