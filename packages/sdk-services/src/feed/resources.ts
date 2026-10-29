import { ok } from "../types";
import { feedError } from "./store";
import type { FeedApi } from "./types";

export const feedResourceNames: FeedApi["feedResourceNames"] = (prefix, stableToken) => {
  if (!/^[A-Za-z0-9_-]+$/.test(stableToken) || !prefix || prefix.endsWith("/") ||
    prefix.split("/").some((part) => !part || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part))) {
    return feedError("INVALID_INPUT", "Feed resources require a canonical prefix and a stable alphanumeric, underscore or hyphen agent token");
  }
  return ok({
    outputResource: `${prefix}/feed_output_${stableToken}`,
    responseResource: `${prefix}/feed_responses_${stableToken}`,
  });
};
