/**
 * Build a `parse` function for {@link useWebSocketFeed} that turns JSON text
 * into items, optionally validated.
 *
 * ```ts
 * const isTick = (value: unknown): value is Tick =>
 *   typeof value === 'object' && value !== null && typeof (value as Tick).symbol === 'string';
 *
 * const parse = createJsonParser(isTick);
 * ```
 *
 * Behaviour, all of it deliberate:
 * - Non-string payloads (`Blob`, `ArrayBuffer`) return `null` → dropped.
 * - Invalid JSON throws → the feed catches it, drops the message, and calls
 *   `onParseError`. One bad frame never reaches your components.
 * - An array payload is treated as a batch; with a guard, the bad entries are
 *   filtered out and the good ones still get through. Partial data is better
 *   than no data in a live view.
 */
export function createJsonParser<T>(
  guard?: (value: unknown) => value is T,
): (raw: unknown) => T | T[] | null {
  return (raw: unknown): T | T[] | null => {
    if (typeof raw !== 'string' || raw.length === 0) return null;

    const value: unknown = JSON.parse(raw);

    if (Array.isArray(value)) {
      if (guard === undefined) return value as T[];
      const valid = value.filter((entry): entry is T => guard(entry));
      return valid.length > 0 ? valid : null;
    }

    if (guard !== undefined && !guard(value)) return null;
    return value as T;
  };
}
