import type { FeedApi, FeedResponse } from "./types";
import { validDispatchBefore } from "./dispatch";

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
  if (response.kind !== "message" && response.choiceId !== undefined) notification.choiceId = response.choiceId;
  if (response.text !== undefined) notification.text = response.text;
  if (response.kind !== "message" && response.supersedesResponseId !== undefined) notification.supersedesResponseId = response.supersedesResponseId;
  if (response.payloadType !== undefined) notification.payloadType = response.payloadType;
  if (response.payloadVersion !== undefined) notification.payloadVersion = response.payloadVersion;
  if (validDispatchBefore(response.dispatchBefore)) notification.dispatchBefore = response.dispatchBefore;
  return notification;
};
