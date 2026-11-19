import { ZodEffects, ZodObject, defaultErrorMap, type ZodError, type ZodIssue, type ZodTypeAny } from "zod";

/** Enough to correct a call without listing every element of a long array. */
const MAX_REASONS = 5;

/**
 * Says which input field failed and what it accepts, so the caller can correct
 * the call. This message crosses the canonical error channel unredacted, so
 * every word is schema-owned: a declared top-level property, array positions,
 * the schema's own message, a type or a limit. Input keys and values never
 * appear.
 */
export function invalidInputMessage(schema: ZodTypeAny, error: ZodError): string {
  let root = schema;
  while (root instanceof ZodEffects) root = root.innerType();
  const declared: object = root instanceof ZodObject ? root.shape : {};
  const reasons = new Set<string>();
  for (const issue of error.issues) {
    const [field, ...rest] = issue.path;
    let where = "input";
    if (typeof field === "string" && Object.prototype.hasOwnProperty.call(declared, field)) {
      where = field;
      // Below the top level only positions are certain to be schema-owned: a deeper name can be a caller's own key.
      for (const part of rest) {
        if (typeof part !== "number") break;
        where += `[${part}]`;
      }
    }
    reasons.add(`${where}: ${accepted(issue).replace(/\.$/, "")}`);
    if (reasons.size === MAX_REASONS) break;
  }
  return `The operation input is invalid. ${[...reasons].join("; ")}.`;
}

/**
 * A message the schema wrote is constant text. One zod composed can quote the
 * input (an unknown key, a rejected value), so it is rebuilt from the issue's
 * schema-owned limits instead.
 */
function accepted(issue: ZodIssue): string {
  if (issue.message !== defaultErrorMap(issue, { data: undefined, defaultError: "" }).message) return issue.message;
  switch (issue.code) {
    case "invalid_type":
      return issue.received === "undefined" ? "required" : `must be ${issue.expected}`;
    case "invalid_enum_value":
      return `must be one of ${issue.options.join(", ")}`;
    case "too_small":
    case "too_big": {
      const measured = issue.type === "string" ? " characters" : issue.type === "array" || issue.type === "set" ? " items" : "";
      return issue.code === "too_small" ? `minimum${measured} ${issue.minimum}` : `maximum${measured} ${issue.maximum}`;
    }
    case "unrecognized_keys":
      return "has a property this operation does not accept";
    default:
      return "not in an accepted form";
  }
}
