import type { CostTier, TierRecommendation } from "../types.js";

/**
 * Cold-start learning for `tierRecommendation`. The base `recommendTier()`
 * helper is a pure intent-driven heuristic — same input always produces
 * the same output. That's the right default but ignores per-user signal:
 * users vary in what they accept at each tier, and the recommendation
 * should learn from that.
 *
 * A `TierBiasLearner` observes accept/reject outcomes per tier and, when
 * the data warrants, **adjusts** the base recommendation. Default policy
 * is conservative:
 *   - Below the warm threshold (default 5 outcomes/tier), no adjustment
 *   - Confidence is reduced when observed acceptance for the recommended
 *     tier is low
 *   - The tier itself is only flipped when the base recommendation has
 *     consistently low acceptance (<30%) AND another tier has consistently
 *     high acceptance (>70%)
 *
 * The default implementation `SessionTierBiasLearner` is in-memory and
 * per-instance. For cross-session learning, the host can implement the
 * interface against a persistence layer (e.g., `enrichment_outcomes`),
 * but the current Komatik schema doesn't store `tier` so cross-session
 * persistence is a follow-up that requires a Supabase column add.
 */

export interface TierBiasContext {
  userId?: string;
  domain?: string;
}

export interface TierOutcomeInput {
  /** The tier that was actually used for this request (may differ from the recommended one). */
  tier: CostTier;
  /** Whether the user accepted the result. */
  accepted: boolean;
  /** Optional scoping — when present, the learner can keep per-user / per-domain stats. */
  userId?: string;
  domain?: string;
}

export interface TierBiasStats {
  /** Per-tier observed counts. */
  counts: Record<CostTier, { accepted: number; total: number }>;
  /** Per-tier acceptance rate, 0 when no data. */
  rates: Record<CostTier, number>;
  /** Total outcomes recorded across all tiers. */
  total: number;
  /** True when enough data has accumulated to apply non-trivial adjustment. */
  warm: boolean;
}

export interface TierBiasLearner {
  /**
   * Adjust a base recommendation given current observations. Must be a
   * pure function — no I/O. Called per-enrichment.
   */
  adjust(base: TierRecommendation, ctx: TierBiasContext): TierRecommendation;
  /** Record an outcome to update internal acceptance stats. */
  recordOutcome(input: TierOutcomeInput): void;
  /** Snapshot of current stats (telemetry / tests). */
  getStats(ctx?: TierBiasContext): TierBiasStats;
}

const TIERS: CostTier[] = ["budget", "balanced", "premium"];

function emptyCounts(): Record<CostTier, { accepted: number; total: number }> {
  return {
    budget: { accepted: 0, total: 0 },
    balanced: { accepted: 0, total: 0 },
    premium: { accepted: 0, total: 0 },
  };
}

function emptyRates(): Record<CostTier, number> {
  return { budget: 0, balanced: 0, premium: 0 };
}

export interface SessionTierBiasLearnerOptions {
  /**
   * Minimum outcomes per tier before that tier's stats influence adjustment.
   * Default 5 — below this, the learner stays silent.
   */
  warmThreshold?: number;
  /**
   * Acceptance rate below which the recommended tier is considered "bad
   * for this user." Default 0.30.
   */
  lowAcceptanceThreshold?: number;
  /**
   * Acceptance rate above which an alternative tier is considered "good
   * for this user" (candidate to flip to). Default 0.70.
   */
  highAcceptanceThreshold?: number;
  /**
   * When the recommended tier's observed acceptance is mid-range
   * (between low and high thresholds), confidence is scaled by this
   * factor. Default 0.7 — moderate confidence reduction.
   */
  midRangeConfidencePenalty?: number;
  /**
   * Whether to scope stats per-user (true) or globally per-learner-
   * instance (false). Default true. Per-user matters when one learner
   * serves multiple users (multi-tenant proxy). For the Komatik IDE
   * where one Slipstream instance is cached per user, either works.
   */
  perUserScoping?: boolean;
}

/**
 * Default in-memory `TierBiasLearner`. Per-instance state — when paired
 * with a per-user Slipstream cache (as the Komatik IDE does), this
 * naturally becomes per-user-per-session learning.
 */
export class SessionTierBiasLearner implements TierBiasLearner {
  private readonly options: Required<SessionTierBiasLearnerOptions>;
  private readonly statsByScope = new Map<string, Record<CostTier, { accepted: number; total: number }>>();

  constructor(options: SessionTierBiasLearnerOptions = {}) {
    this.options = {
      warmThreshold: options.warmThreshold ?? 5,
      lowAcceptanceThreshold: options.lowAcceptanceThreshold ?? 0.3,
      highAcceptanceThreshold: options.highAcceptanceThreshold ?? 0.7,
      midRangeConfidencePenalty: options.midRangeConfidencePenalty ?? 0.7,
      perUserScoping: options.perUserScoping ?? true,
    };
  }

  recordOutcome(input: TierOutcomeInput): void {
    const counts = this.getOrCreateCounts(this.scopeKey(input));
    counts[input.tier].total++;
    if (input.accepted) counts[input.tier].accepted++;
  }

  adjust(base: TierRecommendation, ctx: TierBiasContext): TierRecommendation {
    const counts = this.statsByScope.get(this.scopeKey(ctx));
    if (!counts) return base;

    const baseTier = base.tier;
    const baseCounts = counts[baseTier];

    // Below warm threshold for the recommended tier → no adjustment.
    if (baseCounts.total < this.options.warmThreshold) return base;

    const baseRate = baseCounts.accepted / baseCounts.total;

    // Path 1: base tier has consistently LOW acceptance. Look for an
    // alternative tier with consistently HIGH acceptance and enough data.
    if (baseRate < this.options.lowAcceptanceThreshold) {
      const alternative = this.findHighAcceptanceAlternative(counts, baseTier);
      if (alternative) {
        const altRate = counts[alternative].accepted / counts[alternative].total;
        return {
          tier: alternative,
          // Higher confidence than the base because we have data backing it.
          confidence: Math.min(0.95, 0.6 + altRate * 0.35),
          reasoning: `Bias-adjusted: base recommendation was ${baseTier} (heuristic), but observed acceptance for ${baseTier} is ${(baseRate * 100).toFixed(0)}% over ${baseCounts.total} outcomes. ${alternative} has ${(altRate * 100).toFixed(0)}% acceptance over ${counts[alternative].total} outcomes — switching.`,
          signals: base.signals,
          biasAdjustment: {
            originalTier: baseTier,
            appliedReason: "low-acceptance-flip",
            observedAcceptance: this.observedAcceptanceMap(counts),
          },
        };
      }
    }

    // Path 2: base tier has mid-range acceptance — keep the tier but
    // soften the confidence so the host knows to consider falling back to
    // user pick.
    if (baseRate < this.options.highAcceptanceThreshold) {
      const adjustedConfidence = base.confidence * this.options.midRangeConfidencePenalty;
      return {
        tier: baseTier,
        confidence: adjustedConfidence,
        reasoning: `${base.reasoning} (Confidence softened by observed acceptance: ${(baseRate * 100).toFixed(0)}% over ${baseCounts.total} outcomes.)`,
        signals: base.signals,
        biasAdjustment: {
          originalTier: baseTier,
          appliedReason: "mid-range-confidence-penalty",
          observedAcceptance: this.observedAcceptanceMap(counts),
        },
      };
    }

    // Path 3: base tier has high acceptance — keep as-is, but boost confidence.
    const boostedConfidence = Math.min(0.95, base.confidence + 0.1);
    return {
      tier: baseTier,
      confidence: boostedConfidence,
      reasoning: `${base.reasoning} (Confidence boosted: observed acceptance ${(baseRate * 100).toFixed(0)}% over ${baseCounts.total} outcomes.)`,
      signals: base.signals,
      biasAdjustment: {
        originalTier: baseTier,
        appliedReason: "high-acceptance-boost",
        observedAcceptance: this.observedAcceptanceMap(counts),
      },
    };
  }

  getStats(ctx: TierBiasContext = {}): TierBiasStats {
    const counts = this.statsByScope.get(this.scopeKey(ctx)) ?? emptyCounts();
    const rates = emptyRates();
    let total = 0;
    for (const tier of TIERS) {
      const c = counts[tier];
      total += c.total;
      rates[tier] = c.total > 0 ? c.accepted / c.total : 0;
    }
    const warm = TIERS.some((t) => counts[t].total >= this.options.warmThreshold);
    return {
      counts: {
        budget: { ...counts.budget },
        balanced: { ...counts.balanced },
        premium: { ...counts.premium },
      },
      rates,
      total,
      warm,
    };
  }

  private scopeKey(ctx: TierBiasContext): string {
    if (this.options.perUserScoping && ctx.userId) return `u:${ctx.userId}`;
    return "global";
  }

  private getOrCreateCounts(key: string): Record<CostTier, { accepted: number; total: number }> {
    let counts = this.statsByScope.get(key);
    if (!counts) {
      counts = emptyCounts();
      this.statsByScope.set(key, counts);
    }
    return counts;
  }

  private findHighAcceptanceAlternative(
    counts: Record<CostTier, { accepted: number; total: number }>,
    excludeTier: CostTier,
  ): CostTier | null {
    let best: CostTier | null = null;
    let bestRate = this.options.highAcceptanceThreshold;
    for (const tier of TIERS) {
      if (tier === excludeTier) continue;
      const c = counts[tier];
      if (c.total < this.options.warmThreshold) continue;
      const rate = c.accepted / c.total;
      if (rate > bestRate) {
        best = tier;
        bestRate = rate;
      }
    }
    return best;
  }

  private observedAcceptanceMap(
    counts: Record<CostTier, { accepted: number; total: number }>,
  ): Partial<Record<CostTier, number>> {
    const out: Partial<Record<CostTier, number>> = {};
    for (const tier of TIERS) {
      const c = counts[tier];
      if (c.total > 0) out[tier] = c.accepted / c.total;
    }
    return out;
  }
}
