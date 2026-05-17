import type { EnrichedPrompt, OutcomeVerdictInput, OutcomeWriter } from "../types.js";
import type { KomatikWriteClient } from "./client.js";

/**
 * Persists enrichment outcomes to the `enrichment_outcomes` Supabase table,
 * closing the feedback loop between enrichment and learning.
 *
 * Two-phase usage:
 * 1. writeEnrichmentRecord() — called immediately after enrichment, writes
 *    the enrichment telemetry row with verdict=null (telemetry-only).
 * 2. recordVerdict() — called later when the user accepts/rejects/revises,
 *    updates the row with the verdict and correction data.
 *
 * This mirrors KomatikSessionWriter's pattern: same KomatikWriteClient,
 * same PostgREST-compatible interface, zero extra dependencies.
 */
export class KomatikOutcomeWriter implements OutcomeWriter {
  private readonly client: KomatikWriteClient;
  private readonly userId: string;

  constructor(client: KomatikWriteClient, userId: string) {
    this.client = client;
    this.userId = userId;
  }

  async writeEnrichmentRecord(
    enrichmentId: string,
    enriched: EnrichedPrompt,
    extra?: {
      platform?: string;
      sessionId?: string;
      modelUsed?: string;
      workspaceId?: string;
    },
  ): Promise<void> {
    const meta = enriched.metadata;

    const row: Record<string, unknown> = {
      id: enrichmentId,
      user_id: this.userId,
      enrichment_id: enrichmentId,
      original_message: enriched.originalMessage,
      enriched_message: enriched.enrichedMessage,
      strategy_used: meta.strategyUsed,
      enrichment_depth: meta.enrichmentDepth,
      verdict: null,
      assumptions_accepted: [],
      assumptions_corrected: [],
      correction_details: {},
      platform: extra?.platform ?? meta.targetPlatform,
      session_id: extra?.sessionId ?? null,
      processing_time_ms: meta.processingTimeMs,
      context_layer_count: enriched.context.length,
      assumption_count: enriched.assumptions.length,
      gap_count: enriched.gaps.length,
      model_used: extra?.modelUsed ?? meta.modelRecommendation?.recommended.model ?? null,
      had_mutations: false,
      tool_calls: 0,
      workspace_id: extra?.workspaceId ?? null,
    };

    const { error } = await this.client.from("enrichment_outcomes").insert(row);

    if (error) {
      throw new Error(`KomatikOutcomeWriter.writeEnrichmentRecord failed: ${error.message}`);
    }
  }

  async recordVerdict(input: OutcomeVerdictInput): Promise<void> {
    const updatePayload: Record<string, unknown> = {
      verdict: input.verdict,
      assumptions_accepted: input.assumptionsAccepted ?? [],
      assumptions_corrected: input.assumptionsCorrected ?? [],
      correction_details: input.correctionDetails ?? {},
    };

    if (input.verdict === "revised") {
      updatePayload.had_mutations = true;
    }

    const { error } = await this.client
      .from("enrichment_outcomes")
      .update(updatePayload)
      .eq("id", input.enrichmentId)
      .eq("user_id", this.userId);

    if (error) {
      throw new Error(`KomatikOutcomeWriter.recordVerdict failed: ${error.message}`);
    }
  }
}
