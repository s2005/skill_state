import { describe, expect, it } from "vitest";
import { DEFAULTS, normalizeConfig } from "../plugin/lib/config.ts";
import software from "../plugin/domains/software.json";
import ctf from "../plugin/domains/ctf.json";

const baseRaw = {
  name: "demo",
  instructions: "do the thing",
  schema: {
    type: "object",
    properties: { phase: { type: "string" } },
    required: ["phase"],
    additionalProperties: false,
  },
  initialState: { phase: "start" },
};

describe("normalizeConfig", () => {
  it("applies defaults when optional fields are omitted", () => {
    const config = normalizeConfig(baseRaw, "test");
    expect(config.exemptTools).toEqual(DEFAULTS.exemptTools);
    expect(config.windowTurns).toBe(DEFAULTS.windowTurns);
    expect(config.maxStateChars).toBe(DEFAULTS.maxStateChars);
    expect(config.maxObservationChars).toBeUndefined();
    expect(config.name).toBe("demo");
  });

  it("rejects a non-object raw config", () => {
    expect(() => normalizeConfig("nope", "test")).toThrow("test: configuration must be a JSON object");
  });

  it("rejects an unknown top-level field, naming it", () => {
    expect(() => normalizeConfig({ ...baseRaw, bogus: 1 }, "test")).toThrow(
      'test: unknown configuration field "bogus"',
    );
  });

  it("rejects a missing or empty name", () => {
    expect(() => normalizeConfig({ ...baseRaw, name: "" }, "test")).toThrow(
      "test: name must be a non-empty string",
    );
  });

  it("rejects missing or empty instructions", () => {
    expect(() => normalizeConfig({ ...baseRaw, instructions: "  " }, "test")).toThrow(
      "test: instructions must be a non-empty string",
    );
  });

  it("rejects a non-object schema", () => {
    expect(() => normalizeConfig({ ...baseRaw, schema: 5 }, "test")).toThrow(
      "test: schema must be a JSON object",
    );
  });

  it("rejects an unsupported schema keyword, naming it", () => {
    expect(() =>
      normalizeConfig(
        { ...baseRaw, schema: { type: "object", minProperties: 1 } },
        "test",
      ),
    ).toThrow('test: unsupported schema keyword "minProperties" at #');
  });

  it("rejects an initialState violating its schema, naming the path", () => {
    expect(() =>
      normalizeConfig({ ...baseRaw, initialState: {} }, "test"),
    ).toThrow('test: initialState violates schema: $ must have required property "phase"');
  });

  it("rejects an initialState with unsafe keys", () => {
    const withUnsafe = JSON.parse('{"phase": "start", "__proto__": {"x": 1}}') as Record<string, unknown>;
    expect(() => normalizeConfig({ ...baseRaw, initialState: withUnsafe }, "test")).toThrow(
      "test: initialState has unsafe keys",
    );
  });

  it("rejects an invalid exemptTools", () => {
    expect(() => normalizeConfig({ ...baseRaw, exemptTools: [1] }, "test")).toThrow(
      "test: exemptTools must be an array of strings",
    );
  });

  it("rejects an invalid windowTurns", () => {
    expect(() => normalizeConfig({ ...baseRaw, windowTurns: -1 }, "test")).toThrow(
      "test: windowTurns must be an integer >= 0",
    );
    expect(() => normalizeConfig({ ...baseRaw, windowTurns: 1.5 }, "test")).toThrow(
      "test: windowTurns must be an integer >= 0",
    );
  });

  it("rejects an invalid maxStateChars", () => {
    expect(() => normalizeConfig({ ...baseRaw, maxStateChars: 0 }, "test")).toThrow(
      "test: maxStateChars must be an integer > 0",
    );
  });

  it("rejects an invalid maxObservationChars", () => {
    expect(() => normalizeConfig({ ...baseRaw, maxObservationChars: 0 }, "test")).toThrow(
      "test: maxObservationChars must be an integer > 0",
    );
    expect(() => normalizeConfig({ ...baseRaw, maxObservationChars: 1.5 }, "test")).toThrow(
      "test: maxObservationChars must be an integer > 0",
    );
  });

  it("accepts a valid maxObservationChars", () => {
    const config = normalizeConfig({ ...baseRaw, maxObservationChars: 500 }, "test");
    expect(config.maxObservationChars).toBe(500);
  });

  it("loads the bundled software domain", () => {
    const config = normalizeConfig(software, "software.json");
    expect(config.name).toBe("software");
    expect(config.exemptTools).toEqual(["Read", "Grep", "Glob"]);
    expect(config.windowTurns).toBe(1);
  });

  it("loads the bundled ctf domain", () => {
    const config = normalizeConfig(ctf, "ctf.json");
    expect(config.name).toBe("ctf");
    expect(config.exemptTools).toEqual(["Read", "Grep", "Glob"]);
    expect(config.windowTurns).toBe(0);
    expect(config.maxObservationChars).toBe(20000);
  });
});
