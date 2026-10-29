import type { FeedApi, FeedResponse } from "./types";

/** A notification is an allowlisted header, never a copy of private payload data. */
export const projectFeedResponseNotification: FeedApi["projectFeedResponseNotification"] = (response) => {
  const notification: FeedResponse = {
    responseId: response.responseId,
    cardId: response.cardId,
    revision: response.revision,
    issuanceId: response.issuanceId,
    kind: response.kind,
    createdAt: response.createdAt,
    sequence: response.sequence,
  };
  if (response.choiceId !== undefined) notification.choiceId = response.choiceId;
  if (response.text !== undefined) notification.text = response.text;
  if (response.supersedesResponseId !== undefined) notification.supersedesResponseId = response.supersedesResponseId;
  if (response.payloadType !== undefined) notification.payloadType = response.payloadType;
  if (response.payloadVersion !== undefined) notification.payloadVersion = response.payloadVersion;
  return notification;
};
