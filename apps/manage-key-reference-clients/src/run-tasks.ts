import { startReferenceOAuthIssuer } from "./reference-oauth-issuer";
import { TasksOAuthClient } from "./tasks-client";

const issuer = startReferenceOAuthIssuer();
try {
  const session = await new TasksOAuthClient(issuer.baseUrl).authenticate();
  console.log(JSON.stringify({
    client: "tasks",
    did: session.identity.did,
    spaceId: session.identity.spaceId,
  }, null, 2));
} finally {
  issuer.stop();
}
