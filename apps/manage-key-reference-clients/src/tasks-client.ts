import {
  parseCanonicalTinyCloudIdentityClaims,
  type CanonicalTinyCloudIdentity,
} from "@tinycloud/sdk-core";

export const TASKS_CLIENT_ID = "tinycloud-reference-tasks";

export interface TasksOAuthResponse {
  client_id: string;
  access_token: string;
  id_token_claims: unknown;
}

/** A Tasks-only token store; it never shares OAuth state with Notes. */
export class TasksTokenStore {
  #token: string | undefined;

  save(response: TasksOAuthResponse): CanonicalTinyCloudIdentity {
    if (response.client_id !== TASKS_CLIENT_ID) {
      throw new Error("Tasks received an OAuth response for another client");
    }
    this.#token = response.access_token;
    return parseCanonicalTinyCloudIdentityClaims(response.id_token_claims);
  }

  accessToken(): string | undefined {
    return this.#token;
  }
}
