import { describe, expect, it } from "vitest";
import { OBSERVATION_MARKER_PREFIX, truncateObservation, truncateResult } from "../plugin/lib/observation.ts";

describe("truncateObservation", () => {
  it("leaves text unchanged when under the limit", () => {
    expect(truncateObservation("hello", 10)).toBe("hello");
  });

  it("leaves text unchanged when exactly at the limit", () => {
    expect(truncateObservation("hello", 5)).toBe("hello");
  });

  it("truncates text over the limit with a marker and omitted count", () => {
    const text = "0123456789";
    const result = truncateObservation(text, 4);
    expect(result).toBe(`0123\n${OBSERVATION_MARKER_PREFIX} 6 characters omitted]`);
    expect(result.startsWith("0123\n")).toBe(true);
  });

  it("leaves text unchanged when maxChars is undefined", () => {
    const text = "x".repeat(1000);
    expect(truncateObservation(text)).toBe(text);
  });
});

describe("truncateResult", () => {
  it("leaves the value untouched when the ceiling is unset", () => {
    const value = { stdout: "x".repeat(50) };
    expect(truncateResult(value)).toEqual({ value, isTruncated: false });
  });

  it("truncates long strings at any depth and keeps the shape", () => {
    const value = { stdout: "a".repeat(30), stderr: "", nested: [{ text: "b".repeat(12) }, 5, null, true] };
    const out = truncateResult(value, 10);
    expect(out.isTruncated).toBe(true);
    expect(out.value).toEqual({
      stdout: `${"a".repeat(10)}\n[Observation truncated: 20 characters omitted]`,
      stderr: "",
      nested: [{ text: `${"b".repeat(10)}\n[Observation truncated: 2 characters omitted]` }, 5, null, true],
    });
    expect(value.stdout).toHaveLength(30);
  });

  it("returns the same reference when nothing is over the ceiling", () => {
    const value = { stdout: "short", list: ["a"] };
    const out = truncateResult(value, 10);
    expect(out.isTruncated).toBe(false);
    expect(out.value).toBe(value);
  });

  it("truncates a bare string result", () => {
    expect(truncateResult("abcdef", 3)).toEqual({ value: "abc\n[Observation truncated: 3 characters omitted]", isTruncated: true });
  });
});
