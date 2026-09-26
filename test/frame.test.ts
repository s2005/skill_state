import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../plugin/lib/config.ts";
import { buildFrameText, FRAME_MARKER, selectWindow } from "../plugin/lib/frame.ts";
import type { WindowMessage } from "../plugin/lib/frame.ts";
import { createRuntime } from "../plugin/lib/runtime.ts";
import software from "../plugin/domains/software.json";

type Msg = WindowMessage & { id: string };

const user = (id: string, text = id): Msg => ({ id, role: "user", text });
const assistant = (id: string): Msg => ({ id, role: "assistant", text: id });
const result = (id: string): Msg => ({ id, role: "user", text: "", toolResults: [{ tool_use_id: id }] });
const frame = (id: string): Msg => ({ id, role: "user", text: `${FRAME_MARKER}\n\nold` });

// frame, then three turns; turns two and three use tools.
const TRANSCRIPT: Msg[] = [
  frame("f"),
  user("u1"), assistant("a1"),
  user("u2"), assistant("a2-use"), result("r2"), assistant("a2"),
  user("u3"), assistant("a3-use"), result("r3a"), assistant("a3-use2"), result("r3b"), assistant("a3"),
];

const ids = (messages: Msg[]): string[] => messages.map((m) => m.id);

describe("selectWindow", () => {
  it("keeps nothing for windowTurns 0", () => {
    expect(selectWindow(TRANSCRIPT, 0)).toEqual([]);
  });

  it("keeps the last turn with its tool_use and tool_result pairs for windowTurns 1", () => {
    expect(ids(selectWindow(TRANSCRIPT, 1))).toEqual(["u3", "a3-use", "r3a", "a3-use2", "r3b", "a3"]);
  });

  it("keeps the last two turns for windowTurns 2", () => {
    expect(ids(selectWindow(TRANSCRIPT, 2))).toEqual(["u2", "a2-use", "r2", "a2", "u3", "a3-use", "r3a", "a3-use2", "r3b", "a3"]);
  });

  it("never starts at a tool_result and never keeps an earlier frame", () => {
    const window = selectWindow(TRANSCRIPT, 10);
    expect(ids(window)[0]).toBe("u1");
    expect(window.some((m) => m.text.startsWith(FRAME_MARKER))).toBe(false);
  });

  it("returns nothing when the transcript has no user prompt", () => {
    expect(selectWindow([frame("f"), assistant("a")], 1)).toEqual([]);
  });

  it("does not mutate its input", () => {
    const copy = [...TRANSCRIPT];
    selectWindow(TRANSCRIPT, 1);
    expect(TRANSCRIPT).toEqual(copy);
  });
});

describe("buildFrameText", () => {
  const runtime = {
    ...createRuntime(normalizeConfig(software, "software.json"), "software"),
    objective: "Fix the login bug",
    step: 7,
  };
  runtime.state = { ...runtime.state, facts: ["auth.ts owns login"] };

  it("holds marker, objective, procedure, state JSON and step", () => {
    const text = buildFrameText(runtime, "mcp__skill-state__skill_state_update");
    expect(text.startsWith(FRAME_MARKER)).toBe(true);
    expect(text).toContain("Objective:\nFix the login bug");
    expect(text).toContain(runtime.config.instructions);
    expect(text).toContain('"auth.ts owns login"');
    expect(text).toContain("Current state (step 7)");
    expect(text).toContain("mcp__skill-state__skill_state_update");
    expect(text).toContain("[Read, Grep, Glob]");
  });

  it("says when no objective was captured", () => {
    expect(buildFrameText({ ...runtime, objective: null }, "t")).toContain("(not captured)");
  });
});
