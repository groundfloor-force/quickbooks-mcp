/** One entry of a QBO fault: what QuickBooks reports in Fault.Error[]. */
interface QboFaultEntry {
  Message?: string;
  Detail?: string;
  code?: string;
  element?: string;
}

// What scrub() removes, modelled on the redaction test in company-attachable.handlers.test.ts:
// a QBO Detail can name the company (realm id), the request (Intuit trace id) or a person.
const KEYED_ID = /\b(?:realm(?:_?id)?|(?:intuit_)?tid|trace(?:_?id)?)\s*[=:]\s*[^\s,;)]+/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const LONG_NUMBER = /\d{10,}/g;

/**
 * Removes email addresses, realmId=/tid=/trace= style fragments and any number of 10 or more
 * digits from QBO-supplied text, so a fault's Detail can be shown to the caller.
 */
export function scrub(text: string): string {
  return text
    .replace(KEYED_ID, "")
    .replace(EMAIL, "")
    .replace(LONG_NUMBER, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * The first QBO fault entry node-quickbooks handed over, if any. An HTTP 4xx/5xx arrives as the
 * axios error (fault at response.data), an HTTP 200 carrying a Fault arrives as the parsed body,
 * and the upload path passes the first element of the response array.
 */
function qboFaultEntry(error: unknown): QboFaultEntry | undefined {
  const e = error as any;
  const fault = e?.response?.data?.Fault ?? e?.Fault ?? e?.[0]?.Fault;
  return fault?.Error?.[0];
}

/** `Error: <Message> — <Detail> (QBO code <code>, element <element>)`, missing pieces omitted. */
function formatQboFault(entry: QboFaultEntry): string | undefined {
  const detail = entry.Detail ? scrub(entry.Detail) : "";
  const text = [entry.Message, detail].filter(Boolean).join(" — ");
  const where = [entry.code && `QBO code ${entry.code}`, entry.element && `element ${entry.element}`]
    .filter(Boolean)
    .join(", ");
  const parts = [text, where && `(${where})`].filter(Boolean);
  return parts.length ? `Error: ${parts.join(" ")}` : undefined;
}

/**
 * Formats an error into a standardized error message
 * @param error Any error object to format
 * @returns A formatted error message as a string
 */
export function formatError(error: unknown): string {
  const entry = qboFaultEntry(error);
  const fault = entry && formatQboFault(entry);
  if (fault) {
    return fault;
  }

  if (error instanceof Error) {
    return `Error: ${error.message}`;
  } else if (typeof error === 'string') {
    return `Error: ${error}`;
  } else {
    return `Unknown error: ${JSON.stringify(error)}`;
  }
}
