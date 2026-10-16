// ---------------------------------------------------------------------------
// Volatile values out of model prompts (P2-021, P2-020). A page carries
// values that change on every load — hidden-input tokens, UUIDs,
// timestamps, tracking parameters, a vendor's random class — and any of
// them in a prompt makes the same element a different request each scan:
// no response reuse, verdict drift, unreplayable runs. Every prompt builder
// passes its markup through redactVolatile() before the text is keyed and
// sent, so llm_input records what the model saw. Field names and types stay;
// values a user can see (text, visible inputs' values, labels) stay.
// ---------------------------------------------------------------------------

export const PLACEHOLDERS = {
  hidden: "[hidden-value]",
  uuid: "[uuid]",
  timestamp: "[timestamp]",
  tracking: "[tracking]",
  vendorId: "[id]",
} as const;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
/** An attribute whose whole value is a Unix time (seconds 2017–2033, or milliseconds) */
const EPOCH_ATTR = /=(["'])(?:1[5-9]\d{8}|1\d{12})\1/g;
const TRACKING_PARAM = /([?&](?:utm_[a-z]+|gclid|dclid|fbclid|msclkid|yclid|ttclid|_ga|_gl|mc_cid|mc_eid|visitor_id|session_id|sid|cid)=)[^&"'\s<>]*/gi;
const GROWSURF_CLASS = /grsf-unique-[a-z0-9]+/gi;
const HIDDEN_INPUT = /<input\b[^>]*>/gi;

function hiddenInputRedacted(tag: string): string {
  if (!/\btype\s*=\s*["']?hidden["']?/i.test(tag)) return tag;
  return tag.replace(/\bvalue\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, `value="${PLACEHOLDERS.hidden}"`);
}

/**
 * Replace per-load values in markup or text with stable placeholders.
 * Hidden inputs keep their name and type and lose their value; UUIDs,
 * ISO timestamps, epoch attribute values, tracking query parameters and
 * GrowSurf's per-load class are replaced wherever they occur.
 */
export function redactVolatile(text: string): string {
  if (!text) return text;
  return text
    .replace(HIDDEN_INPUT, hiddenInputRedacted)
    .replace(UUID, PLACEHOLDERS.uuid)
    .replace(ISO_TIMESTAMP, PLACEHOLDERS.timestamp)
    .replace(EPOCH_ATTR, `=$1${PLACEHOLDERS.timestamp}$1`)
    .replace(TRACKING_PARAM, `$1${PLACEHOLDERS.tracking}`)
    .replace(GROWSURF_CLASS, `grsf-unique-${PLACEHOLDERS.vendorId}`);
}

/** True when a prompt still carries a value this module would redact. */
export function hasVolatile(text: string): boolean {
  return redactVolatile(text) !== text;
}
