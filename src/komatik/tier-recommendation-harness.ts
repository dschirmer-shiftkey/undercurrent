import { Slipstream } from "../index.js";
import { ConversationAdapter } from "../adapters/conversation.js";
import { DefaultStrategy } from "../strategies/default.js";
import type { ConversationTurn, CostTier } from "../types.js";

/**
 * Methodology harness for the **actual** IDE-shaped A/B:
 * "user-picked tier" vs "Slipstream's tierRecommendation",
 * with the host's tier→model mapping held constant.
 *
 * Replaces the earlier (unmerged) `acceptance-harness.ts` design, which
 * incorrectly compared Slipstream picking models vs. fixed tiers. For the
 * Komatik IDE, Slipstream does NOT pick models — the host's
 * `getModelConfigForPhase(phase, tier)` does. Slipstream contributes the
 * *tier choice* via `metadata.tierRecommendation`. This harness models that
 * contract: every variant calls `slipstream.enrich()` then maps the chosen
 * tier through a constant `tierToModel` function before scoring.
 *
 * Honest framing: the per-(model, domain) acceptance probabilities and the
 * tier→model mapping are still simulated. The harness is a *methodology* —
 * re-run it against real production acceptance data and the real Komatik
 * `getModelConfigForPhase` to draw a real conclusion. What it proves today
 * is the wiring and the comparison shape, not which strategy wins.
 */

export interface HarnessMessage {
  text: string;
  /** Ground-truth domain label used for the simulated acceptance roll. */
  domain: string;
  conversation?: ConversationTurn[];
}

export type VariantStrategy =
  | { kind: "fixed"; tier: CostTier }
  | { kind: "slipstream-recommended" }
  | { kind: "user-pick"; userPick: CostTier; respectUncertainEscalation?: boolean };

export interface HarnessVariant {
  /** Display name ("user-picked-balanced", "slipstream-auto", ...). */
  name: string;
  strategy: VariantStrategy;
}

export interface SimulatedModel {
  id: string;
  /** Cost per 1k tokens (input + output combined for simplicity). */
  costPerKtoken: number;
  /** Simulated acceptance probability per task domain. Defaults to 0.8. */
  acceptanceByDomain?: Partial<Record<string, number>>;
}

export interface TierToModelMap {
  /** Returns the model id the host's router would pick for this tier+domain. */
  pick(tier: CostTier, domain: string): string;
}

export interface HarnessOptions {
  workload: HarnessMessage[];
  variants: HarnessVariant[];
  models: Record<string, SimulatedModel>;
  /** Maps (tier, domain) → modelId — the *constant* part of the experiment. */
  tierToModel: TierToModelMap;
  /** Deterministic seed for acceptance rolls. Default 42. */
  seed?: number;
}

export interface HarnessRunResult {
  variant: HarnessVariant;
  totalMessages: number;
  acceptedCount: number;
  acceptanceRate: number;
  totalCost: number;
  /** Per-tier message count, surfaces "how often does Slipstream pick premium?" */
  tierHistogram: Record<CostTier, number>;
  /** Per-model message count. */
  modelHistogram: Record<string, number>;
}

export interface HarnessComparison {
  results: HarnessRunResult[];
  winners: {
    byAcceptance: string;
    byCost: string;
  };
  spreads: {
    acceptance: number;
    cost: number;
  };
}

// ─── Default tier→model mapping that mirrors Komatik's router shape ──────
//
// Komatik picks the cheapest model within a tier's cost ceiling that meets
// the quality floor. This default mirrors the same shape: each tier has a
// preferred model per domain, picked from the real Komatik registry names.
// Real harness runs should replace this with a wrapper around the actual
// `getModelConfigForPhase` from `platform/web/lib/llm/modelRouter.ts`.

const DEFAULT_TIER_TO_MODEL: TierToModelMap = {
  pick(tier: CostTier, _domain: string): string {
    if (tier === "budget") return "claude-haiku-4-5";
    if (tier === "premium") return "claude-opus-4-6";
    return "claude-sonnet-4-6";
  },
};

const DEFAULT_MODELS: Record<string, SimulatedModel> = {
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    costPerKtoken: 0.001,
    acceptanceByDomain: { coding: 0.7, debugging: 0.68, creative: 0.65, analysis: 0.72, planning: 0.6, conversation: 0.82 },
  },
  "claude-sonnet-4-6": {
    id: "claude-sonnet-4-6",
    costPerKtoken: 0.003,
    acceptanceByDomain: { coding: 0.88, debugging: 0.86, creative: 0.78, analysis: 0.84, planning: 0.85, conversation: 0.83 },
  },
  "claude-opus-4-6": {
    id: "claude-opus-4-6",
    costPerKtoken: 0.005,
    acceptanceByDomain: { coding: 0.94, debugging: 0.92, creative: 0.9, analysis: 0.93, planning: 0.95, conversation: 0.88 },
  },
};

// Mulberry32 PRNG so seed produces identical results across runs.
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSlipstream(): Slipstream {
  return new Slipstream({
    adapters: [new ConversationAdapter()],
    strategy: new DefaultStrategy(),
    targetPlatform: "api",
  });
}

async function resolveTier(
  strategy: VariantStrategy,
  slip: Slipstream,
  msg: HarnessMessage,
): Promise<{ tier: CostTier; reasoning: string }> {
  if (strategy.kind === "fixed") {
    return { tier: strategy.tier, reasoning: `fixed=${strategy.tier}` };
  }
  if (strategy.kind === "user-pick") {
    return { tier: strategy.userPick, reasoning: `user-pick=${strategy.userPick}` };
  }
  // slipstream-recommended
  const enriched = await slip.enrich({
    message: msg.text,
    conversation: msg.conversation ?? [],
    targetPlatform: "api",
  });
  const rec = enriched.metadata.tierRecommendation;
  // Defensive fallback if recommendation missing (shouldn't happen post-fix).
  return {
    tier: rec?.tier ?? "balanced",
    reasoning: rec?.reasoning ?? "fallback=balanced",
  };
}

function rollVerdict(
  rng: () => number,
  domain: string,
  modelId: string,
  models: Record<string, SimulatedModel>,
): boolean {
  const model = models[modelId];
  if (!model) return rng() < 0.8;
  const prob = model.acceptanceByDomain?.[domain] ?? 0.8;
  return rng() < prob;
}

function costForCall(modelId: string, models: Record<string, SimulatedModel>, tokens: number): number {
  const model = models[modelId];
  if (!model) return 0;
  return (tokens / 1000) * model.costPerKtoken;
}

async function runOneVariant(
  variant: HarnessVariant,
  workload: HarnessMessage[],
  models: Record<string, SimulatedModel>,
  tierToModel: TierToModelMap,
  rng: () => number,
): Promise<HarnessRunResult> {
  const slip = buildSlipstream();
  const tierHistogram: Record<CostTier, number> = { budget: 0, balanced: 0, premium: 0 };
  const modelHistogram: Record<string, number> = {};
  let acceptedCount = 0;
  let totalCost = 0;
  const tokensPerCall = 1500;

  for (const msg of workload) {
    const { tier } = await resolveTier(variant.strategy, slip, msg);
    tierHistogram[tier]++;
    const modelId = tierToModel.pick(tier, msg.domain);
    modelHistogram[modelId] = (modelHistogram[modelId] ?? 0) + 1;
    if (rollVerdict(rng, msg.domain, modelId, models)) acceptedCount++;
    totalCost += costForCall(modelId, models, tokensPerCall);
  }

  const total = workload.length;
  return {
    variant,
    totalMessages: total,
    acceptedCount,
    acceptanceRate: acceptedCount / total,
    totalCost,
    tierHistogram,
    modelHistogram,
  };
}

function pickWinner(
  results: HarnessRunResult[],
  selector: (r: HarnessRunResult) => number,
  preferLow: boolean,
): string {
  let best = results[0]!;
  for (const r of results) {
    const a = selector(r);
    const b = selector(best);
    if ((preferLow && a < b) || (!preferLow && a > b)) best = r;
  }
  return best.variant.name;
}

function spread(results: HarnessRunResult[], selector: (r: HarnessRunResult) => number): number {
  const values = results.map(selector);
  return Math.max(...values) - Math.min(...values);
}

export async function runTierRecommendationHarness(
  options: HarnessOptions,
): Promise<HarnessComparison> {
  const seed = options.seed ?? 42;
  const models = options.models ?? DEFAULT_MODELS;
  const tierToModel = options.tierToModel ?? DEFAULT_TIER_TO_MODEL;

  const results: HarnessRunResult[] = [];
  for (const variant of options.variants) {
    const rng = makeRng(seed);
    results.push(await runOneVariant(variant, options.workload, models, tierToModel, rng));
  }

  return {
    results,
    winners: {
      byAcceptance: pickWinner(results, (r) => r.acceptanceRate, false),
      byCost: pickWinner(results, (r) => r.totalCost, true),
    },
    spreads: {
      acceptance: spread(results, (r) => r.acceptanceRate),
      cost: spread(results, (r) => r.totalCost),
    },
  };
}

export const DEFAULT_HARNESS_MODELS = DEFAULT_MODELS;
export const DEFAULT_HARNESS_TIER_MAP = DEFAULT_TIER_TO_MODEL;
