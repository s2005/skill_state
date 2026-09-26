/**
 * Pure domain-builder for the `new` subcommand's guided helper (REQ-1, REQ-2,
 * REQ-3). Nothing here touches the engine `$`; it only turns a validated name
 * and a set of answers into a raw config object for `normalizeConfig`.
 */

import type { JsonObject, JsonValue } from "./json.ts";
import { cloneJson } from "./json.ts";

/** The five flat field types a template or an extra field may use. */
export type FieldType = "text" | "list" | "map" | "flag" | "number";

/** A field name paired with its type, as it appears in a template or is parsed from free text. */
export type WizardField = { name: string; type: FieldType };

// Listed in the order error messages should name them.
const FIELD_TYPE_NAMES: FieldType[] = ["text", "list", "map", "flag", "number"];

/**
 * Each field type's schema (a member of the supported keyword subset in
 * schema.ts) and its initial state value, exactly per PRD REQ-2.
 */
export const FIELD_TYPES: Record<FieldType, { schema: JsonObject; initial: JsonValue }> = {
  text: { schema: { type: "string", maxLength: 2000 }, initial: "" },
  list: { schema: { type: "array", items: { type: "string" }, maxItems: 200 }, initial: [] },
  map: { schema: { type: "object", additionalProperties: { type: "string" } }, initial: {} },
  flag: { schema: { type: "boolean" }, initial: false },
  number: { schema: { type: "number" }, initial: 0 },
};

/** The four bundled templates a new domain may start from. */
export type TemplateId = "coding" | "investigation" | "runbook" | "minimal";

/** A template's recommended field set, procedure text and state size ceiling. */
export type Template = {
  label: string;
  fields: WizardField[];
  procedure: string;
  maxStateChars: number;
};

const NEXT_ACTION_INITIAL = "Inspect the task and plan the first step.";

/** The four templates, keyed by id, per the PRD REQ-2 table. */
export const TEMPLATES: Record<TemplateId, Template> = {
  coding: {
    label: "Coding task",
    fields: [
      { name: "plan", type: "list" },
      { name: "facts", type: "list" },
      { name: "modified_files", type: "list" },
      { name: "dead_ends", type: "list" },
      { name: "next_action", type: "text" },
    ],
    procedure:
      "You are executing a long-horizon coding task under SKILL.state. Keep plan as the " +
      "ordered list of remaining steps, facts as durable findings worth remembering, " +
      "modified_files as the files you have changed so far, dead_ends as approaches you tried " +
      "and ruled out, and next_action as a short description of what you will do next. Update " +
      "these fields as the task progresses rather than leaving them stale.",
    maxStateChars: 100_000,
  },
  investigation: {
    label: "Investigation",
    fields: [
      { name: "question", type: "text" },
      { name: "hypotheses", type: "list" },
      { name: "evidence", type: "list" },
      { name: "ruled_out", type: "list" },
      { name: "sources", type: "list" },
      { name: "next_action", type: "text" },
    ],
    procedure:
      "You are running a long-horizon investigation under SKILL.state. Keep question as the " +
      "question you are answering, hypotheses as theories still in play, evidence as findings " +
      "that support or narrow them, ruled_out as hypotheses you have eliminated and why, " +
      "sources as where the evidence came from, and next_action as a short description of what " +
      "you will do next.",
    maxStateChars: 100_000,
  },
  runbook: {
    label: "Operations runbook",
    fields: [
      { name: "phase", type: "text" },
      { name: "completed_steps", type: "list" },
      { name: "environment", type: "map" },
      { name: "incidents", type: "list" },
      { name: "next_action", type: "text" },
    ],
    procedure:
      "You are following a long-horizon operations runbook under SKILL.state. Keep phase as " +
      "the current stage of the runbook, completed_steps as the ordered steps you have " +
      "finished, environment as the environment details relevant to this run, incidents as " +
      "problems encountered and how they were resolved, and next_action as a short description " +
      "of what you will do next.",
    maxStateChars: 50_000,
  },
  minimal: {
    label: "Minimal",
    fields: [
      { name: "facts", type: "list" },
      { name: "next_action", type: "text" },
    ],
    procedure:
      "You are executing a long-horizon task under SKILL.state with minimal structure. Keep " +
      "facts as durable findings worth remembering and next_action as a short description of " +
      "what you will do next.",
    maxStateChars: 20_000,
  },
};

/**
 * The standard protocol paragraph appended to every template's or typed
 * procedure to form `instructions`: reasoning does not survive a turn, the
 * state is the only memory, and every non-exempt tool call must be preceded
 * by a state update naming the exact next call.
 */
export const PROTOCOL_PARAGRAPH =
  "Reasoning from previous turns is discarded; the state is the only memory that survives " +
  "across turns, so record every future-relevant fact in it before it is lost. Before every " +
  "call to a tool not listed in exemptTools, call the skill_state_update tool with a patch " +
  "that records what you just learned and an action field {tool, input} naming exactly the " +
  "next tool call you intend to make. Exempt tools may run freely without a state update.";

/** The short generic procedure offered as the alternative to a template's own procedure. */
export const GENERIC_PROCEDURE =
  "Keep the state fields current as you work: record facts as you learn them, update " +
  "next_action before each step, and avoid leaving any field stale.";

/** Domain names that a bundled domain already uses and so cannot be created. */
export const RESERVED_DOMAIN_NAMES: string[] = ["software", "ctf"];

/** A domain name: lowercase, starts with a letter, at most 40 characters. */
export const DOMAIN_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;

/**
 * Check a candidate domain name, returning an error message stating the
 * violated rule, or that the name is reserved, or null when the name is
 * usable.
 */
export function validateDomainName(name: string): string | null {
  if (!DOMAIN_NAME_PATTERN.test(name)) {
    return "domain name must match ^[a-z][a-z0-9_-]{0,39}$: lowercase letters, digits, " +
      "underscore or hyphen, starting with a letter, at most 40 characters";
  }
  if (RESERVED_DOMAIN_NAMES.includes(name)) {
    return `"${name}" is a reserved domain name`;
  }
  return null;
}

/** An extra field's name: lowercase, starts with a letter, at most 40 characters, no hyphen. */
export const FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

// True when `type` names one of the five field types.
function isFieldType(type: string): type is FieldType {
  return (FIELD_TYPE_NAMES as string[]).includes(type);
}

/**
 * Parse a comma-separated list of "name:type" pairs into extra fields. Empty
 * text yields no fields. An empty segment produced only by a leading,
 * trailing or doubled comma is ignored rather than treated as malformed;
 * anything else wrong with a segment - no colon, more than one colon, an
 * empty name or type, a bad name, an unknown type, or a name already used by
 * an earlier pair - throws an Error naming the offending pair.
 */
export function parseExtraFields(text: string): WizardField[] {
  const trimmed = text.trim();
  if (trimmed === "") {
    return [];
  }

  const segments = trimmed
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");

  const fields: WizardField[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    const parts = segment.split(":");
    if (parts.length !== 2) {
      throw new Error(`malformed field "${segment}": expected "name:type"`);
    }
    const name = (parts[0] ?? "").trim();
    const type = (parts[1] ?? "").trim();
    if (name === "" || type === "") {
      throw new Error(`malformed field "${segment}": expected "name:type"`);
    }
    if (!FIELD_NAME_PATTERN.test(name)) {
      throw new Error(
        `invalid field name "${segment}": name must match ^[a-z][a-z0-9_]{0,39}$`,
      );
    }
    if (!isFieldType(type)) {
      throw new Error(
        `unknown field type "${segment}": type must be one of ${FIELD_TYPE_NAMES.join(", ")}`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`duplicate field "${segment}"`);
    }
    seen.add(name);
    fields.push({ name, type });
  }
  return fields;
}

/** The answers collected by the six-question flow (REQ-3), ready for `buildDomainConfig`. */
export type WizardAnswers = {
  template: TemplateId;
  extraFields: WizardField[];
  procedure: string;
  windowTurns: number;
  exemptTools: string[];
  maxObservationChars: number | undefined;
};

/**
 * Build the raw config object for a new domain from its name and the
 * collected answers, in the key order the bundled domains use. Throws
 * naming the pair when an extra field's name clashes with a template field.
 * The result always passes `normalizeConfig`.
 */
export function buildDomainConfig(name: string, answers: WizardAnswers): JsonObject {
  const template = TEMPLATES[answers.template];
  const templateNames = new Set(template.fields.map((field) => field.name));
  for (const field of answers.extraFields) {
    if (templateNames.has(field.name)) {
      throw new Error(`extra field "${field.name}:${field.type}" clashes with a template field`);
    }
  }

  const allFields = [...template.fields, ...answers.extraFields];
  const properties: JsonObject = {};
  const initialState: JsonObject = {};
  for (const field of allFields) {
    properties[field.name] = cloneJson(FIELD_TYPES[field.type].schema);
    initialState[field.name] =
      field.name === "next_action" ? NEXT_ACTION_INITIAL : cloneJson(FIELD_TYPES[field.type].initial);
  }

  const schema: JsonObject = {
    type: "object",
    properties,
    required: allFields.map((field) => field.name),
    additionalProperties: false,
  };

  const instructions = `${answers.procedure.trim()}\n\n${PROTOCOL_PARAGRAPH}`;

  const config: JsonObject = {
    name,
    instructions,
    schema,
    initialState,
    exemptTools: [...answers.exemptTools],
    windowTurns: answers.windowTurns,
    maxStateChars: template.maxStateChars,
  };
  if (answers.maxObservationChars !== undefined) {
    config.maxObservationChars = answers.maxObservationChars;
  }
  return config;
}

// One dialog option paired with the value it maps to.
type AnswerEntry<T> = { label: string; value: T };

// The first whitespace-or-comma-separated word of text, lowercased, or "" for blank text.
function leadingWord(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") {
    return "";
  }
  return (trimmed.split(/[\s,]+/)[0] ?? "").toLowerCase();
}

// Match answer against a list of labels: an exact match wins; otherwise the
// first label (in listed order) whose own leading word equals the answer's
// leading word wins, so a shared leading word resolves to the recommended
// (first) option. Anything else is unmatched.
function matchLabel(answer: string, labels: readonly string[]): string | undefined {
  const exact = labels.find((label) => label === answer);
  if (exact !== undefined) {
    return exact;
  }
  const word = leadingWord(answer);
  if (word === "") {
    return undefined;
  }
  return labels.find((label) => leadingWord(label) === word);
}

// Resolve answer to the value of the entry whose label matchLabel picks, or
// undefined when nothing matches. Only for entries whose value is never
// itself undefined; ceilingFromAnswer below needs its own logic because its
// "unset" entry's value is undefined.
function mapAnswer<T>(answer: string, entries: ReadonlyArray<AnswerEntry<T>>): T | undefined {
  const matched = matchLabel(answer, entries.map((entry) => entry.label));
  if (matched === undefined) {
    return undefined;
  }
  return entries.find((entry) => entry.label === matched)?.value;
}

const TEMPLATE_ENTRIES: ReadonlyArray<AnswerEntry<TemplateId>> = [
  { label: "Coding task (Recommended)", value: "coding" },
  { label: "Investigation", value: "investigation" },
  { label: "Operations runbook", value: "runbook" },
  { label: "Minimal", value: "minimal" },
];

/** Step 1's dialog options, recommended option first. */
export const TEMPLATE_OPTIONS: string[] = TEMPLATE_ENTRIES.map((entry) => entry.label);

/** Map step 1's answer to a template id, or undefined when unmatched. */
export function templateFromAnswer(answer: string): TemplateId | undefined {
  return mapAnswer(answer, TEMPLATE_ENTRIES);
}

/** Step 2's dialog options; free text under "Other" is parsed as "name:type" pairs. */
export const EXTRA_FIELD_OPTIONS: string[] = ["None (Recommended)", "notes:list"];

/**
 * Map step 2's answer to extra fields. "None (Recommended)", or "none"
 * case-insensitively, yields no fields; anything else is parsed with
 * parseExtraFields, which throws naming the offending pair.
 */
export function extraFieldsFromAnswer(answer: string): WizardField[] {
  if (answer === EXTRA_FIELD_OPTIONS[0] || answer.trim().toLowerCase() === "none") {
    return [];
  }
  return parseExtraFields(answer);
}

/** Step 3's dialog options; free text under "Other" is used as the procedure itself. */
export const PROCEDURE_OPTIONS: string[] = ["Template procedure (Recommended)", "Short generic procedure"];

/**
 * Map step 3's answer to procedure text for the given template: the two
 * labels resolve to the template's own procedure or GENERIC_PROCEDURE;
 * anything else, trimmed, is used as the procedure verbatim, and empty text
 * falls back to the template's own procedure.
 */
export function procedureFromAnswer(answer: string, template: TemplateId): string {
  if (answer === PROCEDURE_OPTIONS[0]) {
    return TEMPLATES[template].procedure;
  }
  if (answer === PROCEDURE_OPTIONS[1]) {
    return GENERIC_PROCEDURE;
  }
  const trimmed = answer.trim();
  return trimmed === "" ? TEMPLATES[template].procedure : trimmed;
}

const WINDOW_ENTRIES: ReadonlyArray<AnswerEntry<number>> = [
  { label: "1 (Recommended)", value: 1 },
  { label: "0 (frame only)", value: 0 },
  { label: "2", value: 2 },
];

/** Step 4's dialog options, recommended option first. */
export const WINDOW_OPTIONS: string[] = WINDOW_ENTRIES.map((entry) => entry.label);

/** Map step 4's answer to windowTurns, or undefined when unmatched. */
export function windowFromAnswer(answer: string): number | undefined {
  return mapAnswer(answer, WINDOW_ENTRIES);
}

const EXEMPT_ENTRIES: ReadonlyArray<AnswerEntry<string[]>> = [
  { label: "Read, Grep, Glob (Recommended)", value: ["Read", "Grep", "Glob"] },
  { label: "Read only", value: ["Read"] },
  { label: "None", value: [] },
];

/**
 * Step 5's dialog options, recommended option first. "Read, Grep, Glob
 * (Recommended)" and "Read only" share the leading word "read"; a typed
 * answer of "read" resolves to the recommended option, since matchLabel
 * always returns the first label (in this list's order) with a matching
 * leading word.
 */
export const EXEMPT_OPTIONS: string[] = EXEMPT_ENTRIES.map((entry) => entry.label);

/** Map step 5's answer to the exempt tool list, or undefined when unmatched. */
export function exemptFromAnswer(answer: string): string[] | undefined {
  return mapAnswer(answer, EXEMPT_ENTRIES);
}

/** Step 6's dialog options, recommended option first. */
export const CEILING_OPTIONS: string[] = ["Unset (Recommended)", "20000", "8000"];

/**
 * Map step 6's answer to a tool-result ceiling. The outer undefined means
 * the answer matched no option; the inner `value: undefined` means the
 * matched option is "Unset" (no ceiling). Wrapping the resolved value in an
 * object keeps those two cases distinguishable, unlike a bare
 * `number | undefined` return.
 */
export function ceilingFromAnswer(answer: string): { value: number | undefined } | undefined {
  const matched = matchLabel(answer, CEILING_OPTIONS);
  if (matched === undefined) {
    return undefined;
  }
  if (matched === CEILING_OPTIONS[0]) {
    return { value: undefined };
  }
  if (matched === CEILING_OPTIONS[1]) {
    return { value: 20000 };
  }
  return { value: 8000 };
}

/** REQ-4's review dialog options. */
export const REVIEW_OPTIONS: string[] = ["Write it (Recommended)", "Cancel"];

/** REQ-4's overwrite-guard dialog options. */
export const OVERWRITE_OPTIONS: string[] = ["Keep existing (Recommended)", "Overwrite"];

/** REQ-5's offer-to-start dialog options. */
export const START_OPTIONS: string[] = ["Start now (Recommended)", "Not now"];
