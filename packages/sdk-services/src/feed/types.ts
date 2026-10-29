import type { IDatabaseHandle } from "../sql/ISQLService";
import type { HookSubscription } from "../hooks/types";
import type { IHooksService } from "../hooks/IHooksService";
import type { Result } from "../types";

export type FeedDatabase = Pick<IDatabaseHandle, "query" | "execute" | "batch">;
export type FeedReadDatabase = Pick<IDatabaseHandle, "query">;

export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };

export interface FeedResponsePayload {
  type: string;
  version: number;
  data: JSONValue;
}

export interface FeedCardIdentity {
  cardId: string;
  revision: number;
  issuanceId: string;
}

export interface FeedChoice {
  id: string;
  label: string;
}

export interface FeedCard extends FeedCardIdentity {
  kind: string;
  needsResponse: boolean;
  title: string;
  body: string;
  choices?: FeedChoice[];
  urgency: number;
  createdAt: string;
  payload?: Record<string, unknown>;
}

export interface FeedResponseIdentity extends FeedCardIdentity {
  responseId: string;
}

export interface NewFeedResponse extends FeedResponseIdentity {
  kind: "answer" | "followup";
  choiceId?: string;
  text?: string;
  supersedesResponseId?: string;
  createdAt: string;
}

export interface NewFeedMessage extends FeedResponseIdentity {
  kind: "message";
  text: string;
  createdAt: string;
}

export interface FeedResponse extends Omit<NewFeedResponse, "kind"> {
  kind: NewFeedResponse["kind"] | "message";
  sequence: number;
  payloadType?: string;
  payloadVersion?: number;
}

export interface FeedHandling extends FeedCardIdentity {
  handlingId: string;
  responseId: string;
  phase: "acknowledged" | "succeeded" | "failed";
  createdAt: string;
  detail?: Record<string, unknown>;
}

export interface FeedResponseHandling {
  acknowledgement: FeedHandling | null;
  outcome: FeedHandling | null;
}

export interface FeedCardState extends FeedResponseHandling {
  card: FeedCard;
  response: FeedResponse | null;
}

export interface FeedDatabases {
  output: FeedDatabase;
  responses: FeedDatabase;
}

export interface FeedHandoff {
  responseId: string;
  recipient: string;
  response: FeedResponse;
  state: "prepared" | "unconfirmed" | "delivered";
}

export interface FeedDeliveryOptions {
  handoff: FeedDatabase;
  recipient: string;
  response: FeedResponse;
  // The durable handoff is unconfirmed before this callback starts.
  // Throwing or returning unconfirmed never authorizes an automatic resend.
  deliver: (response: FeedResponse) => Promise<"delivered" | "unconfirmed">;
}

export type FeedHooks = Pick<IHooksService, "subscribe">;

export interface FeedListenerOptions {
  responses: FeedReadDatabase;
  handoff: FeedDatabase;
  recipient: string;
  hooks: FeedHooks;
  subscription: HookSubscription;
  deliver: FeedDeliveryOptions["deliver"];
  signal: AbortSignal;
  // Low-frequency ticket renewal, not an idle response SELECT loop.
  renewalSeconds?: number;
}

// Registry, view state, and preferences belong to the owner's separate store.
// Source IDs and card labels are references, never authorization claims.
export interface FeedSource {
  sourceId: string;
  agentDid: string;
  label: string;
  output: { spaceId: string; database: string };
  responses: { spaceId: string; database: string };
}

export type FeedSelector = "information" | "both" | "needs-action";

export interface FeedOwnerView extends FeedCardIdentity {
  sourceId: string;
  seenAt?: string;
  snoozedUntil?: string;
}

export interface FeedOwnerSettings {
  defaultSelector: FeedSelector;
}

export interface FeedApi {
  feedResourceNames(prefix: string, stableToken: string): Result<{ outputResource: string; responseResource: string }>;
  initializeFeedDatabases(databases: FeedDatabases): Promise<Result<void>>;
  publishFeedCard(output: FeedDatabase, card: FeedCard): Promise<Result<FeedCard>>;
  appendFeedResponse(
    output: FeedReadDatabase,
    responses: FeedDatabase,
    response: NewFeedResponse,
    payload?: FeedResponsePayload,
  ): Promise<Result<FeedResponse>>;
  appendFeedMessage(
    output: FeedReadDatabase,
    responses: FeedDatabase,
    input: NewFeedMessage,
    payload?: FeedResponsePayload,
  ): Promise<Result<FeedResponse>>;
  readFeedResponsePayload(
    responses: FeedReadDatabase,
    identity: FeedResponseIdentity,
  ): Promise<Result<FeedResponsePayload | undefined>>;
  projectFeedResponseNotification(response: FeedResponse): FeedResponse;
  listFeedCards(output: FeedReadDatabase): Promise<Result<FeedCard[]>>;
  listFeedResponses(
    responses: FeedReadDatabase,
    options?: { afterSequence?: number; limit?: number; signal?: AbortSignal },
  ): Promise<Result<FeedResponse[]>>;
  recordFeedHandling(output: FeedDatabase, handling: FeedHandling): Promise<Result<FeedHandling>>;
  readFeedResponseHandling(output: FeedReadDatabase, identity: FeedResponseIdentity): Promise<Result<FeedResponseHandling>>;
  getFeedCardState(
    output: FeedReadDatabase,
    responses: FeedReadDatabase,
    identity: FeedCardIdentity,
  ): Promise<Result<FeedCardState>>;
  resolveFeedCard(output: FeedReadDatabase, reference: string): Promise<Result<FeedCardIdentity>>;
  initializeFeedHandoff(handoff: FeedDatabase): Promise<Result<void>>;
  getFeedHandoff(
    handoff: FeedReadDatabase,
    responseId: string,
    recipient: string,
  ): Promise<Result<FeedHandoff | null>>;
  deliverFeedResponse(options: FeedDeliveryOptions): Promise<Result<FeedHandoff>>;
  listenFeedResponses(options: FeedListenerOptions): Promise<void>;
}
