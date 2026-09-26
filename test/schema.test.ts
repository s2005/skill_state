import { describe, expect, it } from "vitest";
import { compileSchema } from "../plugin/lib/schema.ts";

describe("compileSchema", () => {
  it("accepts every supported keyword", () => {
    const validate = compileSchema({
      type: "object",
      properties: {
        name: { type: "string", maxLength: 10 },
        tags: { type: "array", items: { type: "string" }, maxItems: 3 },
        role: { type: "string", enum: ["admin", "user"] },
        count: { type: "integer" },
        ratio: { type: "number" },
        active: { type: "boolean" },
        note: { type: ["string", "null"] },
      },
      required: ["name"],
      additionalProperties: false,
    });
    expect(
      validate({
        name: "ok",
        tags: ["a", "b"],
        role: "admin",
        count: 3,
        ratio: 1.5,
        active: true,
        note: null,
      }),
    ).toEqual([]);
  });

  it("rejects a value failing each supported keyword", () => {
    const validate = compileSchema({
      type: "object",
      properties: {
        name: { type: "string", maxLength: 3 },
        role: { type: "string", enum: ["a", "b"] },
        tags: { type: "array", maxItems: 1 },
      },
      required: ["name", "role"],
      additionalProperties: false,
    });
    const errors = validate({ name: "toolong", role: "c", tags: ["x", "y"], extra: 1 });
    expect(errors).toContain('$.name must be at most 3 characters');
    expect(errors).toContain('$.role must be one of ["a","b"]');
    expect(errors).toContain("$.tags must have at most 1 items");
    expect(errors).toContain('$ must not have additional property "extra"');
  });

  it("collects multiple errors, not just the first", () => {
    const validate = compileSchema({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "number" },
      },
      required: ["a", "b"],
      additionalProperties: false,
    });
    const errors = validate({});
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors).toContain('$ must have required property "a"');
    expect(errors).toContain('$ must have required property "b"');
  });

  it("reports nested paths for arrays and objects", () => {
    const validate = compileSchema({
      type: "object",
      properties: {
        facts: {
          type: "array",
          items: { type: "string" },
        },
        files: {
          type: "object",
          properties: { x: { type: "string" } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    });
    const errors = validate({ facts: ["ok", 5], files: { x: 5 } });
    expect(errors).toContain("$.facts[1] must be string");
    expect(errors).toContain("$.files.x must be string");
  });

  it("rejects a schema that is not an object", () => {
    expect(() => compileSchema("nope")).toThrow(/must be a JSON object/);
  });

  it("throws naming an unsupported top-level keyword and its path", () => {
    expect(() => compileSchema({ type: "string", minLength: 1 })).toThrow(
      'unsupported schema keyword "minLength" at #',
    );
  });

  it("throws naming an unsupported keyword nested inside properties", () => {
    expect(() =>
      compileSchema({
        type: "object",
        properties: { name: { type: "string", minLength: 1 } },
      }),
    ).toThrow('unsupported schema keyword "minLength" at #/properties/name');
  });

  it("throws naming an unsupported keyword nested inside items", () => {
    expect(() =>
      compileSchema({
        type: "array",
        items: { type: "string", pattern: "^a" },
      }),
    ).toThrow('unsupported schema keyword "pattern" at #/items');
  });

  it("throws for a malformed type value", () => {
    expect(() => compileSchema({ type: 5 })).toThrow('invalid "type" at #');
    expect(() => compileSchema({ type: "not-a-type" })).toThrow('invalid "type" at #');
    expect(() =>
      compileSchema({ type: "object", properties: { a: { type: [] } } }),
    ).toThrow('invalid "type" at #/properties/a');
  });

  it("integer excludes non-integers; number excludes NaN and Infinity", () => {
    const validate = compileSchema({
      type: "object",
      properties: {
        count: { type: "integer" },
        ratio: { type: "number" },
      },
    });
    expect(validate({ count: 1.5 })).toContain("$.count must be integer");
    expect(validate({ ratio: Number.NaN })).toContain("$.ratio must be number");
    expect(validate({ ratio: Number.POSITIVE_INFINITY })).toContain("$.ratio must be number");
  });

  it("enum compares deeply, independent of key order", () => {
    const validate = compileSchema({
      enum: [{ a: 1, b: 2 }],
    });
    expect(validate({ b: 2, a: 1 })).toEqual([]);
    expect(validate({ a: 1 })).toContain('$ must be one of [{"a":1,"b":2}]');
  });
});
