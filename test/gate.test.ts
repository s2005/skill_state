import { describe, expect, it } from "vitest";
import { actionMatches, decide, normalizeAction, STATE_TOOL_FULL } from "../plugin/lib/gate.ts";
import type { GateRuntime } from "../plugin/lib/gate.ts";

const active = (pending: GateRuntime["pendingAction"] = null): GateRuntime => ({
  isActive: true,
  config: { exemptTools: ["Read", "Grep"] },
  pendingAction: pending,
});

describe("normalizeAction", () => {
  it("accepts tool and input, dropping a functions. prefix and cloning input", () => {
    const input = { file_path: "a", nested: { x: [1] } };
    const action = normalizeAction({ tool: " functions.Edit ", input });
    expect(action).toEqual({ tool: "Edit", input });
    expect(action.input).not.toBe(input);
  });

  it("rejects non-objects, empty tool names and non-object input", () => {
    expect(() => normalizeAction("Edit")).toThrow("action must be a JSON object");
    expect(() => normalizeAction({ tool: "", input: {} })).toThrow("action.tool must be a non-empty string");
    expect(() => normalizeAction({ tool: "functions.", input: {} })).toThrow("action.tool must name a tool");
    expect(() => normalizeAction({ tool: "Edit", input: [] })).toThrow("action.input must be a JSON object");
  });

  it("rejects binding the state tool itself", () => {
    expect(() => normalizeAction({ tool: "skill_state_update", input: {} })).toThrow("cannot be skill_state_update");
    expect(() => normalizeAction({ tool: STATE_TOOL_FULL, input: {} })).toThrow("cannot be skill_state_update");
  });

  it("rejects unsafe keys in the input", () => {
    expect(() => normalizeAction({ tool: "Edit", input: JSON.parse('{"__proto__": {"x": 1}}') })).toThrow("action.input.__proto__");
  });
});

describe("actionMatches", () => {
  const pending = { tool: "Edit", input: { a: 1, b: { c: [1, 2] } } };

  it("matches equal tool and deep-equal input regardless of key order", () => {
    expect(actionMatches(pending, "Edit", { b: { c: [1, 2] }, a: 1 })).toBe(true);
  });

  it("does not match another tool, other input, extra keys or no pending action", () => {
    expect(actionMatches(pending, "Write", { a: 1, b: { c: [1, 2] } })).toBe(false);
    expect(actionMatches(pending, "Edit", { a: 1, b: { c: [2, 1] } })).toBe(false);
    expect(actionMatches(pending, "Edit", { a: 1, b: { c: [1, 2] }, d: 0 })).toBe(false);
    expect(actionMatches(null, "Edit", {})).toBe(false);
  });
});

describe("decide", () => {
  it("passes everything while no runtime is active", () => {
    expect(decide(null, "Edit", {})).toEqual({ kind: "pass" });
    expect(decide({ ...active(), isActive: false }, "Edit", {})).toEqual({ kind: "pass" });
  });

  it("exempts the state tool and the domain's exempt tools", () => {
    expect(decide(active(), STATE_TOOL_FULL, {})).toEqual({ kind: "exempt" });
    expect(decide(active(), "Read", { file_path: "x" })).toEqual({ kind: "exempt" });
  });

  it("always exempts ToolSearch, which loads the deferred state tool", () => {
    expect(decide(active(), "ToolSearch", { query: `select:${STATE_TOOL_FULL}` })).toEqual({ kind: "exempt" });
  });

  it("tells the model how to load the state tool when denying", () => {
    const d = decide(active(), "Write", { file_path: "a" });
    expect(d.kind === "deny" && d.reason).toContain(`ToolSearch (query "select:${STATE_TOOL_FULL}")`);
  });

  it("allows the call equal to the pending action", () => {
    expect(decide(active({ tool: "Bash", input: { command: "ls" } }), "Bash", { command: "ls" })).toEqual({ kind: "allow" });
  });

  it("denies an unbound call with the call to make instead", () => {
    const d = decide(active(), "Bash", { command: "ls" });
    expect(d.kind).toBe("deny");
    expect(d.kind === "deny" && d.reason).toContain("No action is bound.");
    expect(d.kind === "deny" && d.reason).toContain(`${STATE_TOOL_FULL}`);
    expect(d.kind === "deny" && d.reason).toContain('{"tool":"Bash","input":{"command":"ls"}}');
  });

  it("denies a call that differs from the pending action and names the bound one", () => {
    const d = decide(active({ tool: "Bash", input: { command: "ls" } }), "Bash", { command: "rm -rf x" });
    expect(d.kind === "deny" && d.reason).toContain('The bound action is Bash {"command":"ls"}');
  });
});
