import {
  parseCanonicalTinyCloudIdentityClaims,
  requestTinyCloudManageKeyScope,
  type CanonicalTinyCloudIdentity,
} from "@tinycloud/sdk-core";

export const NOTES_CLIENT_ID = "tinycloud-reference-notes";
const NOTES_REDIRECT_URI = "http://notes.reference.local/oauth/callback";

export interface NotesOAuthResponse {
  client_id: string;
  access_token: string;
  claims: unknown;
}

export interface NotesSession {
  accessToken: string;
  identity: CanonicalTinyCloudIdentity;
}

/** Notes owns this token store and never reads Tasks OAuth state. */
export class NotesTokenStore {
  #session: NotesSession | undefined;

  save(response: NotesOAuthResponse): NotesSession {
    if (response.client_id !== NOTES_CLIENT_ID) {
      throw new Error("Notes received an OAuth response for another client");
    }
    const session = {
      accessToken: response.access_token,
      identity: parseCanonicalTinyCloudIdentityClaims(response.claims),
    };
    this.#session = session;
    return session;
  }

  current(): NotesSession | undefined {
    return this.#session;
  }
}

/** A runnable Notes OAuth authorization-code client. */
export class NotesOAuthClient {
  readonly tokens = new NotesTokenStore();

  constructor(private readonly issuer: string) {}

  async signIn(): Promise<NotesSession> {
    const state = crypto.randomUUID();
    const authorize = new URL("/notes/authorize", this.issuer);
    authorize.search = new URLSearchParams({
      client_id: NOTES_CLIENT_ID,
      redirect_uri: NOTES_REDIRECT_URI,
      response_type: "code",
      scope: requestTinyCloudManageKeyScope("openid notes.read"),
      state,
    }).toString();
    const authorization = await fetch(authorize, { redirect: "manual" });
    if (authorization.status !== 302) {
      throw new Error(`Notes authorization failed with HTTP ${authorization.status}`);
    }
    const callback = new URL(required(authorization.headers.get("location"), "redirect"));
    if (callback.origin + callback.pathname !== new URL(NOTES_REDIRECT_URI).origin + new URL(NOTES_REDIRECT_URI).pathname) {
      throw new Error("Notes OAuth redirect URI changed");
    }
    if (callback.searchParams.get("state") !== state) {
      throw new Error("Notes OAuth state did not round-trip");
    }
    const exchange = await fetch(new URL("/notes/token", this.issuer), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: NOTES_CLIENT_ID,
        redirect_uri: NOTES_REDIRECT_URI,
        code: required(callback.searchParams.get("code"), "authorization code"),
      }),
    });
    if (!exchange.ok) {
      throw new Error(`Notes token exchange failed with HTTP ${exchange.status}`);
    }
    return this.tokens.save(await exchange.json() as NotesOAuthResponse);
  }
}

function required(value: string | null, field: string): string {
  if (!value) throw new Error(`Notes OAuth response is missing ${field}`);
  return value;
}
