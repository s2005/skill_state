/**
 * Domain config loading and normalization (REQ-1).
 */

import type { JsonObject } from "./json.ts";
import { cloneJson, findUnsafeKeys, isPlainObject } from "./json.ts";
import { compileSchema } from "./schema.ts";

export type DomainConfig = {
  name: string;
  instructions: string;
  schema: JsonObject;
  initialState: JsonObject;
  exemptTools: string[];
  windowTurns: number;
  maxStateChars: number;
  maxObservationChars?: number;
};

export const DEFAULTS: {
  exemptTools: string[];
  windowTurns: number;
  maxStateChars: number;
} = {
  exemptTools: [],
  windowTurns: 1,
  maxStateChars: 100_000,
};

const KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "instructions",
  "schema",
  "initialState",
  "exemptTools",
  "windowTurns",
  "maxStateChars",
  "maxObservationChars",
  "description",
  "version",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Normalize and validate a raw domain config object, throwing an Error
 * prefixed with `${source}: ` for any violation.
 */
export function normalizeConfig(raw: unknown, source: string): DomainConfig {
  if (!isPlainObject(raw)) {
    throw new Error(`${source}: configuration must be a JSON object`);
  }

  for (const field of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(field)) {
      throw new Error(`${source}: unknown configuration field "${field}"`);
    }
  }

  if (!isNonEmptyString(raw["name"])) {
    throw new Error(`${source}: name must be a non-empty string`);
  }
  const name = (raw["name"] as string).trim();

  if (!isNonEmptyString(raw["instructions"])) {
    throw new Error(`${source}: instructions must be a non-empty string`);
  }
  const instructions = (raw["instructions"] as string).trim();

  if (!isPlainObject(raw["schema"])) {
    throw new Error(`${source}: schema must be a JSON object`);
  }
  let validate;
  try {
    validate = compileSchema(raw["schema"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${source}: ${message}`, { cause: error });
  }
  const schema = cloneJson(raw["schema"]);

  if (!isPlainObject(raw["initialState"])) {
    throw new Error(`${source}: initialState must be a JSON object`);
  }
  const unsafeKeys = findUnsafeKeys(raw["initialState"]);
  if (unsafeKeys.length > 0) {
    throw new Error(`${source}: initialState has unsafe keys: ${unsafeKeys.join("; ")}`);
  }
  const initialStateErrors = validate(raw["initialState"]);
  if (initialStateErrors.length > 0) {
    throw new Error(`${source}: initialState violates schema: ${initialStateErrors.join("; ")}`);
  }

  let exemptTools = DEFAULTS.exemptTools;
  if ("exemptTools" in raw) {
    if (!isStringArray(raw["exemptTools"])) {
      throw new Error(`${source}: exemptTools must be an array of strings`);
    }
    exemptTools = [...raw["exemptTools"]];
  }

  let windowTurns = DEFAULTS.windowTurns;
  if ("windowTurns" in raw) {
    if (!isNonNegativeInteger(raw["windowTurns"])) {
      throw new Error(`${source}: windowTurns must be an integer >= 0`);
    }
    windowTurns = raw["windowTurns"];
  }

  let maxStateChars = DEFAULTS.maxStateChars;
  if ("maxStateChars" in raw) {
    if (!isPositiveInteger(raw["maxStateChars"])) {
      throw new Error(`${source}: maxStateChars must be an integer > 0`);
    }
    maxStateChars = raw["maxStateChars"];
  }

  const initialStateSize = JSON.stringify(raw["initialState"]).length;
  if (initialStateSize > maxStateChars) {
    throw new Error(
      `${source}: initialState exceeds maxStateChars (${initialStateSize} > ${maxStateChars})`,
    );
  }

  let maxObservationChars: number | undefined;
  if ("maxObservationChars" in raw) {
    if (!isPositiveInteger(raw["maxObservationChars"])) {
      throw new Error(`${source}: maxObservationChars must be an integer > 0`);
    }
    maxObservationChars = raw["maxObservationChars"];
  }

  const config: DomainConfig = {
    name,
    instructions,
    schema,
    initialState: cloneJson(raw["initialState"]),
    exemptTools,
    windowTurns,
    maxStateChars,
  };
  if (maxObservationChars !== undefined) {
    config.maxObservationChars = maxObservationChars;
  }
  return config;
}
