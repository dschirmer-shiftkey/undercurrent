import { describe, it, expect } from "vitest";
import { TaskDomainClassifier, ModelScorer, ModelRouter } from "./model-router.js";
import type { AvailableModel, ScoringData, UsageStats, OutcomeStats } from "./model-router.js";
import type { IntentSignal } from "../types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeIntent(overrides: Partial<IntentSignal> = {}): IntentSignal {
  return {
    action: "build",
    specificity: "medium",
    scope: "local",
    emotionalLoad: "neutral",
    confidence: 0.7,
    rawFragments: [],
    domainHints: [],
    ...overrides,
  };
}

function makeScoringData(overrides: Partial<ScoringData> = {}): ScoringData {
  return {
    availableModels: overrides.availableModels ?? [],
    usageByModel: overrides.usageByModel ?? new Map(),
    outcomesByPlatform: overrides.outcomesByPlatform ?? new Map(),
  };
}

function makeModels(...specs: Array<[string, string, number | null]>): AvailableModel[] {
  return specs.map(([provider, model, latency]) => ({
    provider: provider as AvailableModel["provider"],
    model,
    smokeTestLatencyMs: latency,
  }));
}

// ─── TaskDomainClassifier ──────────────────────────────────────────────────

describe("TaskDomainClassifier", () => {
  const classifier = new TaskDomainClassifier();

  it("classifies coding from build action + code hints", () => {
    const intent = makeIntent({ action: "build", domainHints: ["typescript", "api"] });
    expect(classifier.classify(intent)).toBe("coding");
  });

  it("classifies debugging from fix action + error hints", () => {
    const intent = makeIntent({ action: "fix", domainHints: ["error", "stack-trace"] });
    expect(classifier.classify(intent)).toBe("debugging");
  });

  it("classifies creative from design action + creative hints", () => {
    const intent = makeIntent({ action: "design", domainHints: ["ui", "brand", "color"] });
    expect(classifier.classify(intent)).toBe("creative");
  });

  it("classifies planning from decide action + architecture hints", () => {
    const intent = makeIntent({ action: "decide", domainHints: ["architecture", "migration"] });
    expect(classifier.classify(intent)).toBe("planning");
  });

  it("classifies analysis from explore action + data hints", () => {
    const intent = makeIntent({ action: "explore", domainHints: ["data", "metrics", "dashboard"] });
    expect(classifier.classify(intent)).toBe("analysis");
  });

  it("falls back to conversation for vague intents", () => {
    const intent = makeIntent({ action: "discuss", domainHints: ["general"] });
    expect(classifier.classify(intent)).toBe("conversation");
  });

  it("uses rawFragments to classify when domainHints are sparse", () => {
    const intent = makeIntent({ action: "fix", rawFragments: ["null reference exception in production"] });
    expect(classifier.classify(intent)).toBe("debugging");
  });

  it("coding wins over debugging when both signals present but action is build", () => {
    const intent = makeIntent({ action: "build", domainHints: ["react", "typescript"] });
    expect(classifier.classify(intent)).toBe("coding");
  });
});

// ─── ModelScorer ───────────────────────────────────────────────────────────

describe("ModelScorer", () => {
  const scorer = new ModelScorer();

  it("returns fallback recommendation when no models available", () => {
    const data = makeScoringData();
    const rec = scorer.score("coding", data);

    expect(rec.domain).toBe("coding");
    expect(rec.recommended.provider).toBe("anthropic");
    expect(rec.confidence).toBe(0.1);
    expect(rec.basedOnDataPoints).toBe(0);
    expect(rec.reasoning).toContain("No models available");
  });

  it("ranks by affinity when no usage data exists (pure heuristic)", () => {
    const models = makeModels(
      ["google", "gemini-pro", 500],
      ["anthropic", "claude-4", 400],
      ["openai", "gpt-5", 450],
    );
    const data = makeScoringData({ availableModels: models });
    const rec = scorer.score("coding", data);

    expect(rec.domain).toBe("coding");
    expect(rec.recommended.provider).toBe("anthropic");
    expect(rec.alternatives).toHaveLength(2);
    expect(rec.basedOnDataPoints).toBe(0);
    expect(rec.reasoning).toContain("default affinity");
  });

  it("ranks by affinity for creative domain (Google wins)", () => {
    const models = makeModels(
      ["google", "gemini-pro", 500],
      ["anthropic", "claude-4", 400],
      ["openai", "gpt-5", 450],
    );
    const data = makeScoringData({ availableModels: models });
    const rec = scorer.score("creative", data);

    expect(rec.recommended.provider).toBe("google");
  });

  it("uses data-driven ranking when usage data is available", () => {
    const models = makeModels(
      ["google", "gemini-pro", 500],
      ["anthropic", "claude-4", 400],
      ["openai", "gpt-5", 300],
    );

    const usageByModel = new Map<string, UsageStats>([
      ["gemini-pro", { model: "gemini-pro", provider: "google", successRate: 0.95, avgLatencyMs: 400, dataPoints: 30 }],
      ["claude-4", { model: "claude-4", provider: "anthropic", successRate: 0.80, avgLatencyMs: 350, dataPoints: 30 }],
      ["gpt-5", { model: "gpt-5", provider: "openai", successRate: 0.85, avgLatencyMs: 300, dataPoints: 30 }],
    ]);

    const outcomesByPlatform = new Map<string, OutcomeStats>([
      ["google", { platform: "google", acceptanceRate: 0.90, correctionRate: 0.05, dataPoints: 20 }],
      ["anthropic", { platform: "anthropic", acceptanceRate: 0.70, correctionRate: 0.15, dataPoints: 20 }],
    ]);

    const data = makeScoringData({ availableModels: models, usageByModel, outcomesByPlatform });
    const rec = scorer.score("coding", data);

    expect(rec.basedOnDataPoints).toBeGreaterThan(0);
    expect(rec.confidence).toBeGreaterThan(0.2);
    expect(rec.recommended.stats.successRate).not.toBeNull();
  });

  it("reduces affinity weight when data points exceed threshold", () => {
    const models = makeModels(
      ["google", "gemini-pro", 500],
      ["anthropic", "claude-4", 400],
    );

    const usageByModel = new Map<string, UsageStats>([
      ["gemini-pro", { model: "gemini-pro", provider: "google", successRate: 0.95, avgLatencyMs: 400, dataPoints: 40 }],
      ["claude-4", { model: "claude-4", provider: "anthropic", successRate: 0.70, avgLatencyMs: 350, dataPoints: 40 }],
    ]);

    const outcomesByPlatform = new Map<string, OutcomeStats>([
      ["google", { platform: "google", acceptanceRate: 0.95, correctionRate: 0.02, dataPoints: 30 }],
      ["anthropic", { platform: "anthropic", acceptanceRate: 0.60, correctionRate: 0.20, dataPoints: 30 }],
    ]);

    const data = makeScoringData({ availableModels: models, usageByModel, outcomesByPlatform });

    const rec = scorer.score("coding", data);
    // With 70 data points per model, affinity drops. Google has much better
    // success + acceptance, so it should win despite coding affinity favoring anthropic.
    expect(rec.recommended.provider).toBe("google");
  });

  it("confidence increases with more data", () => {
    const models = makeModels(["anthropic", "claude-4", 400]);

    const dataLow = makeScoringData({
      availableModels: models,
      usageByModel: new Map([
        ["claude-4", { model: "claude-4", provider: "anthropic", successRate: 0.9, avgLatencyMs: 400, dataPoints: 3 }],
      ]),
    });

    const dataHigh = makeScoringData({
      availableModels: models,
      usageByModel: new Map([
        ["claude-4", { model: "claude-4", provider: "anthropic", successRate: 0.9, avgLatencyMs: 400, dataPoints: 80 }],
      ]),
    });

    const recLow = scorer.score("coding", dataLow);
    const recHigh = scorer.score("coding", dataHigh);

    expect(recHigh.confidence).toBeGreaterThan(recLow.confidence);
  });

  it("includes stats on the recommended model", () => {
    const models = makeModels(["anthropic", "claude-4", 350]);
    const usageByModel = new Map<string, UsageStats>([
      ["claude-4", { model: "claude-4", provider: "anthropic", successRate: 0.88, avgLatencyMs: 350, dataPoints: 25 }],
    ]);

    const data = makeScoringData({ availableModels: models, usageByModel });
    const rec = scorer.score("coding", data);

    expect(rec.recommended.stats.successRate).toBe(0.88);
    expect(rec.recommended.stats.avgLatencyMs).toBe(350);
    expect(rec.recommended.stats.dataPoints).toBe(25);
  });
});

// ─── ModelRouter (orchestrator) ────────────────────────────────────────────

describe("ModelRouter", () => {
  const router = new ModelRouter();

  it("classifies domain and recommends in one call", () => {
    const intent = makeIntent({ action: "build", domainHints: ["react", "typescript"] });
    const models = makeModels(
      ["anthropic", "claude-4", 400],
      ["openai", "gpt-5", 450],
    );
    const data = makeScoringData({ availableModels: models });

    const rec = router.recommend(intent, data);
    expect(rec.domain).toBe("coding");
    expect(rec.recommended).toBeDefined();
    expect(rec.recommended.provider).toBe("anthropic");
  });

  it("classifyDomain delegates to TaskDomainClassifier", () => {
    const intent = makeIntent({ action: "explore", domainHints: ["data", "chart"] });
    expect(router.classifyDomain(intent)).toBe("analysis");
  });

  it("accepts custom scoring weights", () => {
    const customRouter = new ModelRouter({ latency: 0.8, affinity: 0.05, successRate: 0.1, acceptanceRate: 0.05 });
    const intent = makeIntent({ action: "build", domainHints: ["code"] });

    const models = makeModels(
      ["google", "gemini-pro", 200],
      ["anthropic", "claude-4", 800],
    );

    const usageByModel = new Map<string, UsageStats>([
      ["gemini-pro", { model: "gemini-pro", provider: "google", successRate: 0.80, avgLatencyMs: 200, dataPoints: 20 }],
      ["claude-4", { model: "claude-4", provider: "anthropic", successRate: 0.85, avgLatencyMs: 800, dataPoints: 20 }],
    ]);

    const data = makeScoringData({ availableModels: models, usageByModel });
    const rec = customRouter.recommend(intent, data);

    // With latency weight at 0.8, the faster model should win
    expect(rec.recommended.model).toBe("gemini-pro");
  });
});
