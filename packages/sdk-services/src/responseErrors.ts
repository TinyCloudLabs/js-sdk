export interface ParsedServiceErrorBody {
  error?: string;
  message?: string;
  code?: string;
}

export function parseServiceErrorBody(errorText: string): ParsedServiceErrorBody {
  try {
    return JSON.parse(errorText) as ParsedServiceErrorBody;
  } catch {
    return {};
  }
}

export function formatServiceResponseError(
  serviceLabel: string,
  operation: string,
  status: number,
  errorText: string,
  parsed: ParsedServiceErrorBody,
): string {
  if (parsed.message) {
    return compactMessage(parsed.message);
  }

  if (looksLikeHtml(errorText)) {
    if (status === 524 || /524\s*[:-]/i.test(errorText) || /a timeout occurred/i.test(errorText)) {
      return `${serviceLabel} ${operation} failed: upstream request timed out. Please retry.`;
    }
    return `${serviceLabel} ${operation} failed: upstream service returned an HTML error page (${status}).`;
  }

  return `${serviceLabel} ${operation} failed: ${status} - ${compactMessage(errorText)}`;
}

export function responseErrorMeta(
  status: number,
  statusText: string,
  errorText: string,
): Record<string, unknown> {
  const meta: Record<string, unknown> = { status, statusText };
  const snippet = compactMessage(errorText);
  if (snippet) {
    meta.responseSnippet = snippet.slice(0, 300);
  }
  return meta;
}

function looksLikeHtml(text: string): boolean {
  return /<!doctype html/i.test(text) || /<html[\s>]/i.test(text);
}

function compactMessage(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 500 ? `${compact.slice(0, 500)}...` : compact;
}
