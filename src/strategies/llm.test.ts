import { describe, expect, it, vi } from "vitest";
import { LlmStrategy } from "./llm.js";
import type { ContextLayer, ConversationTurn, Gap } from "../types.js";

function makeContext(overrides: Partial<ContextLayer> = {}): ContextLayer {
  return {
    source: "git",
    priority: 1,
    timestamp: Date.now(),
    data: {},
    summary: "On branch feat/auth. Modified: src/auth/middleware.ts",
    ...overrides,
  };
}

function makeGap(overrides: Partial<Gap> = {}): Gap {
  return {
    id: "gap-1",
    description: "No specific file referenced",
    critical: true,
    resolution: null,
    ...overrides,
  };
}

const conversation: ConversationTurn[] = [
  { role: "user", content: "I've been working on the login flow" },
  { role: "assistant", content: "I see you modified auth/middleware.ts" },
];

describe("LlmStrategy", () => {
  describe("classifyIntent", () => {
    it("returns LLM classification on valid JSON response", async () => {
      const llmCall = vi.fn().mockResolvedValue(
        JSON.stringify({
          action: "fix",
          specificity: "medium",
          scope: "local",
          emotionalLoad: "frustrated",
          confidence: 0.85,
          rawFragments: ["auth thing"],
          domainHints: ["auth"],
        }),
      );

      const strategy = new LlmStrategy({ llmCall });
      const result = await strategy.classifyIntent("fix the auth thing", conversation);

      expect(result.action).toBe("fix");
      expect(result.specificity).toBe("medium");
      expect(result.emotionalLoad).toBe("frustrated");
      expect(result.confidence).toBe(0.85);
      expect(result.domainHints).toEqual(["auth"]);
      expect(llmCall).toHaveBeenCalledOnce();
    });

    it("skips LLM for high-confidence high-specificity messages", async () => {
      const llmCall = vi.fn();
      const strategy = new LlmStrategy({ llmCall, heuristicConfidenceThreshold: 0.6 });

      const result = await strategy.classifyIntent(
        "fix the bug on line 42 in src/auth/middleware.ts where the JWT validation check is wrong",
        [],
      );

      expect(result.action).toBe("fix");
      expect(result.specificity).toBe("high");
      expect(llmCall).not.toHaveBeenCalled();
    });

    it("falls back to heuristic on LLM error", async () => {
      const llmCall = vi.fn().mockRejectedValue(new Error("LLM unavailable"));
      const strategy = new LlmStrategy({ llmCall });

      const result = await strategy.classifyIntent("fix the auth thing", conversation);

      expect(result.action).toBe("fix");
      expect(llmCall).toHaveBeenCalledOnce();
    });

    it("falls back to heuristic on malformed JSON", async () => {
      const llmCall = vi.fn().mockResolvedValue("I think the intent is to fix something");
      const strategy = new LlmStrategy({ llmCall });

      const result = await strategy.classifyIntent("fix the auth thing", conversation);

      expect(result.action).toBe("fix");
      expect(llmCall).toHaveBeenCalledOnce();
    });

    it("falls back on valid JSON with invalid field values", async () => {
      const llmCall = vi.fn().mockResolvedValue(
        JSON.stringify({
          action: "destroy",
          specificity: "mega",
          scope: "galactic",
          emotionalLoad: "zen",
          confidence: 0.5,
          rawFragments: [],
          domainHints: [],
        }),
      );

      const strategy = new LlmStrategy({ llmCall });
      const result = await strategy.classifyIntent("fix the auth thing", []);

      expect(result.action).toBe("fix");
    });

    it("extracts JSON from markdown code blocks", async () => {
      const llmCall = vi.fn().mockResolvedValue(
        '```json\n{"action":"build","specificity":"low","scope":"product","emotionalLoad":"excited","confidence":0.7,"rawFragments":["new feature"],"domainHints":["ui"]}\n```',
      );

      const strategy = new LlmStrategy({ llmCall });
      const result = await strategy.classifyIntent("build me a cool new dashboard", []);

      expect(result.action).toBe("build");
      expect(result.scope).toBe("product");
      expect(result.emotionalLoad).toBe("excited");
    });

    it("respects custom heuristicConfidenceThreshold", async () => {
      const llmCall = vi.fn().mockResolvedValue(
        JSON.stringify({
          action: "fix",
          specificity: "high",
          scope: "atomic",
          emotionalLoad: "neutral",
          confidence: 0.95,
          rawFragments: [],
          domainHints: ["testing"],
        }),
      );

      const strategy = new LlmStrategy({ llmCall, heuristicConfidenceThreshold: 1.0 });
      await strategy.classifyIntent("fix the bug on line 42 in src/auth/middleware.ts", []);

      expect(llmCall).toHaveBeenCalledOnce();
    });
  });

  describe("analyzeGaps", () => {
    it("returns LLM-identified gaps", async () => {
      const llmCall = vi.fn().mockResolvedValue(
        JSON.stringify([
          { description: "Which authentication method (JWT vs session)?", critical: true },
          { description: "Target Node.js version", critical: false },
        ]),
      );

      const strategy = new LlmStrategy({ llmCall });
      const intent = await new LlmStrategy({ llmCall: vi.fn() })["fallback"].classifyIntent("fix auth", []);
      const result = await strategy.analyzeGaps(intent, [makeContext()], "fix auth");

      expect(result).toHaveLength(2);
      expect(result[0].description).toBe("Which authentication method (JWT vs session)?");
      expect(result[0].critical).toBe(true);
      expect(result[0].id).toBeTruthy();
      expect(result[1].critical).toBe(false);
    });

    it("returns empty array when LLM says no gaps", async () => {
      const llmCall = vi.fn().mockResolvedValue("[]");
      const strategy = new LlmStrategy({ llmCall });
      const intent = await strategy["fallback"].classifyIntent("fix line 42 in auth.ts", []);
      const result = await strategy.analyzeGaps(intent, [makeContext()], "fix line 42 in auth.ts");

      expect(result).toEqual([]);
    });

    it("falls back to heuristic on LLM failure", async () => {
      const llmCall = vi.fn().mockRejectedValue(new Error("timeout"));
      const strategy = new LlmStrategy({ llmCall });
      const intent = await strategy["fallback"].classifyIntent("fix the auth thing", []);
      const result = await strategy.analyzeGaps(intent, [], "fix the auth thing");

      expect(result.length).toBeGreaterThan(0);
    });

    it("filters out malformed gap objects", async () => {
      const llmCall = vi.fn().mockResolvedValue(
        JSON.stringify([
          { description: "Valid gap", critical: true },
          { bad: "data" },
          { description: 123, critical: "yes" },
        ]),
      );

      const strategy = new LlmStrategy({ llmCall });
      const intent = await strategy["fallback"].classifyIntent("fix auth", []);
      const result = await strategy.analyzeGaps(intent, [], "fix auth");

      expect(result).toHaveLength(1);
      expect(result[0].description).toBe("Valid gap");
    });
  });

  describe("resolveGap", () => {
    it("returns filled resolution from LLM", async () => {
      const llmCall = vi.fn().mockResolvedValue(
        JSON.stringify({ type: "filled", value: "src/auth/middleware.ts", source: "git" }),
      );

      const strategy = new LlmStrategy({ llmCall });
      const result = await strategy.resolveGap(makeGap(), [makeContext()], 0.6);

      expect(result.type).toBe("filled");
      if (result.type === "filled") {
        expect(result.value).toBe("src/auth/middleware.ts");
        expect(result.source).toBe("git");
      }
    });

    it("returns assumed resolution from LLM", async () => {
      const llmCall = vi.fn().mockResolvedValue(
        JSON.stringify({
          type: "assumed",
          claim: "User is referring to JWT middleware",
          basis: "Branch name contains 'auth'",
          confidence: 0.7,
        }),
      );

      const strategy = new LlmStrategy({ llmCall });
      const result = await strategy.resolveGap(makeGap(), [makeContext()], 0.6);

      expect(result.type).toBe("assumed");
      if (result.type === "assumed") {
        expect(result.assumption.claim).toBe("User is referring to JWT middleware");
        expect(result.assumption.confidence).toBe(0.7);
        expect(result.assumption.source).toBe("llm-strategy");
        expect(result.assumption.correctable).toBe(true);
      }
    });

    it("returns clarification from LLM", async () => {
      const llmCall = vi.fn().mockResolvedValue(
        JSON.stringify({ type: "needs-clarification", question: "Which auth file?" }),
      );

      const strategy = new LlmStrategy({ llmCall });
      const result = await strategy.resolveGap(makeGap(), [], 0.6);

      expect(result.type).toBe("needs-clarification");
      if (result.type === "needs-clarification") {
        expect(result.clarification.question).toBe("Which auth file?");
        expect(result.clarification.options).toHaveLength(2);
      }
    });

    it("falls back to heuristic on LLM error", async () => {
      const llmCall = vi.fn().mockRejectedValue(new Error("rate limited"));
      const strategy = new LlmStrategy({ llmCall });
      const result = await strategy.resolveGap(makeGap(), [makeContext()], 0.6);

      expect(["filled", "assumed", "needs-clarification"]).toContain(result.type);
    });
  });

  describe("compose", () => {
    it("returns LLM-composed enriched prompt", async () => {
      const composed = "The user wants to fix an authentication bug in the JWT middleware. Context: they've been working on the login flow and recently modified src/auth/middleware.ts.";
      const llmCall = vi.fn().mockResolvedValue(composed);

      const strategy = new LlmStrategy({ llmCall });
      const intent = await strategy["fallback"].classifyIntent("fix the auth thing", conversation);
      const result = await strategy.compose(
        "fix the auth thing",
        intent,
        [makeContext()],
        [],
        [],
      );

      expect(result).toBe(composed);
      expect(llmCall).toHaveBeenCalledOnce();
    });

    it("falls back to heuristic on LLM error", async () => {
      const llmCall = vi.fn().mockRejectedValue(new Error("timeout"));
      const strategy = new LlmStrategy({ llmCall });
      const intent = await strategy["fallback"].classifyIntent("fix the auth thing", []);
      const result = await strategy.compose("fix the auth thing", intent, [], [], []);

      expect(result).toContain("[Original]: fix the auth thing");
      expect(result).toContain("[Intent]: fix");
    });

    it("falls back on empty LLM response", async () => {
      const llmCall = vi.fn().mockResolvedValue("   ");
      const strategy = new LlmStrategy({ llmCall });
      const intent = await strategy["fallback"].classifyIntent("fix the auth thing", []);
      const result = await strategy.compose("fix the auth thing", intent, [], [], []);

      expect(result).toContain("[Original]: fix the auth thing");
    });

    it("includes assumptions and resolved gaps in the prompt", async () => {
      const llmCall = vi.fn().mockImplementation((prompt: string) => {
        expect(prompt).toContain("JWT middleware");
        expect(prompt).toContain("Auto-resolved gaps");
        return Promise.resolve("Enriched with context.");
      });

      const strategy = new LlmStrategy({ llmCall });
      const intent = await strategy["fallback"].classifyIntent("fix the auth thing", []);
      const gap = makeGap({
        resolution: { type: "filled", value: "auth/middleware.ts", source: "git" },
      });

      const result = await strategy.compose(
        "fix the auth thing",
        intent,
        [],
        [{ id: "a1", claim: "JWT middleware", basis: "branch name", confidence: 0.7, source: "llm", correctable: true }],
        [gap],
      );

      expect(result).toBe("Enriched with context.");
    });
  });

  describe("constructor options", () => {
    it("uses default maxConversationTurns of 10", async () => {
      const llmCall = vi.fn().mockResolvedValue(
        JSON.stringify({
          action: "explore",
          specificity: "low",
          scope: "local",
          emotionalLoad: "neutral",
          confidence: 0.5,
          rawFragments: [],
          domainHints: [],
        }),
      );

      const longConversation: ConversationTurn[] = Array.from({ length: 20 }, (_, i) => ({
        role: "user" as const,
        content: `message ${i}`,
      }));

      const strategy = new LlmStrategy({ llmCall });
      await strategy.classifyIntent("what is this", longConversation);

      const prompt = llmCall.mock.calls[0][0] as string;
      expect(prompt).not.toContain("message 0");
      expect(prompt).toContain("message 19");
    });

    it("respects custom maxConversationTurns", async () => {
      const llmCall = vi.fn().mockResolvedValue(
        JSON.stringify({
          action: "explore",
          specificity: "low",
          scope: "local",
          emotionalLoad: "neutral",
          confidence: 0.5,
          rawFragments: [],
          domainHints: [],
        }),
      );

      const turns: ConversationTurn[] = Array.from({ length: 10 }, (_, i) => ({
        role: "user" as const,
        content: `turn ${i}`,
      }));

      const strategy = new LlmStrategy({ llmCall, maxConversationTurns: 3 });
      await strategy.classifyIntent("what is this", turns);

      const prompt = llmCall.mock.calls[0][0] as string;
      expect(prompt).not.toContain("turn 0");
      expect(prompt).toContain("turn 9");
    });
  });

  describe("name", () => {
    it("reports strategy name as 'llm'", () => {
      const strategy = new LlmStrategy({ llmCall: vi.fn() });
      expect(strategy.name).toBe("llm");
    });
  });
});
