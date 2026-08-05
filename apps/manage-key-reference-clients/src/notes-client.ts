import {
  parseCanonicalTinyCloudIdentityClaims,
  type CanonicalTinyCloudIdentity,
} from "@tinycloud/sdk-core";

export const NOTES_CLIENT_ID = "tinycloud-reference-notes";

export interface NotesOAuthResponse {
  client_id: string;
  access_token: string;
  claims: unknown;
}

/** A Notes-only token store; it never shares OAuth state with Tasks. */
export class NotesTokenStore {
  #token: string | undefined;

  save(response: NotesOAuthResponse): CanonicalTinyCloudIdentity {
    if (response.client_id !== NOTES_CLIENT_ID) {
      throw new Error("Notes received an OAuth response for another client");
    }
    this.#token = response.access_token;
    return parseCanonicalTinyCloudIdentityClaims(response.claims);
  }

  accessToken(): string | undefined {
    return this.#token;
  }
}
