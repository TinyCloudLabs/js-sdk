# @tinycloud/server

Reusable server and agent helpers for TinyCloud backends.

Servers use a raw Ethereum private key as a stable `did:pkh` identity. OpenKey is
for browser and human-owner sign-in flows; it is not the backend identity.

```ts
import {
  createServerDelegateClient,
  createServerIdentity,
  createSiweSession,
} from "@tinycloud/server";

const identity = await createServerIdentity({
  privateKey: process.env.TC_SERVER_PRIVATE_KEY!,
  host: process.env.TC_HOST,
});

console.log(identity.did);

const delegated = createServerDelegateClient({
  privateKey: process.env.TC_SERVER_PRIVATE_KEY!,
  host: process.env.TC_HOST,
  delegation: ownerDelegation,
});

const githubToken = await delegated.getSecret("GITHUB_TOKEN", { scope: "githaiku" });

const auth = createSiweSession({ jwtSecret: process.env.TC_SERVER_PRIVATE_KEY! });
const nonce = auth.issueNonce(ownerAddress);
const session = await auth.verify(siweMessage, signature);
const owner = auth.verifyToken(session.token);
```

For dstack TEEs, derive the server key from the guest-agent client and pass it to
`createServerIdentity`:

```ts
import { deriveDstackPrivateKey } from "@tinycloud/server";

const privateKey = await deriveDstackPrivateKey({
  client: dstackClient,
  path: "my-app/keys/server",
  purpose: "server",
});
```

`createServerDelegateClient` activates the whole PortableDelegation before
reading secrets. That keeps both the delegated KV-get and
`tinycloud.encryption/decrypt` proof in the activation chain.
