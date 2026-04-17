import { describe, it, expect } from "vitest";
import { composeForPlatform } from "./platform-composer.js";
import type { ComposeInput } from "./platform-composer.js";
import type { Assumption, ContextLayer, IntentSignal } from "../types.js";

const baseIntent: IntentSignal = {
  action: "fix",
  specificity: "low",
  scope: "local",
  emotionalLoad: "neutral",
  confidence: 0.6,
  rawFragments: [],
  domainHints: ["auth"],
};

const baseContext: ContextLayer[] = [
  {
    source: "komatik-identity",
    priority: 0,
    timestamp: Date.now(),
    data: { profile: { display_name: "David" } },
    summary: "David (developer) — uses marketplace, triage. Onboarding complete.",
  },
  {
    source: "komatik-preferences",
    priority: 0,
    timestamp: Date.now(),
    data: { preferences: { tone: "terse" } },
    summary: "User preferences: Tone: terse. Code style: TypeScript, functional",
  },
  {
    source: "komatik-memory",
    priority: 0,
    timestamp: Date.now(),
    data: { memories: [] },
    summary: "Session memory (2 items): Active work: Refactoring auth middleware",
  },
  {
    source: "conversation",
    priority: 5,
    timestamp: Date.now(),
    data: {},
    summary: "Topic trajectory: login flow → auth middleware",
  },
];

const baseAssumptions: Assumption[] = [
  {
    id: "a-1",
    claim: "Referring to src/auth/middleware.ts",
    basis: "Based on conversation and git context",
    confidence: 0.7,
    source: "default-strategy",
    correctable: true,
  },
];

function makeInput(overrides: Partial<ComposeInput> = {}): ComposeInput {
  return {
    message: "fix the auth thing",
    intent: baseIntent,
    context: baseContext,
    assumptions: baseAssumptions,
    resolvedGaps: [],
    platform: "generic",
    ...overrides,
  };
}

describe("composeForPlatform", () => {
  describe("generic", () => {
    it("produces labeled text blocks", () => {
      const result = composeForPlatform(makeInput({ platform: "generic" }));
      expect(result).toContain("[Original]: fix the auth thing");
      expect(result).toContain("[Intent]: fix");
      expect(result).toContain("[Domain]: auth");
      expect(result).toContain("[Context]:");
      expect(result).toContain("komatik-identity:");
      expect(result).toContain("[Assumptions]:");
    });
  });

  describe("cursor", () => {
    it("uses XML tags for structured context", () => {
      const result = composeForPlatform(makeInput({ platform: "cursor" }));
      expect(result).toContain("<user_request>");
      expect(result).toContain("</user_request>");
      expect(result).toContain("<domain>auth</domain>");
      expect(result).toContain("<user_preferences>");
      expect(result).toContain("<session_memory>");
      expect(result).toContain("<context>");
      expect(result).toContain("<assumptions>");
    });

    it("separates preferences and memory from general context", () => {
      const result = composeForPlatform(makeInput({ platform: "cursor" }));
      const contextBlock = result.match(/<context>([\s\S]*?)<\/context>/)?.[1] ?? "";
      expect(contextBlock).not.toContain("komatik-preferences");
      expect(contextBlock).not.toContain("komatik-memory");
      expect(contextBlock).toContain("komatik-identity");
      expect(contextBlock).toContain("conversation");
    });
  });

  describe("claude", () => {
    it("uses semantic XML blocks with user profile grouping", () => {
      const result = composeForPlatform(makeInput({ platform: "claude" }));
      expect(result).toContain("<request>");
      expect(result).toContain("<intent ");
      expect(result).toContain("<user_profile>");
      expect(result).toContain("<memory>");
      expect(result).toContain("<assumptions>");
    });

    it("groups identity and preferences into user_profile", () => {
      const result = composeForPlatform(makeInput({ platform: "claude" }));
      const profileBlock = result.match(/<user_profile>([\s\S]*?)<\/user_profile>/)?.[1] ?? "";
      expect(profileBlock).toContain("David");
      expect(profileBlock).toContain("Tone: terse");
    });
  });

  describe("api", () => {
    it("returns valid JSON with structured data", () => {
      const result = composeForPlatform(makeInput({ platform: "api" }));
      const parsed = JSON.parse(result);
      expect(parsed.original).toBe("fix the auth thing");
      expect(parsed.intent.action).toBe("fix");
      expect(parsed.intent.domains).toContain("auth");
      expect(parsed.context).toHaveLength(4);
      expect(parsed.assumptions).toHaveLength(1);
      expect(parsed.assumptions[0].claim).toContain("middleware.ts");
    });
  });

  describe("mcp", () => {
    it("uses compact text with separator", () => {
      const result = composeForPlatform(makeInput({ platform: "mcp" }));
      expect(result).toMatch(/^fix the auth thing/);
      expect(result).toContain("---");
      expect(result).toContain("Undercurrent Context:");
      expect(result).toContain("[komatik-identity]");
      expect(result).toContain("Assumptions:");
    });
  });

  describe("chatgpt", () => {
    it("uses markdown formatting", () => {
      const result = composeForPlatform(makeInput({ platform: "chatgpt" }));
      expect(result).toContain("**Request**: fix the auth thing");
      expect(result).toContain("**Domain**: auth");
      expect(result).toContain("**Intent**: fix");
      expect(result).toContain("**Context**:");
      expect(result).toContain("**Assumptions made**:");
    });
  });

  it("handles empty context gracefully for all platforms", () => {
    const platforms = ["cursor", "claude", "api", "mcp", "chatgpt", "generic"] as const;
    for (const platform of platforms) {
      const result = composeForPlatform(makeInput({ platform, context: [], assumptions: [] }));
      expect(result).toBeTruthy();
      expect(result).toContain("fix the auth thing");
    }
  });
});
