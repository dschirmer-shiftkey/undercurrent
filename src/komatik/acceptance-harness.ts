import {
  SlipstreamSessionManager,
  type SessionEvent,
  type TierBias,
} from "./session-manager.js";
import { createMockClient, createMockWriteClient } from "./testing.js";
import type {
  ConversationTurn,
  ModelCallerFn,
  ModelCallerOutput,
  TargetPlatform,
} from "../types.js";

/**
 * Methodology harness for validating that Slipstream's auto-routing
 * (router + scorer + tier-bias presets) produces ≥ acceptance vs. the
 * IDE's current fixed-tier approach. Runs the same workload through N
 * configurations and reports a head-to-head comparison.
 *
 * **Honest framing:** without real production acceptance data, the
 * simulated acceptance rule (configurable) is what drives the result.
 * This harness is a methodology — the real proof comes from re-running
 * it against actual user acceptance signals once they exist. What it
 * proves today is that the wiring works end-to-end and the comparison
 * metrics surface the right signal.
 */

export interface SimulatedModel {
  provider: string;
  apiName: string;
  smokeLatencyMs: number;
  /** Cost per 1k tokens (input + output combined for simplicity). */
  costPerKtoken: number;
  /**
   * Simulated acceptance probability per task domain.
   * Keys: coding, debugging, creative, analysis, planning, conversation.
   * Default 0.8 for any domain not listed.
   */
  acceptanceByDomain?: Partial<Record<string, number>>;
}

export interface HarnessMessage {
  text: string;
  /**
   * Domain label for acceptance simulation. Comes from the workload definition,
   * not from inference — it's the "ground truth" the harness uses to score.
   */
  domain: string;
  /** Optional conversation context to seed for this message. */
  conversation?: ConversationTurn[];
}

export interface HarnessConfig {
  /** Display name for the comparison ("fixed-balanced", "auto-routed", etc.) */
  name: string;
  /** Tier bias applied to every message in this run. */
  tierBias: TierBias;
}

export interface HarnessOptions {
  workload: HarnessMessage[];
  configs: HarnessConfig[];
  models?: SimulatedModel[];
  /** Deterministic seed for the acceptance roll. Default 42. */
  seed?: number;
  /** Override the simulated llm_usage rows passed to the scorer. */
  seedLlmUsage?: Record<string, unknown>[];
  /** Override the simulated enrichment_outcomes rows passed to the scorer. */
  seedOutcomes?: Record<string, unknown>[];
}

export interface HarnessRunResult {
  config: HarnessConfig;
  totalMessages: number;
  acceptanceRate: number;
  acceptedCount: number;
  avgLatencyMs: number;
  avgTokenMultiplier: number;
  totalCost: number;
  modelHistogram: Record<string, number>;
}

export interface HarnessComparison {
  results: HarnessRunResult[];
  winners: {
    byAcceptance: string;
    byLatency: string;
    byCost: string;
  };
  spreads: {
    acceptance: number;
    latency: number;
    cost: number;
  };
}

const DEFAULT_MODELS: SimulatedModel[] = [
  {
    provider: "openai",
    apiName: "gpt-5-mini",
    smokeLatencyMs: 180,
    costPerKtoken: 0.001,
    acceptanceByDomain: { coding: 0.72, debugging: 0.7, creative: 0.65, analysis: 0.75, planning: 0.6, conversation: 0.82 },
  },
  {
    provider: "anthropic",
    apiName: "claude-sonnet-4-6",
    smokeLatencyMs: 220,
    costPerKtoken: 0.003,
    acceptanceByDomain: { coding: 0.88, debugging: 0.86, creative: 0.78, analysis: 0.84, planning: 0.85, conversation: 0.83 },
  },
  {
    provider: "google",
    apiName: "gemini-2-pro",
    smokeLatencyMs: 260,
    costPerKtoken: 0.002,
    acceptanceByDomain: { coding: 0.8, debugging: 0.78, creative: 0.84, analysis: 0.88, planning: 0.82, conversation: 0.86 },
  },
  {
    provider: "anthropic",
    apiName: "claude-opus-4-7",
    smokeLatencyMs: 380,
    costPerKtoken: 0.015,
    acceptanceByDomain: { coding: 0.94, debugging: 0.92, creative: 0.9, analysis: 0.93, planning: 0.95, conversation: 0.88 },
  },
  {
    provider: "openai",
    apiName: "gpt-5",
    smokeLatencyMs: 340,
    costPerKtoken: 0.01,
    acceptanceByDomain: { coding: 0.91, debugging: 0.9, creative: 0.86, analysis: 0.89, planning: 0.91, conversation: 0.87 },
  },
];

/** Mulberry32 — deterministic PRNG with a 32-bit state. */
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

function buildModelAvailability(models: SimulatedModel[]): Record<string, unknown>[] {
  return models.map((m) => ({
    provider: m.provider,
    api_model_name: m.apiName,
    status: "active",
    smoke_test_latency_ms: m.smokeLatencyMs,
  }));
}

function makeCaller(models: SimulatedModel[]): ModelCallerFn {
  const byApiName = new Map(models.map((m) => [m.apiName, m]));
  return async ({ model, provider, enrichedSystemPrompt }): Promise<ModelCallerOutput> => {
    const meta = byApiName.get(model);
    const latency = meta?.smokeLatencyMs ?? 200;
    // Sub-ms simulation; real harness should mock the clock for true zero-cost runs.
    await new Promise((r) => setTimeout(r, 0));
    return {
      content: `Simulated ${provider}/${model} response.`,
      model,
      provider,
      inputTokens: Math.ceil(enrichedSystemPrompt.length / 4),
      outputTokens: 64,
      latencyMs: latency,
    };
  };
}

function rollVerdict(
  rng: () => number,
  domain: string,
  modelName: string,
  models: SimulatedModel[],
): boolean {
  const model = models.find((m) => m.apiName === modelName);
  if (!model) return rng() < 0.8;
  const prob = model.acceptanceByDomain?.[domain] ?? 0.8;
  return rng() < prob;
}

function costForCall(modelName: string, inputTokens: number, outputTokens: number, models: SimulatedModel[]): number {
  const model = models.find((m) => m.apiName === modelName);
  if (!model) return 0;
  return ((inputTokens + outputTokens) / 1000) * model.costPerKtoken;
}

async function runOneConfig(
  config: HarnessConfig,
  workload: HarnessMessage[],
  models: SimulatedModel[],
  rng: () => number,
  seedLlmUsage: Record<string, unknown>[],
  seedOutcomes: Record<string, unknown>[],
): Promise<HarnessRunResult> {
  const client = createMockClient({
    model_availability: buildModelAvailability(models),
    llm_usage: seedLlmUsage,
    enrichment_outcomes: seedOutcomes,
    user_preferences: [],
  });
  const { client: writeClient } = createMockWriteClient({
    enrichment_outcomes: [],
    user_preferences: [],
    session_memories: [],
  });

  const modelHistogram: Record<string, number> = {};
  const events: SessionEvent[] = [];

  const manager = new SlipstreamSessionManager({
    client,
    writeClient,
    caller: makeCaller(models),
    defaultTierBias: config.tierBias,
    onSessionEvent: (e) => events.push(e),
  });

  await manager.startSession({
    sessionId: `harness-${config.name}`,
    scope: "sandbox", // skip outcome persistence for cleaner per-run state
    user: { id: "harness-user", tierBias: config.tierBias },
  });

  let totalLatency = 0;
  let totalTokenMultiplier = 0;
  let acceptedCount = 0;
  let totalCost = 0;

  for (const msg of workload) {
    const result = await manager.process({
      sessionId: `harness-${config.name}`,
      message: msg.text,
      conversation: msg.conversation,
      targetPlatform: "cursor" as TargetPlatform,
    });

    const modelName = result.modelResponse.model;
    modelHistogram[modelName] = (modelHistogram[modelName] ?? 0) + 1;

    const accepted = rollVerdict(rng, msg.domain, modelName, models);
    if (accepted) acceptedCount++;

    await manager.recordOutcome({
      sessionId: `harness-${config.name}`,
      requestId: result.requestId,
      accepted,
    });

    totalLatency += result.modelResponse.latencyMs;
    totalTokenMultiplier += result.telemetry.tokenMultiplier;
    totalCost += costForCall(
      modelName,
      result.telemetry.inputTokens,
      result.telemetry.outputTokens,
      models,
    );
  }

  await manager.endSession(`harness-${config.name}`);

  const total = workload.length;
  return {
    config,
    totalMessages: total,
    acceptanceRate: acceptedCount / total,
    acceptedCount,
    avgLatencyMs: totalLatency / total,
    avgTokenMultiplier: totalTokenMultiplier / total,
    totalCost,
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
  return best.config.name;
}

function spread(results: HarnessRunResult[], selector: (r: HarnessRunResult) => number): number {
  const values = results.map(selector);
  return Math.max(...values) - Math.min(...values);
}

export async function runAcceptanceHarness(options: HarnessOptions): Promise<HarnessComparison> {
  const models = options.models ?? DEFAULT_MODELS;
  const seed = options.seed ?? 42;
  const seedLlmUsage = options.seedLlmUsage ?? [];
  const seedOutcomes = options.seedOutcomes ?? [];

  const results: HarnessRunResult[] = [];
  for (const config of options.configs) {
    // Each config gets its own RNG instance with the same seed so the
    // acceptance rolls are deterministic AND parallel across configs.
    const rng = makeRng(seed);
    const result = await runOneConfig(config, options.workload, models, rng, seedLlmUsage, seedOutcomes);
    results.push(result);
  }

  return {
    results,
    winners: {
      byAcceptance: pickWinner(results, (r) => r.acceptanceRate, false),
      byLatency: pickWinner(results, (r) => r.avgLatencyMs, true),
      byCost: pickWinner(results, (r) => r.totalCost, true),
    },
    spreads: {
      acceptance: spread(results, (r) => r.acceptanceRate),
      latency: spread(results, (r) => r.avgLatencyMs),
      cost: spread(results, (r) => r.totalCost),
    },
  };
}
