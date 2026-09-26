import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../plugin/lib/config.ts";
import {
  addTurnUsage,
  COMMAND_USAGE,
  createRuntime,
  formatStatus,
  parseCommand,
  resetRuntime,
  resolveConfigPath,
  statusLine,
} from "../plugin/lib/runtime.ts";
import software from "../plugin/domains/software.json";

const config = normalizeConfig(software, "software.json");

describe("parseCommand", () => {
  it("splits subcommand and argument", () => {
    expect(parseCommand("  START  ./a b.json ")).toEqual({ ok: true, subcommand: "start", argument: "./a b.json" });
    expect(parseCommand("status")).toEqual({ ok: true, subcommand: "status", argument: "" });
  });

  it("parses the new subcommand with its name", () => {
    expect(parseCommand("new demo")).toEqual({ ok: true, subcommand: "new", argument: "demo" });
  });

  it("rejects missing and unknown subcommands", () => {
    const missing = parseCommand("");
    expect(missing.ok).toBe(false);
    const unknown = parseCommand("go");
    expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining('Unknown subcommand "go"') });
  });

  it("usage lists the new subcommand", () => {
    expect(COMMAND_USAGE).toContain("new <name>");
  });
});

describe("resolveConfigPath", () => {
  it("maps a bare name to the bundled domains folder", () => {
    expect(resolveConfigPath("software", "/pkg")).toBe("/pkg/domains/software.json");
  });

  it("keeps paths as given", () => {
    expect(resolveConfigPath("cfg/x.json", "/pkg")).toBe("cfg/x.json");
    expect(resolveConfigPath("x.json", "/pkg")).toBe("x.json");
    expect(resolveConfigPath("C:\\c\\x", "/pkg")).toBe("C:\\c\\x");
  });
});

describe("runtime record", () => {
  it("starts at step 0 with the initial state and no objective", () => {
    const runtime = createRuntime(config, "software");
    expect(runtime.step).toBe(0);
    expect(runtime.objective).toBeNull();
    expect(runtime.state).toEqual(config.initialState);
    expect(runtime.state).not.toBe(config.initialState);
  });

  it("sums turn usage and counts turns without usage", () => {
    const usage = { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 5 };
    const once = addTurnUsage(createRuntime(config, "s"), usage);
    const twice = addTurnUsage(once, undefined);
    expect(twice.usage).toEqual({ input: 3, output: 2, cacheRead: 5, turns: 2 });
  });

  it("reset keeps config, active flag and usage", () => {
    const runtime = { ...addTurnUsage(createRuntime(config, "s"), undefined), step: 3, objective: "x", state: { plan: ["a"] } };
    const reset = resetRuntime(runtime);
    expect(reset).toMatchObject({ step: 0, objective: null, pendingAction: null, isActive: true, usage: runtime.usage });
    expect(reset.state).toEqual(config.initialState);
  });

  it("status line shows domain and step only while active", () => {
    const runtime = createRuntime(config, "s");
    expect(statusLine(runtime)).toBe("skill-state: software step 0");
    expect(statusLine({ ...runtime, isActive: false })).toBeUndefined();
    expect(statusLine(null)).toBeUndefined();
  });

  it("status report lists every field", () => {
    const text = formatStatus(createRuntime(config, "s"));
    for (const field of ["domain:", "objective:", "step:", "pending action:", "state size:", "last frame size:", "tokens since start:"]) {
      expect(text).toContain(field);
    }
  });
});
