import { NotesOAuthClient } from "./notes-client";
import { startReferenceOAuthIssuer } from "./reference-oauth-issuer";
import { TasksOAuthClient } from "./tasks-client";

export async function runReferenceClients() {
  const issuer = startReferenceOAuthIssuer();
  try {
    const notes = await new NotesOAuthClient(issuer.baseUrl).signIn();
    const tasks = await new TasksOAuthClient(issuer.baseUrl).authenticate();
    if (
      notes.identity.address !== tasks.identity.address ||
      notes.identity.did !== tasks.identity.did ||
      notes.identity.spaceId !== tasks.identity.spaceId
    ) {
      throw new Error("Independent OAuth clients resolved different canonical identities");
    }
    return { notes, tasks, events: [...issuer.events] };
  } finally {
    issuer.stop();
  }
}

if (import.meta.main) {
  const { notes, tasks, events } = await runReferenceClients();
  console.log(JSON.stringify({
    notes: { did: notes.identity.did, spaceId: notes.identity.spaceId },
    tasks: { did: tasks.identity.did, spaceId: tasks.identity.spaceId },
    oauthEvents: events,
  }, null, 2));
}
