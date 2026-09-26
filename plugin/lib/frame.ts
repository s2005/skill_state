/**
 * The turn-end frame and the window of turns kept after it (REQ-5).
 */

import type { Runtime } from "./runtime.ts";

/** First line of every frame message; marks it so a later window skips it. */
export const FRAME_MARKER = "[SKILL.state frame]";

/** The `instructions` the plugin compacts with, so its hook knows the call. */
export const FRAME_INSTRUCTIONS = "skill-state: replace history with the execution frame";

/** The subset of a transcript message the window selection reads. */
export type WindowMessage = {
  role: "user" | "assistant";
  text: string;
  toolResults?: readonly unknown[];
};

/**
 * The frame the transcript is replaced with: objective, procedure, the
 * state tool's protocol, the current state as JSON and the step number.
 */
export function buildFrameText(runtime: Runtime, stateToolName: string): string {
  const exempt = runtime.config.exemptTools.length === 0 ? "none" : runtime.config.exemptTools.join(", ");
  return [
    FRAME_MARKER,
    `Earlier turns were replaced by this frame. The state below is the only memory that carries over; the last ${runtime.config.windowTurns} turn(s) follow it verbatim.`,
    `Objective:\n${runtime.objective ?? "(not captured)"}`,
    `Procedure (domain ${runtime.config.name}):\n${runtime.config.instructions}`,
    `State tool: ${stateToolName} with input { patch, action? }. Before any tool call not in [${exempt}], call it with a patch and action { tool, input } naming exactly that call. If its schema is not loaded, load it with ToolSearch (query "select:${stateToolName}"); ToolSearch is always allowed.`,
    `Current state (step ${runtime.step}):\n${JSON.stringify(runtime.state, null, 2)}`,
  ].join("\n\n");
}

/** True for a user message a person typed: not tool results, not a frame. */
function isTurnStart(message: WindowMessage): boolean {
  return message.role === "user" && (message.toolResults?.length ?? 0) === 0 && !message.text.startsWith(FRAME_MARKER);
}

/**
 * The last `windowTurns` turns of the transcript, each starting at a user
 * prompt, so tool_use and tool_result pairs are never split. Earlier frames
 * are never part of the window. `windowTurns` 0 keeps nothing.
 */
export function selectWindow<M extends WindowMessage>(messages: readonly M[], windowTurns: number): M[] {
  if (windowTurns <= 0) {
    return [];
  }
  const starts: number[] = [];
  messages.forEach((message, index) => {
    if (isTurnStart(message)) {
      starts.push(index);
    }
  });
  if (starts.length === 0) {
    return [];
  }
  const from = starts[Math.max(0, starts.length - windowTurns)] ?? 0;
  return messages.slice(from).filter((message) => !(message.role === "user" && message.text.startsWith(FRAME_MARKER)));
}
