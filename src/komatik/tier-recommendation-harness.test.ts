import { describe, it, expect } from "vitest";
import {
  runTierRecommendationHarness,
  type HarnessMessage,
  type HarnessVariant,
} from "./tier-recommendation-harness.js";

const WORKLOAD: HarnessMessage[] = [
  // A mix of clearly-simple (budget-suitable) and clearly-complex (premium-suitable) messages
  { text: "Thanks.", domain: "conversation" },
  { text: "Looks good — ship it.", domain: "conversation" },
  { text: "Fix the auth crash in src/auth/login.ts when token is missing.", domain: "debugging" },
  { text: "Refactor the billing proration to support split ledgers with midpoint rounding.", domain: "coding" },
  { text: "Plan the v3 migration timeline for next quarter — phases, owners, risk.", domain: "planning" },
  { text: "Design the new sandbox isolation architecture across all 15 products.", domain: "planning" },
];

const VARIANTS: HarnessVariant[] = [
  { name: "user-pick-budget", strategy: { kind: "user-pick", userPick: "budget" } },
  { name: "user-pick-balanced", strategy: { kind: "user-pick", userPick: "balanced" } },
  { name: "user-pick-premium", strategy: { kind: "user-pick", userPick: "premium" } },
  { name: "slipstream-auto", strategy: { kind: "slipstream-recommended" } },
];

describe("runTierRecommendationHarness", () => {
  it("runs all variants and returns per-variant tier + model histograms", async () => {
    const cmp = await runTierRecommendationHarness({
      workload: WORKLOAD,
      variants: VARIANTS,
      models: undefined as never,         // use defaults
      tierToModel: undefined as never,    // use defaults
    });

    expect(cmp.results).toHaveLength(VARIANTS.length);
    for (const r of cmp.results) {
      expect(r.totalMessages).toBe(WORKLOAD.length);
      expect(r.acceptanceRate).toBeGreaterThanOrEqual(0);
      expect(r.acceptanceRate).toBeLessThanOrEqual(1);
      expect(r.tierHistogram.budget + r.tierHistogram.balanced + r.tierHistogram.premium).toBe(WORKLOAD.length);
    }
  });

  it("fixed user-pick variants only use that tier — histogram has 100% in one bucket", async () => {
    const cmp = await runTierRecommendationHarness({
      workload: WORKLOAD,
      variants: [{ name: "fixed-budget", strategy: { kind: "user-pick", userPick: "budget" } }],
      models: undefined as never,
      tierToModel: undefined as never,
    });
    expect(cmp.results[0]!.tierHistogram).toEqual({
      budget: WORKLOAD.length,
      balanced: 0,
      premium: 0,
    });
  });

  it("slipstream-recommended variant picks a MIX of tiers across a varied workload", async () => {
    const cmp = await runTierRecommendationHarness({
      workload: WORKLOAD,
      variants: [{ name: "slipstream-auto", strategy: { kind: "slipstream-recommended" } }],
      models: undefined as never,
      tierToModel: undefined as never,
    });
    const hist = cmp.results[0]!.tierHistogram;
    const nonZeroBuckets = Object.values(hist).filter((n) => n > 0).length;
    // A workload with thanks + bug fix + planning + design should produce at least
    // two distinct tier picks. (Conversation→budget, Design+Planning→premium.)
    expect(nonZeroBuckets).toBeGreaterThan(1);
  });

  it("identifies winners on acceptance and cost", async () => {
    const cmp = await runTierRecommendationHarness({
      workload: WORKLOAD,
      variants: VARIANTS,
      models: undefined as never,
      tierToModel: undefined as never,
    });
    expect(VARIANTS.map((v) => v.name)).toContain(cmp.winners.byAcceptance);
    expect(VARIANTS.map((v) => v.name)).toContain(cmp.winners.byCost);
  });

  it("is deterministic — same seed produces identical results", async () => {
    const opts = {
      workload: WORKLOAD,
      variants: VARIANTS,
      models: undefined as never,
      tierToModel: undefined as never,
      seed: 999,
    };
    const a = await runTierRecommendationHarness(opts);
    const b = await runTierRecommendationHarness(opts);
    for (let i = 0; i < a.results.length; i++) {
      expect(a.results[i]!.acceptedCount).toBe(b.results[i]!.acceptedCount);
      expect(a.results[i]!.tierHistogram).toEqual(b.results[i]!.tierHistogram);
    }
  });

  it("respects a custom tierToModel mapping (host can plug real Komatik router)", async () => {
    const cmp = await runTierRecommendationHarness({
      workload: [{ text: "Anything.", domain: "coding" }],
      variants: [{ name: "x", strategy: { kind: "user-pick", userPick: "budget" } }],
      models: { "custom-model": { id: "custom-model", costPerKtoken: 0.01, acceptanceByDomain: { coding: 1 } } },
      tierToModel: { pick: () => "custom-model" },
    });
    expect(cmp.results[0]!.modelHistogram).toEqual({ "custom-model": 1 });
    expect(cmp.results[0]!.acceptanceRate).toBe(1);
  });
});
