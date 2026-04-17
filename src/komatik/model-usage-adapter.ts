import type { ContextAdapter, AdapterInput, ContextLayer, ModelProvider } from "../types.js";
import type { KomatikDataClient } from "./client.js";
import type {
  AvailableModel,
  OutcomeStats,
  ScoringData,
  UsageStats,
} from "../engine/model-router.js";

export interface KomatikModelUsageAdapterOptions {
  client: KomatikDataClient;
  userId: string;
}

/**
 * Reads three Komatik tables to build the scoring dataset for the ModelRouter:
 * - model_availability — active roster (provider, model, status, smoke_test_latency)
 * - llm_usage — per-model success rate, latency, cost for this user
 * - enrichment_outcomes — per-model acceptance rate for this user (matched via platform field)
 *
 * Returns a ContextLayer with source "komatik-model-usage" containing the ScoringData.
 */
export class KomatikModelUsageAdapter implements ContextAdapter {
  readonly name = "komatik-model-usage";
  readonly priority = 5;

  private readonly client: KomatikDataClient;
  private readonly userId: string;

  constructor(options: KomatikModelUsageAdapterOptions) {
    this.client = options.client;
    this.userId = options.userId;
  }

  async available(): Promise<boolean> {
    return true;
  }

  async gather(_input: AdapterInput): Promise<ContextLayer[]> {
    const data = await this.loadScoringData();
    if (data.availableModels.length === 0) return [];

    return [
      {
        source: this.name,
        priority: this.priority,
        timestamp: Date.now(),
        data: data as unknown as Record<string, unknown>,
        summary: `${data.availableModels.length} active models, ${data.usageByModel.size} with usage data, ${data.outcomesByPlatform.size} with outcome data`,
      },
    ];
  }

  async loadScoringData(): Promise<ScoringData> {
    const [availableModels, usageByModel, outcomesByPlatform] = await Promise.all([
      this.loadAvailableModels(),
      this.loadUsageStats(),
      this.loadOutcomeStats(),
    ]);

    return { availableModels, usageByModel, outcomesByPlatform };
  }

  async loadAvailableModels(): Promise<AvailableModel[]> {
    const { data, error } = await this.client
      .from("model_availability")
      .select("provider, api_model_name, smoke_test_latency_ms")
      .eq("status", "active");

    if (error || !data) return [];

    return (data as Record<string, unknown>[]).map((row) => ({
      provider: normalizeProvider(row.provider as string),
      model: row.api_model_name as string,
      smokeTestLatencyMs: (row.smoke_test_latency_ms as number | null) ?? null,
    }));
  }

  async loadUsageStats(): Promise<Map<string, UsageStats>> {
    const { data, error } = await this.client
      .from("llm_usage")
      .select("model, provider, success, latency_ms")
      .eq("user_id", this.userId)
      .order("created_at", { ascending: false })
      .limit(500);

    if (error || !data) return new Map();

    const byModel = new Map<string, { successes: number; total: number; totalLatency: number; latencyCount: number }>();

    for (const row of data as Record<string, unknown>[]) {
      const model = row.model as string;
      const entry = byModel.get(model) ?? { successes: 0, total: 0, totalLatency: 0, latencyCount: 0 };

      entry.total++;
      if (row.success) entry.successes++;
      if (typeof row.latency_ms === "number") {
        entry.totalLatency += row.latency_ms;
        entry.latencyCount++;
      }

      byModel.set(model, entry);
    }

    const result = new Map<string, UsageStats>();
    for (const [model, agg] of byModel) {
      const matchingRow = (data as Record<string, unknown>[]).find((r) => r.model === model);
      result.set(model, {
        model,
        provider: (matchingRow?.provider as string) ?? "unknown",
        successRate: agg.total > 0 ? agg.successes / agg.total : 0,
        avgLatencyMs: agg.latencyCount > 0 ? agg.totalLatency / agg.latencyCount : 0,
        dataPoints: agg.total,
      });
    }

    return result;
  }

  async loadOutcomeStats(): Promise<Map<string, OutcomeStats>> {
    const { data, error } = await this.client
      .from("enrichment_outcomes")
      .select("platform, verdict")
      .eq("user_id", this.userId)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error || !data) return new Map();

    const byPlatform = new Map<string, { accepted: number; corrected: number; total: number }>();

    for (const row of data as Record<string, unknown>[]) {
      const platform = (row.platform as string) ?? "unknown";
      const entry = byPlatform.get(platform) ?? { accepted: 0, corrected: 0, total: 0 };

      entry.total++;
      if (row.verdict === "accepted") entry.accepted++;
      if (row.verdict === "revised") entry.corrected++;

      byPlatform.set(platform, entry);
    }

    const result = new Map<string, OutcomeStats>();
    for (const [platform, agg] of byPlatform) {
      result.set(platform, {
        platform,
        acceptanceRate: agg.total > 0 ? agg.accepted / agg.total : 0,
        correctionRate: agg.total > 0 ? agg.corrected / agg.total : 0,
        dataPoints: agg.total,
      });
    }

    return result;
  }
}

function normalizeProvider(raw: string): ModelProvider {
  const lower = raw.toLowerCase();
  if (lower === "anthropic") return "anthropic";
  if (lower === "openai") return "openai";
  if (lower === "google" || lower === "gemini") return "google";
  if (lower === "meta" || lower === "llama") return "meta";
  return "custom";
}
