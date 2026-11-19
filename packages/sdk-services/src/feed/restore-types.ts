import type {
  FeedCard, FeedResponse, FeedResponsePayload, NewFeedMessage, NewFeedResponse,
} from "./types";

/** Provenance only; these client fields do not grant database authority. */
export interface FeedRestoreOrigin {
  sourceSpaceId: string;
  namespace: string;
  snapshotId: string;
  sourceKey: string;
  eventKey?: string;
}

export interface FeedRestoreDeliveryPolicy {
  recipient: string;
  state: "pending" | "held" | "delivered" | "unconfirmed" | "refused" | "unknown";
  dispatch: "never" | "resolved-pending" | "held";
  resolvedOwnerMapping: boolean;
  /** Required: null explicitly means there is no absolute execution cutoff. */
  dispatchBefore: string | null;
  source: FeedRestoreOrigin;
}

export interface FeedRestoreResponse {
  response: NewFeedResponse | NewFeedMessage;
  payload?: FeedResponsePayload;
  origin: FeedRestoreOrigin;
  deliveries?: FeedRestoreDeliveryPolicy[];
}

export interface FeedRestoreRecords {
  cards: FeedCard[];
  responses: FeedRestoreResponse[];
}

/** Cursor covers every verified header, including imported rows denied dispatch. */
export interface FeedResponseDeliveryPage {
  responses: FeedResponse[];
  nextSequence: number;
  hasMore: boolean;
}
