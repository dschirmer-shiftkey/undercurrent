import { describe, expect, it } from "vitest";
import { recommendTier } from "./pipeline.js";
import type { IntentSignal } from "../types.js";

function intent(overrides: Partial<IntentSignal> = {}): IntentSignal {
  return {
    action: "build",
    specificity: "medium",
    scope: "local",
    emotionalLoad: "neutral",
    confidence: 0.8,
    rawFragments: [],
    domainHints: [],
    ...overrides,
  };
}

describe("recommendTier", () => {
  describe("budget tier", () => {
    it("returns budget for depth=none (passthrough)", () => {
      const r = recommendTier(intent({ action: "acknowledge" }), "none");
      expect(r.tier).toBe("budget");
      expect(r.reasoning).toMatch(/passthrough|cheap/i);
    });

    it("returns budget for acknowledge / report actions", () => {
      expect(recommendTier(intent({ action: "acknowledge" }), "light").tier).toBe("budget");
      expect(recommendTier(intent({ action: "report" }), "standard").tier).toBe("budget");
    });

    it("returns budget for high-specificity narrow-scope bug fixes", () => {
      const r = recommendTier(
        intent({ action: "fix", specificity: "high", scope: "atomic" }),
        "standard",
      );
      expect(r.tier).toBe("budget");
      expect(r.reasoning).toMatch(/well-specified/i);
    });
  });

  describe("premium tier", () => {
    it("returns premium for deep enrichment", () => {
      const r = recommendTier(intent(), "deep");
      expect(r.tier).toBe("premium");
    });

    it("returns premium for low-specificity messages", () => {
      const r = recommendTier(intent({ specificity: "low" }), "standard");
      expect(r.tier).toBe("premium");
    });

    it("returns premium for cross-system scope", () => {
      const r = recommendTier(intent({ scope: "cross-system" }), "standard");
      expect(r.tier).toBe("premium");
    });

    it("returns premium for design / decide actions", () => {
      expect(recommendTier(intent({ action: "design" }), "standard").tier).toBe("premium");
      expect(recommendTier(intent({ action: "decide" }), "standard").tier).toBe("premium");
    });
  });

  describe("balanced tier (default)", () => {
    it("returns balanced for medium specificity + local scope + build", () => {
      const r = recommendTier(intent(), "standard");
      expect(r.tier).toBe("balanced");
      expect(r.reasoning).toMatch(/default/i);
    });
  });

  describe("emotional load escalation", () => {
    it("bumps budget → balanced when user is frustrated", () => {
      const r = recommendTier(
        intent({ action: "fix", specificity: "high", scope: "atomic", emotionalLoad: "frustrated" }),
        "standard",
      );
      expect(r.tier).toBe("balanced");
      expect(r.reasoning).toMatch(/escalated|frustrated/i);
    });

    it("bumps balanced → premium when user is uncertain", () => {
      const r = recommendTier(intent({ emotionalLoad: "uncertain" }), "standard");
      expect(r.tier).toBe("premium");
    });

    it("does not bump past premium", () => {
      const r = recommendTier(
        intent({ specificity: "low", emotionalLoad: "frustrated" }),
        "deep",
      );
      expect(r.tier).toBe("premium");
    });
  });

  describe("low-confidence flagging", () => {
    it("notes that the host should prefer user pick when intent confidence is low", () => {
      const r = recommendTier(intent({ confidence: 0.3 }), "standard");
      expect(r.reasoning).toMatch(/user pick/i);
      expect(r.confidence).toBeGreaterThanOrEqual(0.3);
    });

    it("preserves high confidence as-is", () => {
      const r = recommendTier(intent({ confidence: 0.9 }), "standard");
      expect(r.confidence).toBe(0.9);
      expect(r.reasoning).not.toMatch(/user pick/i);
    });
  });

  describe("signals payload", () => {
    it("returns the raw signals that drove the recommendation (for telemetry)", () => {
      const r = recommendTier(
        intent({ action: "design", specificity: "low", scope: "product", emotionalLoad: "uncertain" }),
        "deep",
      );
      expect(r.signals).toEqual({
        action: "design",
        specificity: "low",
        scope: "product",
        emotionalLoad: "uncertain",
        enrichmentDepth: "deep",
      });
    });
  });
});
