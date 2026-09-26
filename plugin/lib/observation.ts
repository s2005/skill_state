/**
 * Observation size ceiling (REQ-6).
 */

export const OBSERVATION_MARKER_PREFIX = "[Observation truncated:";

/**
 * Truncate text to maxChars, appending a marker naming how many characters
 * were omitted. Text at or under the limit, or with maxChars unset, is
 * returned unchanged.
 */
export function truncateObservation(text: string, maxChars?: number): string {
  if (maxChars === undefined || text.length <= maxChars) {
    return text;
  }
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n${OBSERVATION_MARKER_PREFIX} ${omitted} characters omitted]`;
}

/** A tool result after the ceiling: the value and whether anything was cut. */
export type TruncatedResult = { value: unknown; isTruncated: boolean };

/**
 * Apply the ceiling to a tool's result record while keeping its shape: every
 * string longer than maxChars, at any depth, is truncated with the marker.
 * Other values are returned as they are, so the record still fits the tool's
 * output schema.
 */
export function truncateResult(value: unknown, maxChars?: number): TruncatedResult {
  if (maxChars === undefined) {
    return { value, isTruncated: false };
  }
  if (typeof value === "string") {
    const text = truncateObservation(value, maxChars);
    return { value: text, isTruncated: text !== value };
  }
  if (Array.isArray(value)) {
    let isTruncated = false;
    const items = value.map((item: unknown) => {
      const one = truncateResult(item, maxChars);
      isTruncated ||= one.isTruncated;
      return one.value;
    });
    return isTruncated ? { value: items, isTruncated } : { value, isTruncated };
  }
  if (value !== null && typeof value === "object") {
    let isTruncated = false;
    const entries = Object.entries(value).map(([key, item]: [string, unknown]) => {
      const one = truncateResult(item, maxChars);
      isTruncated ||= one.isTruncated;
      return [key, one.value] as const;
    });
    return isTruncated ? { value: Object.fromEntries(entries), isTruncated } : { value, isTruncated };
  }
  return { value, isTruncated: false };
}
