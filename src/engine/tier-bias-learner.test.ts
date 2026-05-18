import { describe, it, expect } from "vitest";
import {
  REACTION_WEIGHTS,
  SessionTierBiasLearner,
  resolveOutcomeWeight,
} from "./tier-bias-learner.js";
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

describe("SessionTierBiasLearner — graded reactions (v2.5)", () => {
  it("REACTION_WEIGHTS preserves binary semantics at the endpoints", () => {
    expect(REACTION_WEIGHTS.perfect).toBe(1.0);
    expect(REACTION_WEIGHTS.bad).toBe(0.0);
    expect(REACTION_WEIGHTS.okay).toBeGreaterThan(0.5);
    expect(REACTION_WEIGHTS.okay).toBeLessThan(1.0);
    expect(REACTION_WEIGHTS.confusing).toBeGreaterThan(0.0);
    expect(REACTION_WEIGHTS.confusing).toBeLessThan(0.5);
  });

  it("resolveOutcomeWeight prefers reaction over accepted when both are present", () => {
    expect(resolveOutcomeWeight({ tier: "balanced", reaction: "perfect", accepted: false })).toBe(1.0);
    expect(resolveOutcomeWeight({ tier: "balanced", reaction: "bad", accepted: true })).toBe(0.0);
  });

  it("resolveOutcomeWeight returns null when neither reaction nor accepted is set", () => {
    expect(resolveOutcomeWeight({ tier: "balanced" })).toBeNull();
  });

  it("silently drops outcomes that have neither reaction nor accepted", () => {
    const learner = new SessionTierBiasLearner();
    learner.recordOutcome({ tier: "balanced", userId: "u-1" });
    expect(learner.getStats({ userId: "u-1" }).total).toBe(0);
  });

  it("`perfect` reaction behaves identically to accepted=true for binary stats", () => {
    const a = new SessionTierBiasLearner({ warmThreshold: 5 });
    const b = new SessionTierBiasLearner({ warmThreshold: 5 });
    for (let i = 0; i < 5; i++) a.recordOutcome({ tier: "balanced", reaction: "perfect", userId: "u-1" });
    for (let i = 0; i < 5; i++) b.recordOutcome({ tier: "balanced", accepted: true, userId: "u-1" });
    const base = baseRecommendation();
    expect(a.adjust(base, { userId: "u-1" })).toEqual(b.adjust(base, { userId: "u-1" }));
  });

  it("mix of `okay` reactions yields a fractional acceptance rate (not 0 or 1)", () => {
    const learner = new SessionTierBiasLearner({ warmThreshold: 5 });
    for (let i = 0; i < 5; i++) learner.recordOutcome({ tier: "balanced", reaction: "okay", userId: "u-1" });
    const stats = learner.getStats({ userId: "u-1" });
    expect(stats.rates.balanced).toBeCloseTo(REACTION_WEIGHTS.okay, 5);
    expect(stats.rates.balanced).not.toBe(1.0);
    expect(stats.rates.balanced).not.toBe(0.0);
  });

  it("five `confusing` reactions trigger a flip when an alternative has high acceptance", () => {
    const learner = new SessionTierBiasLearner({
      warmThreshold: 5,
      lowAcceptanceThreshold: 0.4,
      highAcceptanceThreshold: 0.7,
    });
    // Balanced gets all "confusing" → rate ≈ 0.33 < 0.4 (low)
    for (let i = 0; i < 5; i++) learner.recordOutcome({ tier: "balanced", reaction: "confusing", userId: "u-1" });
    // Premium gets all "perfect" → rate = 1.0 > 0.7 (high)
    for (let i = 0; i < 5; i++) learner.recordOutcome({ tier: "premium", reaction: "perfect", userId: "u-1" });

    const base = baseRecommendation();
    const adjusted = learner.adjust(base, { userId: "u-1" });
    expect(adjusted.tier).toBe("premium");
    expect(adjusted.biasAdjustment!.appliedReason).toBe("low-acceptance-flip");
  });

  it("mixed reactions average correctly: 1*perfect + 1*okay + 1*confusing + 1*bad + 1*perfect", () => {
    const learner = new SessionTierBiasLearner({ warmThreshold: 5 });
    learner.recordOutcome({ tier: "balanced", reaction: "perfect", userId: "u-1" });
    learner.recordOutcome({ tier: "balanced", reaction: "okay", userId: "u-1" });
    learner.recordOutcome({ tier: "balanced", reaction: "confusing", userId: "u-1" });
    learner.recordOutcome({ tier: "balanced", reaction: "bad", userId: "u-1" });
    learner.recordOutcome({ tier: "balanced", reaction: "perfect", userId: "u-1" });
    const expected = (1.0 + REACTION_WEIGHTS.okay + REACTION_WEIGHTS.confusing + 0.0 + 1.0) / 5;
    expect(learner.getStats({ userId: "u-1" }).rates.balanced).toBeCloseTo(expected, 5);
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
