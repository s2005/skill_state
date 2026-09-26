/**
 * Action normalization, action matching and the tool-call gate (REQ-3, REQ-4).
 */

import type { JsonObject } from "./json.ts";
import { cloneJson, findUnsafeKeys, isPlainObject, jsonEqual } from "./json.ts";

/** Short name of the state tool as registered. */
export const STATE_TOOL = "skill_state_update";

/** Name the model calls the state tool by: `mcp__<plugin>__<name>`. */
export const STATE_TOOL_FULL = `mcp__skill-state__${STATE_TOOL}`;

/**
 * Tools the gate never binds: the state tool, and ToolSearch, which loads the
 * state tool's schema when the engine defers it; gating it would deadlock.
 */
export const ALWAYS_EXEMPT: ReadonlySet<string> = new Set([STATE_TOOL_FULL, "ToolSearch"]);

/** The one mutating tool call a validated patch permits. */
export type PendingAction = { tool: string; input: JsonObject };

/**
 * Validate and normalize the `action` of a state tool call: `tool` is a
 * non-empty name (a provider prefix such as `functions.` is dropped) that is
 * not the state tool itself, and `input` is a JSON object with safe keys.
 * Throws an Error naming the offending field.
 */
export function normalizeAction(action: unknown, source = "action"): PendingAction {
  if (!isPlainObject(action)) {
    throw new Error(`${source} must be a JSON object with "tool" and "input"`);
  }
  const rawTool = action["tool"];
  if (typeof rawTool !== "string" || rawTool.trim() === "") {
    throw new Error(`${source}.tool must be a non-empty string`);
  }
  const trimmed = rawTool.trim();
  const tool = trimmed.startsWith("functions.") ? trimmed.slice("functions.".length) : trimmed;
  if (tool === "") {
    throw new Error(`${source}.tool must name a tool`);
  }
  if (tool === STATE_TOOL || tool === STATE_TOOL_FULL) {
    throw new Error(`${source}.tool cannot be ${STATE_TOOL}`);
  }
  const input = action["input"];
  if (!isPlainObject(input)) {
    throw new Error(`${source}.input must be a JSON object`);
  }
  const unsafe = findUnsafeKeys(input, `${source}.input`);
  if (unsafe.length > 0) {
    throw new Error(unsafe.join("; "));
  }
  return { tool, input: cloneJson(input) };
}

/** What the gate does with one tool call on the main loop. */
export type GateDecision =
  | { kind: "pass" }
  | { kind: "exempt" }
  | { kind: "allow" }
  | { kind: "deny"; reason: string };

/** The part of the runtime the gate reads. */
export type GateRuntime = {
  isActive: boolean;
  config: { exemptTools: string[] };
  pendingAction: PendingAction | null;
};

/** True when a call's tool name and input equal the pending action's. */
export function actionMatches(expected: PendingAction | null, tool: string, input: JsonObject): boolean {
  return expected !== null && expected.tool === tool && jsonEqual(expected.input, input);
}

/**
 * Decide one main-loop tool call: `pass` while no runtime is active, `exempt`
 * for ALWAYS_EXEMPT and the domain's exempt tools, `allow` when the call
 * equals the pending action, otherwise `deny` with the call to make instead.
 */
export function decide(runtime: GateRuntime | null, tool: string, input: JsonObject): GateDecision {
  if (runtime === null || !runtime.isActive) {
    return { kind: "pass" };
  }
  if (ALWAYS_EXEMPT.has(tool) || runtime.config.exemptTools.includes(tool)) {
    return { kind: "exempt" };
  }
  if (actionMatches(runtime.pendingAction, tool, input)) {
    return { kind: "allow" };
  }
  const expected = JSON.stringify({ tool, input });
  const pending = runtime.pendingAction === null
    ? "No action is bound."
    : `The bound action is ${runtime.pendingAction.tool} ${JSON.stringify(runtime.pendingAction.input)}, which this call does not match.`;
  return {
    kind: "deny",
    reason: `skill-state: ${tool} is not bound to a state transition. ${pending} First call ${STATE_TOOL_FULL} with a patch recording what you learned and action ${expected}, then repeat this exact call. If ${STATE_TOOL_FULL} is not loaded, load it with ToolSearch (query "select:${STATE_TOOL_FULL}").`,
  };
}
