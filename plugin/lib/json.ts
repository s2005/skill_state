/**
 * Shared JSON helpers for the SKILL.state core library.
 *
 * These run inside the Claude Code plugin sandbox: no Node APIs, no DOM,
 * no npm imports. Only pure TypeScript.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** Keys that could pollute a prototype chain through a recursive merge. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * True when the value is a plain JSON object: not null, not an array, and
 * either has no prototype or the plain Object.prototype. JSON.parse always
 * produces plain objects, so this also rejects class instances that might
 * be passed in directly.
 */
export function isPlainObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Deep-clone a JSON value through serialize/parse. */
export function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Deep, key-order-independent equality between two JSON values. */
export function jsonEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => jsonEqual(item, b[index] as JsonValue))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key, index) => {
      if (key !== keysB[index]) return false;
      const nestedA = a[key];
      const nestedB = b[key];
      if (nestedA === undefined || nestedB === undefined) return false;
      return jsonEqual(nestedA, nestedB);
    });
  }
  return false;
}

/**
 * Walk a JSON value looking for forbidden keys (__proto__, constructor,
 * prototype) at any depth, in objects or inside arrays. Returns a message
 * per unsafe key found, e.g. "Unsafe key at $.a.__proto__".
 *
 * Note: JSON.parse creates an own "__proto__" key on the parsed object, so
 * this walks Object.keys / Object.entries rather than using the `in`
 * operator, which would instead see the real prototype chain.
 */
export function findUnsafeKeys(value: unknown, path = "$"): string[] {
  const messages: string[] = [];
  walkUnsafeKeys(value, path, messages);
  return messages;
}

function walkUnsafeKeys(value: unknown, path: string, messages: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkUnsafeKeys(item, `${path}[${index}]`, messages));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    const childPath = `${path}.${key}`;
    if (FORBIDDEN_KEYS.has(key)) {
      messages.push(`Unsafe key at ${childPath}`);
    }
    walkUnsafeKeys(value[key], childPath, messages);
  }
}
