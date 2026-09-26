import { describe, expect, it } from "vitest";
import { applyStatePatch, transitionState } from "../plugin/lib/patch.ts";
import { normalizeConfig } from "../plugin/lib/config.ts";
import type { JsonObject } from "../plugin/lib/json.ts";

describe("applyStatePatch", () => {
  it("merges nested objects recursively", () => {
    const state: JsonObject = { files: { a: 1, b: { c: 2 } } };
    const result = applyStatePatch(state, { files: { b: { d: 3 }, e: 4 } });
    expect(result).toEqual({ files: { a: 1, b: { c: 2, d: 3 }, e: 4 } });
  });

  it("replaces arrays and scalars rather than merging them", () => {
    const state: JsonObject = { tags: ["a", "b"], count: 1 };
    const result = applyStatePatch(state, { tags: ["c"], count: 2 });
    expect(result).toEqual({ tags: ["c"], count: 2 });
  });

  it("deletes a key when the patch value is null", () => {
    const state: JsonObject = { a: 1, b: 2 };
    const result = applyStatePatch(state, { a: null });
    expect(result).toEqual({ b: 2 });
  });

  it("rejects forbidden keys, including __proto__ produced by JSON.parse", () => {
    const state: JsonObject = {};
    const patch = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
    expect(() => applyStatePatch(state, patch)).toThrow(/Unsafe key at \$\.__proto__/);
  });

  it("rejects constructor and prototype keys, including nested", () => {
    const state: JsonObject = {};
    expect(() => applyStatePatch(state, { constructor: { x: 1 } })).toThrow(/\$\.constructor/);
    expect(() => applyStatePatch(state, { nested: { prototype: 1 } })).toThrow(/\$\.nested\.prototype/);
  });

  it("rejects a non-object patch", () => {
    expect(() => applyStatePatch({}, "nope")).toThrow(/patch must be a JSON object/);
  });

  it("rejects a non-object state", () => {
    expect(() => applyStatePatch(null as unknown as JsonObject, {})).toThrow(/state must be a JSON object/);
  });

  it("does not mutate its inputs", () => {
    const state: JsonObject = { files: { a: 1 } };
    const patch = { files: { b: 2 } };
    const stateSnapshot = JSON.stringify(state);
    const patchSnapshot = JSON.stringify(patch);
    applyStatePatch(state, patch);
    expect(JSON.stringify(state)).toBe(stateSnapshot);
    expect(JSON.stringify(patch)).toBe(patchSnapshot);
  });
});

const config = normalizeConfig(
  {
    name: "demo",
    instructions: "do the thing",
    schema: {
      type: "object",
      properties: {
        phase: { type: "string", enum: ["start", "done"] },
        notes: { type: "array", items: { type: "string" }, maxItems: 2 },
      },
      required: ["phase", "notes"],
      additionalProperties: false,
    },
    initialState: { phase: "start", notes: [] },
    maxStateChars: 200,
  },
  "test",
);

describe("transitionState", () => {
  it("accepts a valid patch and returns the new state and char count", () => {
    const runtime = { state: config.initialState, config };
    const result = transitionState(runtime, { phase: "done" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toEqual({ phase: "done", notes: [] });
      expect(result.chars).toBe(JSON.stringify(result.state).length);
    }
  });

  it("returns every schema error on a failing patch", () => {
    const runtime = { state: config.initialState, config };
    const result = transitionState(runtime, { phase: "bogus", notes: ["a", "b", "c"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
      expect(result.errors.some((e) => e.includes("must be one of"))).toBe(true);
      expect(result.errors.some((e) => e.includes("must have at most"))).toBe(true);
    }
  });

  it("fails on maxStateChars overflow", () => {
    const tightConfig = normalizeConfig(
      {
        name: "tight",
        instructions: "do the thing",
        schema: { type: "object", properties: { phase: { type: "string" } }, required: ["phase"] },
        initialState: { phase: "s" },
        maxStateChars: 20,
      },
      "test",
    );
    const runtime = { state: tightConfig.initialState, config: tightConfig };
    const result = transitionState(runtime, { phase: "a very long phase value indeed" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("State exceeds maxStateChars"))).toBe(true);
    }
  });

  it("reports schema and size errors together when both fail", () => {
    const tightConfig = normalizeConfig(
      {
        name: "tight",
        instructions: "do the thing",
        schema: {
          type: "object",
          properties: { phase: { type: "string", enum: ["start"] } },
          required: ["phase"],
          additionalProperties: false,
        },
        initialState: { phase: "start" },
        maxStateChars: 25,
      },
      "test",
    );
    const runtime = { state: tightConfig.initialState, config: tightConfig };
    const result = transitionState(runtime, { phase: "not-in-enum-and-long" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("must be one of"))).toBe(true);
      expect(result.errors.some((e) => e.includes("State exceeds maxStateChars"))).toBe(true);
    }
  });

  it("leaves runtime.state unchanged after a failed patch", () => {
    const initialState = config.initialState;
    const runtime = { state: initialState, config };
    const snapshot = JSON.stringify(runtime.state);
    const result = transitionState(runtime, { phase: "bogus" });
    expect(result.ok).toBe(false);
    expect(runtime.state).toBe(initialState);
    expect(JSON.stringify(runtime.state)).toBe(snapshot);
  });

  it("rejects a non-object patch, collecting it as an error", () => {
    const runtime = { state: config.initialState, config };
    const result = transitionState(runtime, "nope");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/patch must be a JSON object/);
    }
  });
});
