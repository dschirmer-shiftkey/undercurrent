import { describe, expect, it } from "vitest";
import type { ConversationTurn } from "../types.js";
import { runPreflight } from "./preflight.js";

const basePolicy = {
  enabled: true,
  silentCorrectionsEnabled: true,
  blockOnCascadeRisk: "high" as const,
  maxCorrectionsPerMessage: 5,
};

function turns(...content: string[]): ConversationTurn[] {
  return content.map((c, idx) => ({
    role: idx % 2 === 0 ? "user" : "assistant",
    content: c,
  }));
}

describe("runPreflight", () => {
  it("corrects typos based on repeated session vocabulary", () => {
    const result = runPreflight({
      message: "fix auh middleware",
      conversation: turns(
        "auth middleware keeps failing",
        "let us inspect auth middleware.ts",
        "auth should be strict here",
      ),
      recentDecisions: [],
      policy: basePolicy,
    });

    expect(result.correctedMessage).toContain("auth");
    expect(result.corrections.some((c) => c.type === "typo")).toBe(true);
  });

  it("normalizes shorthand continuation messages", () => {
    const result = runPreflight({
      message: "continue",
      conversation: [],
      recentDecisions: [],
      policy: basePolicy,
    });

    expect(result.correctedMessage).toBe("acknowledge and continue with the current task");
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0]?.type).toBe("continuation");
  });

  it("scores high cascade risk for ambiguous high-consequence prompts", () => {
    const result = runPreflight({
      message: "merge that",
      conversation: [],
      recentDecisions: [],
      policy: basePolicy,
    });

    expect(result.cascadeRisk.level).toBe("high");
    expect(result.blockingClarificationNeeded).toBe(true);
  });

  it("flags contradictions against recent decisions", () => {
    const result = runPreflight({
      message: "do not change developer pages to white theme",
      conversation: [],
      recentDecisions: ["Change developer pages to white theme and apply globally."],
      policy: basePolicy,
    });

    expect(result.contradictions.length).toBeGreaterThan(0);
    expect(result.blockingClarificationNeeded).toBe(true);
  });

  it("does not treat substrings like 'no' inside 'node' as negation", () => {
    const result = runPreflight({
      message: "let's use the node runtime for the developer pages",
      conversation: [],
      recentDecisions: ["Use the node runtime and apply developer pages styling."],
      policy: basePolicy,
    });

    expect(result.contradictions).toEqual([]);
    expect(result.blockingClarificationNeeded).toBe(false);
  });

  it("does not treat 'notion' or 'notes' as negation", () => {
    const result = runPreflight({
      message: "review the notion of caching in the developer pages notes",
      conversation: [],
      recentDecisions: ["Add caching to developer pages and document it in notes."],
      policy: basePolicy,
    });

    expect(result.contradictions).toEqual([]);
    expect(result.blockingClarificationNeeded).toBe(false);
  });

  it("does not flag contradictions on trivial single-word overlap", () => {
    const result = runPreflight({
      message: "don't worry about it",
      conversation: [],
      recentDecisions: ["Change developer pages to white theme and apply globally."],
      policy: basePolicy,
    });

    expect(result.contradictions).toEqual([]);
  });

  it("still flags real negated contradictions with sufficient content overlap", () => {
    const result = runPreflight({
      message: "don't apply the white theme to developer pages",
      conversation: [],
      recentDecisions: ["Apply the white theme to developer pages globally."],
      policy: basePolicy,
    });

    expect(result.contradictions.length).toBeGreaterThan(0);
    expect(result.blockingClarificationNeeded).toBe(true);
  });
});
