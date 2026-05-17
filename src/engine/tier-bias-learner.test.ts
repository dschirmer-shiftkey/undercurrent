import { describe, it, expect } from "vitest";
import { SessionTierBiasLearner } from "./tier-bias-learner.js";
import { recommendTier } from "./pipeline.js";
import type { IntentSignal, TierRecommendation } from "../types.js";

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

function baseRecommendation(): TierRecommendation {
  // Heuristic-picked balanced (mid-range default)
  return recommendTier(intent(), "standard");
}

describe("SessionTierBiasLearner — cold start (no outcomes yet)", () => {
  it("returns the base recommendation unchanged when no data exists", () => {
    const learner = new SessionTierBiasLearner();
    const base = baseRecommendation();
    const adjusted = learner.adjust(base, { userId: "u-1" });
    expect(adjusted).toBe(base);
    expect(adjusted.biasAdjustment).toBeUndefined();
  });

  it("returns base unchanged when fewer than warmThreshold outcomes are recorded", () => {
    const learner = new SessionTierBiasLearner({ warmThreshold: 5 });
    for (let i = 0; i < 4; i++) {
      learner.recordOutcome({ tier: "balanced", accepted: false, userId: "u-1" });
    }
    const base = baseRecommendation();
    const adjusted = learner.adjust(base, { userId: "u-1" });
    expect(adjusted).toBe(base);
  });
});

describe("SessionTierBiasLearner — warm-up adjustments", () => {
  it("FLIPS the tier when the base has consistently low acceptance and an alternative has high acceptance", () => {
    const learner = new SessionTierBiasLearner({
      warmThreshold: 5,
      lowAcceptanceThreshold: 0.3,
      highAcceptanceThreshold: 0.7,
    });
    // Base = balanced has been rejected 4/5 times for this user
    for (let i = 0; i < 4; i++) {
      learner.recordOutcome({ tier: "balanced", accepted: false, userId: "u-1" });
    }
    learner.recordOutcome({ tier: "balanced", accepted: true, userId: "u-1" });
    // Premium has been accepted 5/5 times
    for (let i = 0; i < 5; i++) {
      learner.recordOutcome({ tier: "premium", accepted: true, userId: "u-1" });
    }

    const base = baseRecommendation();
    expect(base.tier).toBe("balanced");

    const adjusted = learner.adjust(base, { userId: "u-1" });
    expect(adjusted.tier).toBe("premium");
    expect(adjusted.biasAdjustment).toBeDefined();
    expect(adjusted.biasAdjustment!.appliedReason).toBe("low-acceptance-flip");
    expect(adjusted.biasAdjustment!.originalTier).toBe("balanced");
    expect(adjusted.reasoning).toMatch(/Bias-adjusted/);
  });

  it("SOFTENS confidence (mid-range acceptance) without flipping the tier", () => {
    const learner = new SessionTierBiasLearner({
      warmThreshold: 5,
      midRangeConfidencePenalty: 0.5,
    });
    // Balanced has mid-range acceptance: 3 out of 5
    learner.recordOutcome({ tier: "balanced", accepted: true, userId: "u-1" });
    learner.recordOutcome({ tier: "balanced", accepted: true, userId: "u-1" });
    learner.recordOutcome({ tier: "balanced", accepted: true, userId: "u-1" });
    learner.recordOutcome({ tier: "balanced", accepted: false, userId: "u-1" });
    learner.recordOutcome({ tier: "balanced", accepted: false, userId: "u-1" });

    const base = baseRecommendation();
    const adjusted = learner.adjust(base, { userId: "u-1" });
    expect(adjusted.tier).toBe(base.tier);
    expect(adjusted.confidence).toBeCloseTo(base.confidence * 0.5, 5);
    expect(adjusted.biasAdjustment!.appliedReason).toBe("mid-range-confidence-penalty");
  });

  it("BOOSTS confidence when observed acceptance is high", () => {
    const learner = new SessionTierBiasLearner({ warmThreshold: 5 });
    for (let i = 0; i < 5; i++) {
      learner.recordOutcome({ tier: "balanced", accepted: true, userId: "u-1" });
    }
    const base = baseRecommendation();
    const adjusted = learner.adjust(base, { userId: "u-1" });
    expect(adjusted.tier).toBe(base.tier);
    expect(adjusted.confidence).toBeGreaterThan(base.confidence);
    expect(adjusted.biasAdjustment!.appliedReason).toBe("high-acceptance-boost");
  });
});

describe("SessionTierBiasLearner — scoping", () => {
  it("keeps per-user stats separate by default", () => {
    const learner = new SessionTierBiasLearner({ warmThreshold: 5 });
    for (let i = 0; i < 5; i++) {
      learner.recordOutcome({ tier: "balanced", accepted: false, userId: "u-1" });
    }
    for (let i = 0; i < 5; i++) {
      learner.recordOutcome({ tier: "premium", accepted: true, userId: "u-1" });
    }
    // User u-2 has no history yet.
    const base = baseRecommendation();
    expect(learner.adjust(base, { userId: "u-1" }).tier).toBe("premium");
    expect(learner.adjust(base, { userId: "u-2" }).tier).toBe(base.tier);
  });

  it("uses global scope when perUserScoping is false", () => {
    const learner = new SessionTierBiasLearner({ warmThreshold: 5, perUserScoping: false });
    for (let i = 0; i < 5; i++) {
      learner.recordOutcome({ tier: "balanced", accepted: false, userId: "u-1" });
    }
    for (let i = 0; i < 5; i++) {
      learner.recordOutcome({ tier: "premium", accepted: true, userId: "u-1" });
    }
    const base = baseRecommendation();
    // u-2 inherits global stats
    expect(learner.adjust(base, { userId: "u-2" }).tier).toBe("premium");
  });
});

describe("SessionTierBiasLearner — getStats", () => {
  it("returns warm=false until any tier reaches the threshold", () => {
    const learner = new SessionTierBiasLearner({ warmThreshold: 5 });
    for (let i = 0; i < 4; i++) {
      learner.recordOutcome({ tier: "balanced", accepted: true, userId: "u-1" });
    }
    expect(learner.getStats({ userId: "u-1" }).warm).toBe(false);
    learner.recordOutcome({ tier: "balanced", accepted: true, userId: "u-1" });
    expect(learner.getStats({ userId: "u-1" }).warm).toBe(true);
  });

  it("reports per-tier counts and rates accurately", () => {
    const learner = new SessionTierBiasLearner();
    learner.recordOutcome({ tier: "budget", accepted: true, userId: "u-1" });
    learner.recordOutcome({ tier: "budget", accepted: true, userId: "u-1" });
    learner.recordOutcome({ tier: "budget", accepted: false, userId: "u-1" });
    learner.recordOutcome({ tier: "premium", accepted: true, userId: "u-1" });

    const stats = learner.getStats({ userId: "u-1" });
    expect(stats.counts.budget).toEqual({ accepted: 2, total: 3 });
    expect(stats.counts.premium).toEqual({ accepted: 1, total: 1 });
    expect(stats.counts.balanced).toEqual({ accepted: 0, total: 0 });
    expect(stats.rates.budget).toBeCloseTo(2 / 3, 5);
    expect(stats.rates.premium).toBe(1);
    expect(stats.rates.balanced).toBe(0);
    expect(stats.total).toBe(4);
  });
});

describe("SessionTierBiasLearner — edge cases", () => {
  it("low acceptance with no high-acceptance alternative → keeps tier, softens confidence", () => {
    const learner = new SessionTierBiasLearner({
      warmThreshold: 5,
      lowAcceptanceThreshold: 0.3,
      highAcceptanceThreshold: 0.7,
    });
    // Balanced has low acceptance; budget exists but mid-range; premium has no data.
    for (let i = 0; i < 5; i++) {
      learner.recordOutcome({ tier: "balanced", accepted: false, userId: "u-1" });
    }
    for (let i = 0; i < 5; i++) {
      learner.recordOutcome({ tier: "budget", accepted: i < 2, userId: "u-1" });
    }

    const base = baseRecommendation();
    const adjusted = learner.adjust(base, { userId: "u-1" });
    // No tier has data with rate > highAcceptanceThreshold (0.7); falls through to mid-range path.
    expect(adjusted.tier).toBe("balanced");
    expect(adjusted.biasAdjustment!.appliedReason).toBe("mid-range-confidence-penalty");
  });
});
