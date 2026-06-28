# Server and Agent Consumers

Use `@tinycloud/server` for backend identities, delegated owner secrets, and
single-signature SIWE sessions.

Servers and agents should use a stable raw-key `did:pkh` identity. In development
this usually comes from an environment variable. In a dstack TEE, derive it from
guest-agent key material with `deriveDstackPrivateKey`. OpenKey is only for
browser or human-owner sign-in flows.

```ts
import {
  createServerDelegateClient,
  createServerIdentity,
  createSiweSession,
} from "@tinycloud/server";

const privateKey = process.env.TC_SERVER_PRIVATE_KEY!;

const server = await createServerIdentity({
  privateKey,
  host: process.env.TC_HOST,
});

const delegated = createServerDelegateClient({
  privateKey,
  host: process.env.TC_HOST,
  delegation: serializedOwnerDelegation,
});

const token = await delegated.getSecret("GITHUB_TOKEN", { scope: "my-agent" });

const sessions = createSiweSession({ jwtSecret: privateKey });
```

Owner flow:

1. The backend advertises `server.did` as the delegation audience.
2. The owner stores a secret with the web SDK or node SDK.
3. The owner delegates KV-get on the secret vault path and
   `tinycloud.encryption/decrypt` on their encryption network to the backend DID.
4. The backend stores the serialized PortableDelegation.
5. The backend passes that whole delegation to `createServerDelegateClient` and
   calls `getSecret`.

Do not narrow the stored delegation to only the KV resource before activation.
The decrypt proof must include the delegation chain that carries
`tinycloud.encryption/decrypt`.
