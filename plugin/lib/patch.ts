/**
 * State patch application and transition (REQ-2).
 */

import type { JsonObject, JsonValue } from "./json.ts";
import { cloneJson, findUnsafeKeys, isPlainObject } from "./json.ts";
import type { DomainConfig } from "./config.ts";
import { compileSchema } from "./schema.ts";
import type { StateValidator } from "./schema.ts";

/**
 * Apply a patch to a state object with recursive-merge semantics:
 * plain objects merge recursively, arrays and scalars replace (deep-cloned),
 * and a null value deletes the key. Never mutates its inputs.
 */
export function applyStatePatch(state: JsonObject, patch: unknown): JsonObject {
  if (!isPlainObject(state)) {
    throw new Error("state must be a JSON object");
  }
  if (!isPlainObject(patch)) {
    throw new Error("patch must be a JSON object");
  }
  const unsafeKeys = findUnsafeKeys(patch);
  if (unsafeKeys.length > 0) {
    throw new Error(unsafeKeys.join("; "));
  }

  return mergeObjects(state, patch);
}

function mergeObjects(target: JsonObject, delta: JsonObject): JsonObject {
  const result: JsonObject = cloneJson(target);
  for (const key of Object.keys(delta)) {
    const value = delta[key] as JsonValue;
    if (value === null) {
      Reflect.deleteProperty(result, key);
    } else if (isPlainObject(value)) {
      const current = result[key];
      result[key] = mergeObjects(isPlainObject(current) ? current : {}, value);
    } else {
      result[key] = cloneJson(value);
    }
  }
  return result;
}

export type TransitionResult =
  | { ok: true; state: JsonObject; chars: number }
  | { ok: false; errors: string[] };

/**
 * Apply a patch to the runtime's state and validate the complete post-patch
 * state against its schema and against maxStateChars, collecting every
 * error. The runtime state object is never mutated; on any failure the
 * caller's state is left untouched.
 */
export function transitionState(
  runtime: { state: JsonObject; config: DomainConfig },
  patch: unknown,
  validate?: StateValidator,
): TransitionResult {
  let candidate: JsonObject;
  try {
    candidate = applyStatePatch(runtime.state, patch);
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }

  const errors: string[] = [];

  const validator = validate ?? compileSchema(runtime.config.schema);
  errors.push(...validator(candidate));

  const chars = JSON.stringify(candidate).length;
  if (chars > runtime.config.maxStateChars) {
    errors.push(`State exceeds maxStateChars (${chars} > ${runtime.config.maxStateChars})`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, state: candidate, chars };
}
