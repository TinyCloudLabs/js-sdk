import { feedJson } from "./store";
import type { FeedCard } from "./types";

/** A card's fields without the revision's own identity and time, which differ between any two revisions. */
function comparable(card: FeedCard): { fields: Record<string, unknown>; payload: Record<string, unknown> } {
  // A null prototype: a JSON `__proto__` key is an own property of the parsed card and must be compared like any other key.
  const fields: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(card)) {
    if (key !== "revision" && key !== "issuanceId" && key !== "createdAt" && key !== "payload") fields[key] = value;
  }
  return { fields, payload: card.payload ?? {} };
}

function without(record: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const rest: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(record)) if (!keys.includes(key)) rest[key] = value;
  return rest;
}

/**
 * True only when `next` is `previous` plus appended agent replies: the same card, a higher revision, every card field and
 * payload key structurally identical (canonical JSON) except `payload.replies`, and those replies a strict append (the
 * first k identical, at least one more). The single exception: the revision that adds a "post" card's first reply may
 * also change `payload.render` from "post" (or absent) to "thread". Revision, issuance and createdAt are the revision's own
 * identity and time, so they are not compared.
 *
 * This is the rule Home applies (`isReplyOnlyRevision`, tinychat `frontend/src/feed/replyOnlyRevision.ts`), on cards of one
 * agent's output database: a reply-only revision is the same request, so the owner's earlier answer still stands.
 */
export function isReplyOnlyRevision(previous: FeedCard, next: FeedCard): boolean {
  if (previous.cardId !== next.cardId || next.revision <= previous.revision) return false;
  const before = comparable(previous);
  const after = comparable(next);
  if (feedJson(before.fields) !== feedJson(after.fields)) return false;
  const beforeReplies = before.payload.replies ?? [];
  const afterReplies = after.payload.replies;
  if (!Array.isArray(beforeReplies) || !Array.isArray(afterReplies) || afterReplies.length <= beforeReplies.length) return false;
  const beforeOthers = without(before.payload, "replies");
  const afterOthers = without(after.payload, "replies");
  // An absent render (or payload) is a post here, and only here.
  const firstReply = (beforeOthers.render === undefined || beforeOthers.render === "post") &&
    afterOthers.render === "thread" && beforeReplies.length === 0;
  const same = firstReply
    ? feedJson(without(beforeOthers, "render")) === feedJson(without(afterOthers, "render"))
    : feedJson(beforeOthers) === feedJson(afterOthers);
  return same && beforeReplies.every((reply, index) => feedJson(reply) === feedJson(afterReplies[index]));
}
