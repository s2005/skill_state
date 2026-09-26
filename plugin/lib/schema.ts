/**
 * Zero-dependency JSON Schema subset compiler and validator.
 *
 * Supported keywords only: type, properties, required, additionalProperties,
 * items, enum, maxLength, maxItems. Any other keyword found while compiling
 * a schema throws.
 */

import type { JsonValue } from "./json.ts";
import { isPlainObject, jsonEqual } from "./json.ts";

export type StateValidator = (instance: unknown) => string[];

const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "maxLength",
  "maxItems",
]);

const SUPPORTED_TYPES: ReadonlySet<string> = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

type CompiledSchema = {
  type?: string[];
  properties?: Map<string, CompiledSchema>;
  required?: string[];
  additionalProperties?: boolean | CompiledSchema;
  items?: CompiledSchema;
  enum?: JsonValue[];
  maxLength?: number;
  maxItems?: number;
};

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function compileNode(schema: unknown, path: string): CompiledSchema {
  if (!isPlainObject(schema)) {
    throw new Error(`invalid schema at ${path}: must be a JSON object`);
  }

  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(`unsupported schema keyword "${keyword}" at ${path}`);
    }
  }

  const compiled: CompiledSchema = {};

  if ("type" in schema) {
    const rawType = schema["type"];
    const types = Array.isArray(rawType) ? rawType : [rawType];
    if (
      types.length === 0 ||
      !types.every((t): t is string => typeof t === "string" && SUPPORTED_TYPES.has(t))
    ) {
      throw new Error(`invalid "type" at ${path}`);
    }
    compiled.type = types as string[];
  }

  if ("properties" in schema) {
    const rawProperties = schema["properties"];
    if (!isPlainObject(rawProperties)) {
      throw new Error(`invalid "properties" at ${path}`);
    }
    const properties = new Map<string, CompiledSchema>();
    for (const key of Object.keys(rawProperties)) {
      properties.set(key, compileNode(rawProperties[key], `${path}/properties/${key}`));
    }
    compiled.properties = properties;
  }

  if ("required" in schema) {
    const rawRequired = schema["required"];
    if (!Array.isArray(rawRequired) || !rawRequired.every((r): r is string => typeof r === "string")) {
      throw new Error(`invalid "required" at ${path}`);
    }
    compiled.required = rawRequired as string[];
  }

  if ("additionalProperties" in schema) {
    const rawAdditional = schema["additionalProperties"];
    if (typeof rawAdditional === "boolean") {
      compiled.additionalProperties = rawAdditional;
    } else if (isPlainObject(rawAdditional)) {
      compiled.additionalProperties = compileNode(rawAdditional, `${path}/additionalProperties`);
    } else {
      throw new Error(`invalid "additionalProperties" at ${path}`);
    }
  }

  if ("items" in schema) {
    compiled.items = compileNode(schema["items"], `${path}/items`);
  }

  if ("enum" in schema) {
    const rawEnum = schema["enum"];
    if (!Array.isArray(rawEnum)) {
      throw new Error(`invalid "enum" at ${path}`);
    }
    compiled.enum = rawEnum as JsonValue[];
  }

  if ("maxLength" in schema) {
    const rawMaxLength = schema["maxLength"];
    if (!isNonNegativeInteger(rawMaxLength)) {
      throw new Error(`invalid "maxLength" at ${path}`);
    }
    compiled.maxLength = rawMaxLength;
  }

  if ("maxItems" in schema) {
    const rawMaxItems = schema["maxItems"];
    if (!isNonNegativeInteger(rawMaxItems)) {
      throw new Error(`invalid "maxItems" at ${path}`);
    }
    compiled.maxItems = rawMaxItems;
  }

  return compiled;
}

function typeOf(instance: unknown): string {
  if (instance === null) return "null";
  if (Array.isArray(instance)) return "array";
  if (typeof instance === "number") return Number.isInteger(instance) ? "integer" : "number";
  return typeof instance;
}

function matchesType(instance: unknown, expected: string): boolean {
  const actual = typeOf(instance);
  if (expected === actual) return true;
  if (expected === "number" && actual === "integer") return true;
  return false;
}

function isFiniteNumber(instance: unknown): boolean {
  return typeof instance === "number" && Number.isFinite(instance);
}

function jsonTypeName(expected: string[]): string {
  return expected.length === 1 ? (expected[0] as string) : `[${expected.join(", ")}]`;
}

function validateNode(node: CompiledSchema, instance: unknown, path: string, errors: string[]): void {
  if (node.type) {
    // number/integer additionally reject NaN and Infinity even though
    // typeof reports "number" for them.
    const numericTypesOnly = node.type.every((t) => t === "number" || t === "integer");
    const rejectedByFiniteCheck =
      numericTypesOnly && typeof instance === "number" && !isFiniteNumber(instance);
    const matches = !rejectedByFiniteCheck && node.type.some((t) => matchesType(instance, t));
    if (!matches) {
      errors.push(`${path} must be ${jsonTypeName(node.type)}`);
      return;
    }
  }

  if (node.enum) {
    const inEnum = node.enum.some((candidate) => jsonEqual(candidate, instance as JsonValue));
    if (!inEnum) {
      errors.push(`${path} must be one of ${JSON.stringify(node.enum)}`);
    }
  }

  if (typeof instance === "string" && node.maxLength !== undefined) {
    if (instance.length > node.maxLength) {
      errors.push(`${path} must be at most ${node.maxLength} characters`);
    }
  }

  if (Array.isArray(instance) && node.maxItems !== undefined) {
    if (instance.length > node.maxItems) {
      errors.push(`${path} must have at most ${node.maxItems} items`);
    }
  }

  if (Array.isArray(instance) && node.items) {
    instance.forEach((item, index) => {
      validateNode(node.items as CompiledSchema, item, `${path}[${index}]`, errors);
    });
  }

  if (isPlainObject(instance)) {
    if (node.required) {
      for (const key of node.required) {
        if (!Object.hasOwn(instance, key)) {
          errors.push(`${path} must have required property "${key}"`);
        }
      }
    }

    const knownKeys = node.properties ?? new Map<string, CompiledSchema>();

    for (const key of Object.keys(instance)) {
      const childSchema = knownKeys.get(key);
      if (childSchema) {
        validateNode(childSchema, instance[key], `${path}.${key}`, errors);
        continue;
      }
      if (node.additionalProperties === false) {
        errors.push(`${path} must not have additional property "${key}"`);
      } else if (isPlainObject(node.additionalProperties) || node.additionalProperties === undefined) {
        if (isPlainObject(node.additionalProperties)) {
          validateNode(node.additionalProperties, instance[key], `${path}.${key}`, errors);
        }
      }
    }
  }
}

/**
 * Compile a schema (the supported keyword subset only) into a validator.
 * Throws for any unsupported keyword or malformed keyword value, naming the
 * keyword and its schema path (e.g. #/properties/name).
 */
export function compileSchema(schema: unknown): StateValidator {
  if (!isPlainObject(schema)) {
    throw new Error(`invalid schema at #: must be a JSON object`);
  }
  const compiled = compileNode(schema, "#");
  return (instance: unknown): string[] => {
    const errors: string[] = [];
    validateNode(compiled, instance, "$", errors);
    return errors;
  };
}
