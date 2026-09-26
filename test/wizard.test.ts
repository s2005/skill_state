import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../plugin/lib/config.ts";
import {
  buildDomainConfig,
  CEILING_OPTIONS,
  ceilingFromAnswer,
  DOMAIN_NAME_PATTERN,
  EXEMPT_OPTIONS,
  exemptFromAnswer,
  EXTRA_FIELD_OPTIONS,
  extraFieldsFromAnswer,
  FIELD_TYPES,
  GENERIC_PROCEDURE,
  OVERWRITE_OPTIONS,
  parseExtraFields,
  PROCEDURE_OPTIONS,
  procedureFromAnswer,
  PROTOCOL_PARAGRAPH,
  RESERVED_DOMAIN_NAMES,
  REVIEW_OPTIONS,
  START_OPTIONS,
  TEMPLATE_OPTIONS,
  TEMPLATES,
  templateFromAnswer,
  validateDomainName,
  WINDOW_OPTIONS,
  windowFromAnswer,
  type FieldType,
  type TemplateId,
  type WizardAnswers,
} from "../plugin/lib/wizard.ts";

const TEMPLATE_IDS: TemplateId[] = ["coding", "investigation", "runbook", "minimal"];
const FIELD_TYPE_LIST: FieldType[] = ["text", "list", "map", "flag", "number"];

function baseAnswers(template: TemplateId, overrides: Partial<WizardAnswers> = {}): WizardAnswers {
  return {
    template,
    extraFields: [],
    procedure: TEMPLATES[template].procedure,
    windowTurns: 1,
    exemptTools: ["Read", "Grep", "Glob"],
    maxObservationChars: undefined,
    ...overrides,
  };
}

describe("TEMPLATES", () => {
  for (const id of TEMPLATE_IDS) {
    it(`builds and validates the ${id} template`, () => {
      const raw = buildDomainConfig(`t-${id}`, baseAnswers(id));
      const config = normalizeConfig(raw, "test");
      expect(config.maxStateChars).toBe(TEMPLATES[id].maxStateChars);
      const schema = config.schema as { required: string[]; additionalProperties: boolean };
      const fieldNames = TEMPLATES[id].fields.map((field) => field.name);
      expect(schema.required).toEqual(fieldNames);
      expect(schema.additionalProperties).toBe(false);
      expect(config.initialState["next_action"]).toBe("Inspect the task and plan the first step.");
    });
  }
});

describe("field types", () => {
  for (const type of FIELD_TYPE_LIST) {
    it(`builds a valid config with an extra ${type} field`, () => {
      const raw = buildDomainConfig("t-extra", {
        ...baseAnswers("minimal"),
        extraFields: [{ name: "extra", type }],
      });
      const config = normalizeConfig(raw, "test");
      const schema = config.schema as { properties: Record<string, unknown> };
      expect(schema.properties["extra"]).toEqual(FIELD_TYPES[type].schema);
      expect(config.initialState["extra"]).toEqual(FIELD_TYPES[type].initial);
    });
  }
});

describe("parseExtraFields", () => {
  it("returns no fields for empty text", () => {
    expect(parseExtraFields("")).toEqual([]);
    expect(parseExtraFields("   ")).toEqual([]);
  });

  it("parses one or more pairs, ignoring empty segments from stray commas", () => {
    expect(parseExtraFields("notes:list")).toEqual([{ name: "notes", type: "list" }]);
    expect(parseExtraFields(" a:text , b:number ,")).toEqual([
      { name: "a", type: "text" },
      { name: "b", type: "number" },
    ]);
    expect(parseExtraFields(",a:text,,b:flag,")).toEqual([
      { name: "a", type: "text" },
      { name: "b", type: "flag" },
    ]);
  });

  it("throws naming the pair for a missing colon", () => {
    expect(() => parseExtraFields("notes")).toThrow('malformed field "notes"');
  });

  it("throws naming the pair for more than one colon", () => {
    expect(() => parseExtraFields("a:b:c")).toThrow('malformed field "a:b:c"');
  });

  it("throws naming the pair for an empty name or type", () => {
    expect(() => parseExtraFields(":list")).toThrow('malformed field ":list"');
    expect(() => parseExtraFields("notes:")).toThrow('malformed field "notes:"');
  });

  it("throws naming the pair for a bad field name", () => {
    expect(() => parseExtraFields("Notes:list")).toThrow('invalid field name "Notes:list"');
    expect(() => parseExtraFields("1notes:list")).toThrow('invalid field name "1notes:list"');
  });

  it("throws naming the pair for an unknown type, listing valid types", () => {
    expect(() => parseExtraFields("notes:string")).toThrow(
      'unknown field type "notes:string": type must be one of text, list, map, flag, number',
    );
  });

  it("throws naming the pair for a duplicate name", () => {
    expect(() => parseExtraFields("notes:list,notes:text")).toThrow('duplicate field "notes:text"');
  });
});

describe("buildDomainConfig clashes", () => {
  it("throws naming the pair when an extra field clashes with a template field", () => {
    expect(() =>
      buildDomainConfig("t", {
        ...baseAnswers("minimal"),
        extraFields: [{ name: "facts", type: "list" }],
      }),
    ).toThrow('extra field "facts:list" clashes with a template field');
  });
});

describe("buildDomainConfig", () => {
  it("orders keys name, instructions, schema, initialState, exemptTools, windowTurns, maxStateChars", () => {
    const raw = buildDomainConfig("t-order", baseAnswers("minimal"));
    expect(Object.keys(raw)).toEqual([
      "name",
      "instructions",
      "schema",
      "initialState",
      "exemptTools",
      "windowTurns",
      "maxStateChars",
    ]);
  });

  it("appends maxObservationChars only when set", () => {
    const withoutCeiling = buildDomainConfig("t-a", baseAnswers("minimal"));
    expect(withoutCeiling["maxObservationChars"]).toBeUndefined();

    const withCeiling = buildDomainConfig(
      "t-b",
      baseAnswers("minimal", { maxObservationChars: 20000 }),
    );
    expect(Object.keys(withCeiling)).toEqual([
      "name",
      "instructions",
      "schema",
      "initialState",
      "exemptTools",
      "windowTurns",
      "maxStateChars",
      "maxObservationChars",
    ]);
    expect(withCeiling["maxObservationChars"]).toBe(20000);
  });

  it("appends the protocol paragraph to the procedure", () => {
    const raw = buildDomainConfig("t-instr", baseAnswers("minimal", { procedure: "Do the thing." }));
    expect(raw["instructions"]).toBe(`Do the thing.\n\n${PROTOCOL_PARAGRAPH}`);
    expect((raw["instructions"] as string).endsWith(PROTOCOL_PARAGRAPH)).toBe(true);
  });
});

describe("validateDomainName", () => {
  it("accepts a valid name", () => {
    expect(validateDomainName("my-domain_1")).toBeNull();
    expect(DOMAIN_NAME_PATTERN.test("my-domain_1")).toBe(true);
  });

  it("rejects an uppercase name", () => {
    expect(validateDomainName("Demo")).toMatch(/must match/);
  });

  it("rejects a name starting with a digit", () => {
    expect(validateDomainName("1demo")).toMatch(/must match/);
  });

  it("rejects a name over 40 characters", () => {
    const tooLong = "a".repeat(41);
    expect(validateDomainName(tooLong)).toMatch(/must match/);
  });

  it("rejects reserved names", () => {
    for (const reserved of RESERVED_DOMAIN_NAMES) {
      expect(validateDomainName(reserved)).toMatch(/reserved/);
    }
  });
});

describe("templateFromAnswer", () => {
  it("matches every exact label", () => {
    expect(templateFromAnswer(TEMPLATE_OPTIONS[0] as string)).toBe("coding");
    expect(templateFromAnswer("Investigation")).toBe("investigation");
    expect(templateFromAnswer("Operations runbook")).toBe("runbook");
    expect(templateFromAnswer("Minimal")).toBe("minimal");
  });

  it("matches a typed leading word case-insensitively", () => {
    expect(templateFromAnswer("coding")).toBe("coding");
    expect(templateFromAnswer("INVESTIGATION")).toBe("investigation");
    expect(templateFromAnswer("runbook please")).toBeUndefined();
    expect(templateFromAnswer("Operations, please")).toBe("runbook");
  });

  it("returns undefined for unmatched text", () => {
    expect(templateFromAnswer("something else")).toBeUndefined();
  });
});

describe("extraFieldsFromAnswer", () => {
  it("returns no fields for the recommended label or case-insensitive none", () => {
    expect(extraFieldsFromAnswer(EXTRA_FIELD_OPTIONS[0] as string)).toEqual([]);
    expect(extraFieldsFromAnswer("none")).toEqual([]);
    expect(extraFieldsFromAnswer("NONE")).toEqual([]);
  });

  it("parses anything else as name:type pairs", () => {
    expect(extraFieldsFromAnswer("notes:list")).toEqual([{ name: "notes", type: "list" }]);
    expect(() => extraFieldsFromAnswer("bogus")).toThrow('malformed field "bogus"');
  });
});

describe("procedureFromAnswer", () => {
  it("maps the template-procedure label to the template's own procedure", () => {
    expect(procedureFromAnswer(PROCEDURE_OPTIONS[0] as string, "coding")).toBe(TEMPLATES["coding"].procedure);
  });

  it("maps the generic-procedure label to GENERIC_PROCEDURE", () => {
    expect(procedureFromAnswer(PROCEDURE_OPTIONS[1] as string, "coding")).toBe(GENERIC_PROCEDURE);
  });

  it("uses anything else, trimmed, as the procedure itself", () => {
    expect(procedureFromAnswer("  Do the custom thing.  ", "coding")).toBe("Do the custom thing.");
  });

  it("falls back to the template's procedure for empty text", () => {
    expect(procedureFromAnswer("   ", "minimal")).toBe(TEMPLATES["minimal"].procedure);
  });
});

describe("windowFromAnswer", () => {
  it("matches every exact label", () => {
    expect(windowFromAnswer(WINDOW_OPTIONS[0] as string)).toBe(1);
    expect(windowFromAnswer("0 (frame only)")).toBe(0);
    expect(windowFromAnswer("2")).toBe(2);
  });

  it("matches a typed leading word", () => {
    expect(windowFromAnswer("0")).toBe(0);
    expect(windowFromAnswer("2 turns")).toBe(2);
  });

  it("returns undefined for unmatched text", () => {
    expect(windowFromAnswer("three")).toBeUndefined();
  });
});

describe("exemptFromAnswer", () => {
  it("matches every exact label", () => {
    expect(exemptFromAnswer(EXEMPT_OPTIONS[0] as string)).toEqual(["Read", "Grep", "Glob"]);
    expect(exemptFromAnswer("Read only")).toEqual(["Read"]);
    expect(exemptFromAnswer("None")).toEqual([]);
  });

  it("resolves a shared leading word to the recommended option", () => {
    expect(exemptFromAnswer("read")).toEqual(["Read", "Grep", "Glob"]);
  });

  it("returns undefined for unmatched text", () => {
    expect(exemptFromAnswer("write")).toBeUndefined();
  });
});

describe("ceilingFromAnswer", () => {
  it("matches every exact label", () => {
    expect(ceilingFromAnswer(CEILING_OPTIONS[0] as string)).toEqual({ value: undefined });
    expect(ceilingFromAnswer("20000")).toEqual({ value: 20000 });
    expect(ceilingFromAnswer("8000")).toEqual({ value: 8000 });
  });

  it("matches a typed leading word case-insensitively", () => {
    expect(ceilingFromAnswer("unset")).toEqual({ value: undefined });
    expect(ceilingFromAnswer("UNSET please")).toEqual({ value: undefined });
  });

  it("returns undefined for unmatched text", () => {
    expect(ceilingFromAnswer("nope")).toBeUndefined();
  });
});

describe("static option lists", () => {
  it("list the review, overwrite and start dialog options", () => {
    expect(REVIEW_OPTIONS).toEqual(["Write it (Recommended)", "Cancel"]);
    expect(OVERWRITE_OPTIONS).toEqual(["Keep existing (Recommended)", "Overwrite"]);
    expect(START_OPTIONS).toEqual(["Start now (Recommended)", "Not now"]);
  });
});
