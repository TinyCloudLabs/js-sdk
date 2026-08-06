import { NotesOAuthClient } from "./notes-client";
import { startReferenceOAuthIssuer } from "./reference-oauth-issuer";

const issuer = startReferenceOAuthIssuer();
try {
  const session = await new NotesOAuthClient(issuer.baseUrl).signIn();
  console.log(JSON.stringify({
    client: "notes",
    did: session.identity.did,
    spaceId: session.identity.spaceId,
  }, null, 2));
} finally {
  issuer.stop();
}
