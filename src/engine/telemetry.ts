import type {
  EnrichedPrompt,
  GovernancePreset,
  ProcessResult,
  TargetPlatform,
  TelemetryEmitter,
  TelemetrySpan,
  TelemetrySpanEvent,
} from "../types.js";

/**
 * Maps Slipstream metadata to an OTel-GenAI-shaped `TelemetrySpan`.
 *
 * Attribute naming follows the OpenTelemetry GenAI semantic conventions
 * (https://opentelemetry.io/docs/specs/semconv/gen-ai/) where applicable,
 * with Slipstream-specific attributes namespaced under `slipstream.*`.
 *
 * The mapping is deliberately one-way and pure — no I/O, no allocations
 * beyond the span object. Consumers' `TelemetryEmitter` implementations
 * decide where the span goes.
 */
export function buildEnrichSpan(args: {
  result: EnrichedPrompt;
  startedAt: number;
  endedAt: number;
  preset: GovernancePreset;
  platform: TargetPlatform;
  userId?: string;
  sessionId?: string | null;
  status?: "ok" | "error";
  error?: { message: string; type?: string };
}): TelemetrySpan {
  const { result, startedAt, endedAt, preset, platform, userId, sessionId, status, error } = args;
  const meta = result.metadata;

  const attributes: Record<string, string | number | boolean> = {
    // OTel GenAI conventions
    "gen_ai.system": "slipstream",
    "gen_ai.operation.name": "enrich",
    "gen_ai.request.model": "n/a", // enrich() doesn't call a model
    // Slipstream-specific
    "slipstream.enrichment_id": meta.enrichmentId,
    "slipstream.enrichment_depth": meta.enrichmentDepth,
    "slipstream.strategy": meta.strategyUsed,
    "slipstream.target_platform": platform,
    "slipstream.preset": preset,
    "slipstream.processing_time_ms": Math.round(meta.processingTimeMs),
    "slipstream.assumption_count": result.assumptions.length,
    "slipstream.gap_count": result.gaps.length,
    "slipstream.clarification_count": result.clarifications.length,
    "slipstream.context_layer_count": result.context.length,
  };

  if (userId) attributes["slipstream.user_id"] = userId;
  if (sessionId) attributes["slipstream.session_id"] = sessionId;

  if (meta.tokens) {
    attributes["gen_ai.usage.input_tokens"] = meta.tokens.originalMessage;
    attributes["gen_ai.usage.output_tokens"] = meta.tokens.enrichedMessage;
    attributes["slipstream.token_overhead"] = meta.tokens.overhead;
    attributes["slipstream.context_tokens"] = meta.tokens.context;
  }

  if (meta.tierRecommendation) {
    attributes["slipstream.tier_recommended"] = meta.tierRecommendation.tier;
    attributes["slipstream.tier_confidence"] = Number(meta.tierRecommendation.confidence.toFixed(3));
    if (meta.tierRecommendation.biasAdjustment) {
      attributes["slipstream.tier_bias_applied"] = true;
      attributes["slipstream.tier_bias_reason"] = meta.tierRecommendation.biasAdjustment.appliedReason;
      attributes["slipstream.tier_bias_original"] = meta.tierRecommendation.biasAdjustment.originalTier;
    } else {
      attributes["slipstream.tier_bias_applied"] = false;
    }
  }

  if (meta.degradation) {
    attributes["slipstream.degraded"] = true;
    attributes["slipstream.failed_adapter_count"] = meta.degradation.failedAdapters;
    attributes["slipstream.timed_out_adapter_count"] = meta.degradation.timedOutAdapters;
    attributes["slipstream.no_context_harvested"] = meta.degradation.noContextHarvested;
    if (meta.degradation.failedAdapterNames.length > 0) {
      attributes["slipstream.failed_adapters"] = meta.degradation.failedAdapterNames.join(",");
    }
    if (meta.degradation.modelRouterDegraded !== undefined) {
      attributes["slipstream.model_router_degraded"] = meta.degradation.modelRouterDegraded;
    }
  } else {
    attributes["slipstream.degraded"] = false;
  }

  if (meta.governance) {
    attributes["slipstream.governance_interventions"] = meta.governance.interventions.length;
    attributes["slipstream.context_layers_before"] = meta.governance.contextLayersBefore;
    attributes["slipstream.context_layers_after"] = meta.governance.contextLayersAfter;
    attributes["slipstream.assumptions_before"] = meta.governance.assumptionsBefore;
    attributes["slipstream.assumptions_after"] = meta.governance.assumptionsAfter;
  }

  if (meta.preflight) {
    attributes["slipstream.preflight_corrections"] = meta.preflight.corrections.length;
    attributes["slipstream.preflight_cascade_risk"] = meta.preflight.cascadeRisk.level;
    attributes["slipstream.preflight_contradictions"] = meta.preflight.contradictions.length;
    attributes["slipstream.preflight_blocking_clarification"] =
      meta.preflight.blockingClarificationNeeded;
  }

  if (meta.budget) {
    attributes["slipstream.budget_utilization"] = Number(meta.budget.utilization.toFixed(3));
    attributes["slipstream.budget_pressure"] = meta.budget.pressure;
    attributes["slipstream.budget_trend"] = meta.budget.trend;
  }

  // Intent signal — useful for downstream segmentation
  attributes["slipstream.intent_action"] = result.intent.action;
  attributes["slipstream.intent_specificity"] = result.intent.specificity;
  attributes["slipstream.intent_scope"] = result.intent.scope;
  attributes["slipstream.intent_emotional_load"] = result.intent.emotionalLoad;
  attributes["slipstream.intent_confidence"] = Number(result.intent.confidence.toFixed(3));

  // Per-adapter events
  const events: TelemetrySpanEvent[] = [];
  if (meta.adapterResults) {
    for (const [name, res] of Object.entries(meta.adapterResults)) {
      events.push({
        name: "adapter.completed",
        at: endedAt,
        attributes: {
          "slipstream.adapter.name": name,
          "slipstream.adapter.status": res.status,
          "slipstream.adapter.layer_count": res.layerCount,
          ...(res.error ? { "slipstream.adapter.error": res.error } : {}),
        },
      });
    }
  }

  return {
    name: "slipstream.enrich",
    startedAt,
    endedAt,
    durationMs: Number((endedAt - startedAt).toFixed(2)),
    attributes,
    events: events.length > 0 ? events : undefined,
    status: status ?? "ok",
    error,
  };
}

/**
 * Span for `Slipstream.process()` calls. Builds on the enrich span and
 * adds model-routing + caller attributes.
 */
export function buildProcessSpan(args: {
  result: ProcessResult;
  startedAt: number;
  endedAt: number;
  preset: GovernancePreset;
  platform: TargetPlatform;
  userId?: string;
  sessionId?: string | null;
  status?: "ok" | "error";
  error?: { message: string; type?: string };
}): TelemetrySpan {
  const { result, startedAt, endedAt, preset, platform, userId, sessionId, status, error } = args;
  const span = buildEnrichSpan({
    result: result.enrichedPrompt,
    startedAt,
    endedAt,
    preset,
    platform,
    userId,
    sessionId,
    status,
    error,
  });

  // Override operation name + add model-routing attributes
  span.name = "slipstream.process";
  span.attributes["gen_ai.operation.name"] = "process";
  span.attributes["gen_ai.request.model"] = result.modelResponse.model;
  span.attributes["gen_ai.response.model"] = result.modelResponse.model;
  span.attributes["gen_ai.system"] = result.modelResponse.provider;
  // Real model latency vs total
  span.attributes["slipstream.model_latency_ms"] = result.modelResponse.latencyMs;
  span.attributes["slipstream.model_input_tokens"] = result.modelResponse.inputTokens;
  span.attributes["slipstream.model_output_tokens"] = result.modelResponse.outputTokens;
  // Recommendation + confidence (in addition to enrichment-level tier_recommended)
  span.attributes["slipstream.model_recommended"] = result.modelRecommendation.recommended.model;
  span.attributes["slipstream.model_recommendation_confidence"] = Number(
    result.modelRecommendation.confidence.toFixed(3),
  );
  span.attributes["slipstream.model_domain"] = result.modelRecommendation.domain;

  return span;
}

/**
 * Best-effort emit. Wraps the caller's `TelemetryEmitter` so a throwing
 * emitter never breaks the enrichment path. Errors are swallowed (with
 * an optional debug log via `onEmitError`).
 */
export async function safelyEmit(
  emitter: TelemetryEmitter | undefined,
  span: TelemetrySpan,
  onEmitError?: (err: unknown) => void,
): Promise<void> {
  if (!emitter) return;
  try {
    await emitter.emit(span);
  } catch (err) {
    onEmitError?.(err);
  }
}
