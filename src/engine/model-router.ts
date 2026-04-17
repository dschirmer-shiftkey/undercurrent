import type {
  IntentSignal,
  ModelOption,
  ModelProvider,
  ModelRecommendation,
  ScoringWeights,
  TaskDomain,
} from "../types.js";

// ─── Default Affinities ────────────────────────────────────────────────────
// Used when user has < MIN_DATA_POINTS for a domain. Encodes general
// model-family strengths (Anthropic strong at code, Google at creative, etc.)

const DEFAULT_AFFINITY: Record<TaskDomain, ModelProvider[]> = {
  coding: ["anthropic", "openai"],
  debugging: ["anthropic", "openai"],
  creative: ["google", "anthropic"],
  analysis: ["openai", "google"],
  planning: ["anthropic", "openai"],
  conversation: ["anthropic", "google"],
};

const MIN_DATA_POINTS = 10;
const DATA_DRIVEN_THRESHOLD = 50;

const DEFAULT_WEIGHTS: ScoringWeights = {
  successRate: 0.35,
  acceptanceRate: 0.3,
  latency: 0.1,
  affinity: 0.25,
};

// ─── TaskDomainClassifier ──────────────────────────────────────────────────
// Maps IntentSignal (action + domainHints) to a TaskDomain. Pure heuristic,
// no LLM needed. Re-uses the same domain detection patterns from
// KomatikPipelineStrategy.

const CODE_HINTS =
  /\b(code|typescript|javascript|python|react|api|endpoint|function|class|module|refactor|lint|compile|deploy|git|pr|merge|branch|test|ci|cd|docker|kubernetes|k8s|infra|backend|frontend|fullstack|debug)\b/i;
const DEBUG_HINTS =
  /\b(error|bug|exception|stack.?trace|crash|failing|broken|regression|fix|debug|issue|404|500|null|undefined|nan)\b/i;
const CREATIVE_HINTS =
  /\b(write|blog|story|copy|headline|slogan|brand|content|marketing|social|tone|voice|style|creative|design|ui|ux|color|font|layout|illustration|image|video|animation)\b/i;
const ANALYSIS_HINTS =
  /\b(data|research|analyze|chart|metric|dashboard|report|statistics|trend|insight|forecast|compare|benchmark|evaluate|review|audit|survey)\b/i;
const PLANNING_HINTS =
  /\b(architect|plan|roadmap|strategy|scope|milestone|timeline|estimate|spec|rfc|proposal|decision|tradeoff|migration)\b/i;

export class TaskDomainClassifier {
  classify(intent: IntentSignal): TaskDomain {
    const hints = intent.domainHints.join(" ");
    const fragments = intent.rawFragments.join(" ");
    const combined = `${hints} ${fragments}`;

    if (intent.action === "fix" && DEBUG_HINTS.test(combined)) return "debugging";
    if ((intent.action === "build" || intent.action === "fix") && CODE_HINTS.test(combined))
      return "coding";
    if (intent.action === "design" && CREATIVE_HINTS.test(combined)) return "creative";
    if ((intent.action === "design" || intent.action === "decide") && PLANNING_HINTS.test(combined))
      return "planning";
    if (intent.action === "explore" && ANALYSIS_HINTS.test(combined)) return "analysis";

    if (DEBUG_HINTS.test(combined)) return "debugging";
    if (CODE_HINTS.test(combined)) return "coding";
    if (CREATIVE_HINTS.test(combined)) return "creative";
    if (ANALYSIS_HINTS.test(combined)) return "analysis";
    if (PLANNING_HINTS.test(combined)) return "planning";

    return "conversation";
  }
}

// ─── Model Scoring Data ────────────────────────────────────────────────────
// Consumed by ModelScorer. Produced by KomatikModelUsageAdapter.

export interface AvailableModel {
  provider: ModelProvider;
  model: string;
  smokeTestLatencyMs: number | null;
}

export interface UsageStats {
  model: string;
  provider: string;
  successRate: number;
  avgLatencyMs: number;
  dataPoints: number;
}

export interface OutcomeStats {
  platform: string;
  acceptanceRate: number;
  correctionRate: number;
  dataPoints: number;
}

export interface ScoringData {
  availableModels: AvailableModel[];
  usageByModel: Map<string, UsageStats>;
  outcomesByPlatform: Map<string, OutcomeStats>;
}

// ─── ModelScorer ───────────────────────────────────────────────────────────
// Ranks available models for a given TaskDomain + user.
// score = (w1 * successRate) + (w2 * acceptanceRate) + (w3 * (1 - normLatency)) + (w4 * affinityBonus)
// w4 automatically decreases as real data accumulates.

export class ModelScorer {
  private readonly weights: ScoringWeights;

  constructor(weights?: Partial<ScoringWeights>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  score(domain: TaskDomain, data: ScoringData): ModelRecommendation {
    const affinityProviders = DEFAULT_AFFINITY[domain];
    const maxLatency = this.findMaxLatency(data);

    const scored: ModelOption[] = data.availableModels.map((m) => {
      const usage = data.usageByModel.get(m.model);
      const outcome = this.findOutcomeForProvider(m.provider, data.outcomesByPlatform);
      const totalDataPoints = (usage?.dataPoints ?? 0) + (outcome?.dataPoints ?? 0);

      const successRate = usage?.successRate ?? null;
      const acceptanceRate = outcome?.acceptanceRate ?? null;
      const avgLatencyMs = usage?.avgLatencyMs ?? m.smokeTestLatencyMs ?? null;

      const affinityRank = affinityProviders.indexOf(m.provider);
      const affinityBonus = affinityRank === 0 ? 1.0 : affinityRank === 1 ? 0.6 : 0.2;

      const effectiveWeights = this.computeEffectiveWeights(totalDataPoints);

      let score = 0;
      let divisor = 0;

      if (successRate !== null) {
        score += effectiveWeights.successRate * successRate;
        divisor += effectiveWeights.successRate;
      }
      if (acceptanceRate !== null) {
        score += effectiveWeights.acceptanceRate * acceptanceRate;
        divisor += effectiveWeights.acceptanceRate;
      }
      if (avgLatencyMs !== null && maxLatency > 0) {
        const normLatency = avgLatencyMs / maxLatency;
        score += effectiveWeights.latency * (1 - normLatency);
        divisor += effectiveWeights.latency;
      }

      score += effectiveWeights.affinity * affinityBonus;
      divisor += effectiveWeights.affinity;

      const finalScore = divisor > 0 ? score / divisor : affinityBonus;

      return {
        provider: m.provider,
        model: m.model,
        score: finalScore,
        stats: {
          successRate,
          acceptanceRate,
          avgLatencyMs,
          dataPoints: totalDataPoints,
        },
      };
    });

    scored.sort((a, b) => b.score - a.score);

    const recommended = scored[0];
    if (!recommended) {
      return this.fallbackRecommendation(domain);
    }

    const totalData = scored.reduce((sum, m) => sum + m.stats.dataPoints, 0);
    const confidence = this.computeConfidence(totalData, scored);

    return {
      domain,
      recommended,
      alternatives: scored.slice(1),
      confidence,
      reasoning: this.buildReasoning(domain, recommended, totalData),
      basedOnDataPoints: totalData,
    };
  }

  private computeEffectiveWeights(dataPoints: number): ScoringWeights {
    if (dataPoints >= DATA_DRIVEN_THRESHOLD) {
      const affinityReduction = this.weights.affinity - 0.05;
      const redistributed = affinityReduction / 3;
      return {
        successRate: this.weights.successRate + redistributed,
        acceptanceRate: this.weights.acceptanceRate + redistributed,
        latency: this.weights.latency + redistributed,
        affinity: 0.05,
      };
    }
    return { ...this.weights };
  }

  private computeConfidence(totalData: number, scored: ModelOption[]): number {
    if (totalData === 0) return 0.1;
    if (totalData < MIN_DATA_POINTS) return 0.2 + (totalData / MIN_DATA_POINTS) * 0.2;

    const dataConfidence = Math.min(totalData / 100, 0.4) + 0.3;

    const top = scored[0];
    const second = scored[1];
    if (top && second) {
      const gap = top.score - second.score;
      const separationBonus = Math.min(gap * 2, 0.3);
      return Math.min(dataConfidence + separationBonus, 1.0);
    }

    return Math.min(dataConfidence, 1.0);
  }

  private findMaxLatency(data: ScoringData): number {
    let max = 0;
    for (const usage of data.usageByModel.values()) {
      if (usage.avgLatencyMs > max) max = usage.avgLatencyMs;
    }
    for (const m of data.availableModels) {
      if (m.smokeTestLatencyMs && m.smokeTestLatencyMs > max) max = m.smokeTestLatencyMs;
    }
    return max;
  }

  private findOutcomeForProvider(
    provider: ModelProvider,
    outcomes: Map<string, OutcomeStats>,
  ): OutcomeStats | undefined {
    return outcomes.get(provider);
  }

  private buildReasoning(domain: TaskDomain, pick: ModelOption, totalData: number): string {
    if (totalData === 0) {
      return `Selected ${pick.model} (${pick.provider}) for ${domain} based on default affinity heuristics — no historical data yet.`;
    }
    if (totalData < MIN_DATA_POINTS) {
      return `Selected ${pick.model} (${pick.provider}) for ${domain} with limited data (${totalData} points). Mostly heuristic, will improve as usage grows.`;
    }
    const parts = [`Selected ${pick.model} (${pick.provider}) for ${domain}`];
    if (pick.stats.successRate !== null) {
      parts.push(`success rate ${(pick.stats.successRate * 100).toFixed(0)}%`);
    }
    if (pick.stats.acceptanceRate !== null) {
      parts.push(`acceptance rate ${(pick.stats.acceptanceRate * 100).toFixed(0)}%`);
    }
    parts.push(`based on ${totalData} data points`);
    return parts.join(", ") + ".";
  }

  private fallbackRecommendation(domain: TaskDomain): ModelRecommendation {
    const provider = DEFAULT_AFFINITY[domain][0] ?? "anthropic";
    return {
      domain,
      recommended: {
        provider,
        model: `${provider}-default`,
        score: 0.5,
        stats: { successRate: null, acceptanceRate: null, avgLatencyMs: null, dataPoints: 0 },
      },
      alternatives: [],
      confidence: 0.1,
      reasoning: `No models available in roster. Falling back to ${provider} default for ${domain}.`,
      basedOnDataPoints: 0,
    };
  }
}

// ─── ModelRouter ───────────────────────────────────────────────────────────
// Orchestrates classification + scoring. Used by Pipeline.process().

export class ModelRouter {
  private readonly classifier: TaskDomainClassifier;
  private readonly scorer: ModelScorer;
  private readonly defaultProvider: ModelProvider;

  constructor(weights?: Partial<ScoringWeights>, defaultProvider?: ModelProvider) {
    this.classifier = new TaskDomainClassifier();
    this.scorer = new ModelScorer(weights);
    this.defaultProvider = defaultProvider ?? "anthropic";
  }

  classifyDomain(intent: IntentSignal): TaskDomain {
    return this.classifier.classify(intent);
  }

  recommend(intent: IntentSignal, data: ScoringData): ModelRecommendation {
    const domain = this.classifier.classify(intent);
    const rec = this.scorer.score(domain, data);

    if (
      rec.basedOnDataPoints === 0 &&
      rec.alternatives.length === 0 &&
      data.availableModels.length === 0
    ) {
      rec.recommended.provider = this.defaultProvider;
      rec.recommended.model = `${this.defaultProvider}-default`;
      rec.reasoning = `No models available in roster. Falling back to configured default provider (${this.defaultProvider}) for ${domain}.`;
    }

    return rec;
  }
}
