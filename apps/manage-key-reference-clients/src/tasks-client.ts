import {
  parseCanonicalTinyCloudIdentityClaims,
  requestTinyCloudManageKeyScope,
  type CanonicalTinyCloudIdentity,
} from "@tinycloud/sdk-core";

export const TASKS_CLIENT_ID = "tinycloud-reference-tasks";
const TASKS_REDIRECT_URI = "http://tasks.reference.local/auth/complete";

export interface TasksOAuthResponse {
  audience: string;
  token: string;
  id_token_claims: unknown;
}

export interface TasksSession {
  bearer: string;
  identity: CanonicalTinyCloudIdentity;
}

/** Tasks owns a differently shaped response and a separate token store. */
export class TasksTokenStore {
  #session: TasksSession | undefined;

  store(response: TasksOAuthResponse): TasksSession {
    if (response.audience !== TASKS_CLIENT_ID) {
      throw new Error("Tasks received an OAuth response for another client");
    }
    const session = {
      bearer: response.token,
      identity: parseCanonicalTinyCloudIdentityClaims(response.id_token_claims),
    };
    this.#session = session;
    return session;
  }

  active(): TasksSession | undefined {
    return this.#session;
  }
}

/** A runnable Tasks OAuth authorization-code client. */
export class TasksOAuthClient {
  readonly tokens = new TasksTokenStore();

  constructor(private readonly issuer: string) {}

  async authenticate(): Promise<TasksSession> {
    const state = crypto.randomUUID();
    const authorize = new URL("/tasks/authorize", this.issuer);
    authorize.search = new URLSearchParams({
      client_id: TASKS_CLIENT_ID,
      redirect_uri: TASKS_REDIRECT_URI,
      response_type: "code",
      scope: requestTinyCloudManageKeyScope(["openid", "tasks.write"]),
      state,
    }).toString();
    const authorization = await fetch(authorize, { redirect: "manual" });
    if (authorization.status !== 302) {
      throw new Error(`Tasks authorization failed with HTTP ${authorization.status}`);
    }
    const callback = new URL(required(authorization.headers.get("location"), "redirect"));
    if (callback.origin + callback.pathname !== new URL(TASKS_REDIRECT_URI).origin + new URL(TASKS_REDIRECT_URI).pathname) {
      throw new Error("Tasks OAuth redirect URI changed");
    }
    if (callback.searchParams.get("state") !== state) {
      throw new Error("Tasks OAuth state did not round-trip");
    }
    const exchange = await fetch(new URL("/tasks/token", this.issuer), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: TASKS_CLIENT_ID,
        redirect_uri: TASKS_REDIRECT_URI,
        code: required(callback.searchParams.get("code"), "authorization code"),
      }),
    });
    if (!exchange.ok) {
      throw new Error(`Tasks token exchange failed with HTTP ${exchange.status}`);
    }
    return this.tokens.store(await exchange.json() as TasksOAuthResponse);
  }
}

function required(value: string | null, field: string): string {
  if (!value) throw new Error(`Tasks OAuth response is missing ${field}`);
  return value;
}
