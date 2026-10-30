import type { FeedCard, FeedCardIdentity } from "./types";

export interface FeedCardHistoryPage {
  cards: FeedCard[];
  nextIdentity: FeedCardIdentity | null;
  hasMore: boolean;
}
