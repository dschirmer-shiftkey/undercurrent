import { describe, it, expect } from "vitest";
import { Slipstream } from "../index.js";
import { ConversationAdapter } from "../adapters/conversation.js";
import { DefaultStrategy } from "../strategies/default.js";
import { SessionTierBiasLearner } from "./tier-bias-learner.js";

function makeSlipstream(learner?: SessionTierBiasLearner) {
  return new Slipstream({
    adapters: [new ConversationAdapter()],
    strategy: new DefaultStrategy(),
    targetPlatform: "api",
    tierBiasLearner: learner,
  });
}

describe("TierBiasLearner ↔ Slipstream.enrich() integration", () => {
  it("when no learner is configured, metadata.tierRecommendation has no biasAdjustment", async () => {
    const slip = makeSlipstream();
    const result = await slip.enrich({
      message: "fix the auth crash in src/auth/login.ts",
      conversation: [],
    });
    expect(result.metadata.tierRecommendation).toBeDefined();
    expect(result.metadata.tierRecommendation!.biasAdjustment).toBeUndefined();
  });

  it("when learner has no data yet, recommendation is the pure heuristic", async () => {
    const learner = new SessionTierBiasLearner();
    const slip = makeSlipstream(learner);
    const result = await slip.enrich({
      message: "fix the auth crash in src/auth/login.ts",
      conversation: [],
    });
    expect(result.metadata.tierRecommendation!.biasAdjustment).toBeUndefined();
  });

  it("after enough outcomes are recorded, enrich() returns bias-adjusted recommendation", async () => {
    const learner = new SessionTierBiasLearner({ warmThreshold: 5 });
    const slip = makeSlipstream(learner);
    const userId = "u-test";

    // First call: cold start, capture the heuristic's tier so we can test
    // the learner adjusted it (regardless of whether heuristic picks
    // balanced, premium, or budget for this particular message).
    const cold = await slip.enrich({
      message: "add a new field to the user model",
      conversation: [],
      enrichmentContext: { userId },
    });
    const heuristicTier = cold.metadata.tierRecommendation!.tier;

    // Simulate: user has been rejecting the heuristic's tier and accepting
    // a different one consistently.
    const flipTarget = heuristicTier === "premium" ? "budget" : "premium";
    for (let i = 0; i < 5; i++) {
      slip.recordTierOutcome({ tier: heuristicTier, accepted: false, userId });
    }
    for (let i = 0; i < 5; i++) {
      slip.recordTierOutcome({ tier: flipTarget, accepted: true, userId });
    }

    // Re-enrich the same message; the learner should flip from heuristicTier to flipTarget.
    const warm = await slip.enrich({
      message: "add a new field to the user model",
      conversation: [],
      enrichmentContext: { userId },
    });
    const rec = warm.metadata.tierRecommendation!;
    expect(rec.biasAdjustment).toBeDefined();
    expect(rec.biasAdjustment!.appliedReason).toBe("low-acceptance-flip");
    expect(rec.tier).toBe(flipTarget);
    expect(rec.biasAdjustment!.originalTier).toBe(heuristicTier);
  });

  it("recordTierOutcome through Slipstream is a no-op when no learner is configured", () => {
    const slip = makeSlipstream(); // no learner
    // Should not throw — silent no-op
    expect(() =>
      slip.recordTierOutcome({ tier: "balanced", accepted: true, userId: "u-1" }),
    ).not.toThrow();
  });

  it("learner adjustment scoped per user via enrichmentContext.userId", async () => {
    const learner = new SessionTierBiasLearner({ warmThreshold: 5 });
    const slip = makeSlipstream(learner);

    // u-1 hates balanced
    for (let i = 0; i < 5; i++) {
      slip.recordTierOutcome({ tier: "balanced", accepted: false, userId: "u-1" });
    }
    for (let i = 0; i < 5; i++) {
      slip.recordTierOutcome({ tier: "premium", accepted: true, userId: "u-1" });
    }

    const resultU1 = await slip.enrich({
      message: "refactor billing",
      conversation: [],
      enrichmentContext: { userId: "u-1" },
    });
    const resultU2 = await slip.enrich({
      message: "refactor billing",
      conversation: [],
      enrichmentContext: { userId: "u-2" },
    });

    expect(resultU1.metadata.tierRecommendation!.biasAdjustment).toBeDefined();
    expect(resultU2.metadata.tierRecommendation!.biasAdjustment).toBeUndefined();
  });
});
