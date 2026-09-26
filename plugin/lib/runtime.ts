/**
 * The SKILL.state runtime record and its pure operations (REQ-3, REQ-7, REQ-8).
 *
 * The hooks module persists this record in `$.state` and `$.store`; every
 * function here returns a new record and never mutates its input.
 */

import type { DomainConfig } from "./config.ts";
import type { JsonObject } from "./json.ts";
import { cloneJson } from "./json.ts";
import type { PendingAction } from "./gate.ts";

/** Token sums from `turn.complete` usage since `start`. */
export type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  turns: number;
};

/** The runtime: config, objective, state, step and pending action. */
export type Runtime = {
  isActive: boolean;
  source: string;
  config: DomainConfig;
  objective: string | null;
  state: JsonObject;
  step: number;
  pendingAction: PendingAction | null;
  usage: UsageTotals;
  lastFrameChars: number | null;
  lastCompaction: string | null;
};

/** The subset of a turn's usage the runtime sums. */
export type TurnUsageLike = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
};

/** The subcommands `/skill-state` accepts. */
export const SUBCOMMANDS = ["start", "new", "status", "stop", "resume", "reset"] as const;

export type Subcommand = (typeof SUBCOMMANDS)[number];

/** A parsed `/skill-state` argument string. */
export type ParsedCommand =
  | { ok: true; subcommand: Subcommand; argument: string }
  | { ok: false; error: string };

/** The usage line `/skill-state` prints for an unknown or missing subcommand. */
export const COMMAND_USAGE =
  "Usage: /skill-state start <domain|path> | new <name> | status | stop | resume | reset";

/** A fresh runtime for a loaded config: step 0, initial state, no objective. */
export function createRuntime(config: DomainConfig, source: string): Runtime {
  return {
    isActive: true,
    source,
    config,
    objective: null,
    state: cloneJson(config.initialState),
    step: 0,
    pendingAction: null,
    usage: { input: 0, output: 0, cacheRead: 0, turns: 0 },
    lastFrameChars: null,
    lastCompaction: null,
  };
}

/**
 * The runtime after `reset`: initial state, step 0, no objective and no
 * pending action; config, active flag and usage sums are kept.
 */
export function resetRuntime(runtime: Runtime): Runtime {
  return {
    ...runtime,
    objective: null,
    state: cloneJson(runtime.config.initialState),
    step: 0,
    pendingAction: null,
    lastFrameChars: null,
    lastCompaction: null,
  };
}

/** The runtime after one more main-loop turn, its usage added when present. */
export function addTurnUsage(runtime: Runtime, usage: TurnUsageLike | undefined): Runtime {
  return {
    ...runtime,
    usage: {
      input: runtime.usage.input + (usage?.input_tokens ?? 0),
      output: runtime.usage.output + (usage?.output_tokens ?? 0),
      cacheRead: runtime.usage.cacheRead + (usage?.cache_read_input_tokens ?? 0),
      turns: runtime.usage.turns + 1,
    },
  };
}

/** Split `/skill-state` arguments into a subcommand and the rest. */
export function parseCommand(args: string): ParsedCommand {
  const trimmed = args.trim();
  const space = trimmed.search(/\s/);
  const word = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const argument = space === -1 ? "" : trimmed.slice(space).trim();
  const subcommand = SUBCOMMANDS.find((name) => name === word);
  if (subcommand === undefined) {
    return { ok: false, error: word === "" ? COMMAND_USAGE : `Unknown subcommand "${word}". ${COMMAND_USAGE}` };
  }
  return { ok: true, subcommand, argument };
}

/**
 * Where `start` reads its config: a bundled domain by bare name, or a path
 * (anything with a slash, a backslash or a `.json` suffix) as given.
 */
export function resolveConfigPath(argument: string, pluginRoot: string): string {
  const isPath = /[\\/]/.test(argument) || argument.toLowerCase().endsWith(".json");
  return isPath ? argument : `${pluginRoot}/domains/${argument}.json`;
}

/** Size of the state as the model reads it: JSON text length in characters. */
export function stateChars(state: JsonObject): number {
  return JSON.stringify(state).length;
}

/** The status-line entry: domain and step while active, nothing otherwise. */
export function statusLine(runtime: Runtime | null): string | undefined {
  if (runtime === null || !runtime.isActive) {
    return undefined;
  }
  return `skill-state: ${runtime.config.name} step ${runtime.step}`;
}

/** The `/skill-state status` report: every REQ-8 field, one per line. */
export function formatStatus(runtime: Runtime | null): string {
  if (runtime === null) {
    return "Not started. Run /skill-state start <domain|path>.";
  }
  const pending = runtime.pendingAction === null
    ? "none"
    : `${runtime.pendingAction.tool} ${JSON.stringify(runtime.pendingAction.input)}`;
  const lines = [
    `runtime: ${runtime.isActive ? "active" : "stopped"}`,
    `domain: ${runtime.config.name} (${runtime.source})`,
    `objective: ${runtime.objective ?? "(next prompt)"}`,
    `step: ${runtime.step}`,
    `pending action: ${pending}`,
    `state size: ${stateChars(runtime.state)} chars (max ${runtime.config.maxStateChars})`,
    `last frame size: ${runtime.lastFrameChars === null ? "none" : `${runtime.lastFrameChars} chars`}`,
    `last compaction: ${runtime.lastCompaction ?? "none"}`,
    `tokens since start: input ${runtime.usage.input}, output ${runtime.usage.output}, cache read ${runtime.usage.cacheRead} over ${runtime.usage.turns} turns`,
  ];
  return lines.join("\n");
}

/**
 * The context attached to the objective prompt: the procedure, the schema
 * contract and the initial state, so the first turn follows the protocol.
 */
export function buildStartContext(runtime: Runtime, stateToolName: string): string {
  return [
    `SKILL.state runtime is active (domain: ${runtime.config.name}).`,
    `Procedure:\n${runtime.config.instructions}`,
    `State tool: ${stateToolName} with input { patch, action? }. If its schema is not loaded yet, load it with ToolSearch (query "select:${stateToolName}"); ToolSearch is always allowed. patch merges into the state (objects merge, arrays and scalars replace, null deletes). action { tool, input } names exactly the next mutating tool call.`,
    `Exempt tools (no state update needed): ${runtime.config.exemptTools.length === 0 ? "none" : runtime.config.exemptTools.join(", ")}.`,
    `State schema:\n${JSON.stringify(runtime.config.schema)}`,
    `Current state (step ${runtime.step}):\n${JSON.stringify(runtime.state, null, 2)}`,
  ].join("\n\n");
}
