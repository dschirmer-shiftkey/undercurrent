import { Pipeline } from "./engine/pipeline.js";
import type { EnrichInput } from "./engine/pipeline.js";
import { Suggester } from "./engine/suggester.js";
import { createFetchHandler, createMiddleware } from "./transports/middleware.js";
import type { MiddlewareOptions } from "./transports/middleware.js";
import type {
  ContextAdapter,
  EnrichedPrompt,
  EnrichmentStrategy,
  GovernancePreset,
  HealthCheckResult,
  MemoryGovernancePolicy,
  PipelineHooks,
  ProcessResult,
  SessionHealth,
  SuggestionFeedback,
  SuggestionInput,
  SuggestionResult,
  SlipstreamConfig,
} from "./types.js";

export const UNDERCURRENT_PRESETS: Record<GovernancePreset, Partial<MemoryGovernancePolicy>> = {
  "strict-governance": {
    preset: "strict-governance",
    maxContextAgeMs: 24 * 60 * 60 * 1000,
    criticalAssumptionMinConfidence: 0.8,
    assumptionMinConfidence: 0.72,
    blockLowConfidenceAssumptions: true,
    dropStaleContext: true,
    maxAssumptionsPerMessage: 2,
    preflight: {
      enabled: false,
      silentCorrectionsEnabled: true,
      blockOnCascadeRisk: "none",
      maxCorrectionsPerMessage: 5,
    },
  },
  balanced: {
    preset: "balanced",
    maxContextAgeMs: 72 * 60 * 60 * 1000,
    criticalAssumptionMinConfidence: 0.7,
    assumptionMinConfidence: 0.62,
    blockLowConfidenceAssumptions: true,
    dropStaleContext: true,
    maxAssumptionsPerMessage: 3,
    preflight: {
      enabled: false,
      silentCorrectionsEnabled: true,
      blockOnCascadeRisk: "none",
      maxCorrectionsPerMessage: 5,
    },
  },
  "speed-first": {
    preset: "speed-first",
    maxContextAgeMs: 7 * 24 * 60 * 60 * 1000,
    criticalAssumptionMinConfidence: 0.6,
    assumptionMinConfidence: 0.5,
    blockLowConfidenceAssumptions: false,
    dropStaleContext: false,
    maxAssumptionsPerMessage: 5,
    preflight: {
      enabled: false,
      silentCorrectionsEnabled: true,
      blockOnCascadeRisk: "none",
      maxCorrectionsPerMessage: 5,
    },
  },
  "safety-first": {
    preset: "safety-first",
    maxContextAgeMs: 24 * 60 * 60 * 1000,
    criticalAssumptionMinConfidence: 0.84,
    assumptionMinConfidence: 0.76,
    blockLowConfidenceAssumptions: true,
    dropStaleContext: true,
    maxAssumptionsPerMessage: 2,
    preflight: {
      enabled: true,
      silentCorrectionsEnabled: true,
      blockOnCascadeRisk: "high",
      maxCorrectionsPerMessage: 5,
    },
  },
};

export function withPreset(
  config: SlipstreamConfig,
  preset: GovernancePreset,
  governanceOverrides?: Partial<MemoryGovernancePolicy>,
): SlipstreamConfig {
  return {
    ...config,
    preset,
    governance: {
      ...UNDERCURRENT_PRESETS[preset],
      ...(config.governance ?? {}),
      ...(governanceOverrides ?? {}),
    },
  };
}

export class Slipstream {
  private readonly pipeline: Pipeline;
  private readonly config: SlipstreamConfig;
  private readonly suggester: Suggester;

  constructor(config: SlipstreamConfig) {
    this.config = config;
    this.pipeline = new Pipeline(config);
    this.suggester = new Suggester({
      config: config.suggestions,
      strategy: config.strategy,
    });
  }

  async enrich(input: EnrichInput): Promise<EnrichedPrompt> {
    const result = await this.pipeline.enrich(input);
    await this.persistOutcome(result);
    return result;
  }

  async process(input: EnrichInput): Promise<ProcessResult> {
    return this.pipeline.process(input);
  }

  /**
   * Record a user verdict for a previous enrichment.
   * Requires outcomeWriter to be configured.
   */
  async recordVerdict(input: {
    enrichmentId: string;
    verdict: "accepted" | "rejected" | "revised" | "ignored";
    assumptionsAccepted?: string[];
    assumptionsCorrected?: string[];
    correctionDetails?: Record<string, unknown>;
  }): Promise<void> {
    const ow = this.config.outcomeWriter;
    if (!ow) return;
    await ow.writer.recordVerdict(input);
  }

  private async persistOutcome(result: EnrichedPrompt): Promise<void> {
    const ow = this.config.outcomeWriter;
    if (!ow) return;
    try {
      await ow.writer.writeEnrichmentRecord(
        result.metadata.enrichmentId,
        result,
        {
          sessionId: ow.sessionId,
          workspaceId: ow.workspaceId,
        },
      );
    } catch {
      // Non-fatal — enrichment telemetry loss is acceptable
    }
  }

  async suggestFollowups(input: SuggestionInput): Promise<SuggestionResult> {
    return this.suggester.suggest(input);
  }

  async recordSuggestionFeedback(feedback: SuggestionFeedback): Promise<void> {
    return this.suggester.recordFeedback(feedback);
  }

  setHooks(hooks: PipelineHooks): void {
    this.pipeline.setHooks(hooks);
  }

  middleware(options?: MiddlewareOptions) {
    return createMiddleware(this.pipeline, options);
  }

  fetchHandler() {
    return createFetchHandler(this.pipeline);
  }

  get adapters(): readonly ContextAdapter[] {
    return this.config.adapters;
  }

  get strategy(): EnrichmentStrategy {
    return this.config.strategy;
  }

  get sessionHealth(): SessionHealth | null {
    return this.pipeline.getSessionHealth();
  }

  get sessionId(): string | null {
    return this.pipeline.getSessionId();
  }

  /**
   * Lightweight pre-flight check for backend health. Calls each adapter's
   * `available()` and, when a model router is configured, attempts a one-
   * shot scoring-data load. Aggregates into a single `HealthCheckResult`
   * the host can use to decide whether to enable Slipstream for this
   * session.
   *
   * Total cost is bounded by the per-adapter timeout (defaults to the
   * pipeline timeout). Failing checks never throw — they're reported as
   * `status: "error"` in the per-adapter health entry.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    return this.pipeline.healthCheck();
  }
}

export { Pipeline, recommendTier } from "./engine/pipeline.js";
export type { EnrichInput } from "./engine/pipeline.js";
export { SessionMonitor, estimateTokens } from "./engine/session-monitor.js";
export { Compactor } from "./engine/compactor.js";
export { Checkpointer } from "./engine/checkpointer.js";
export { ModelRouter, TaskDomainClassifier, ModelScorer } from "./engine/model-router.js";
export { Suggester } from "./engine/suggester.js";
export { analyzeResponse } from "./engine/response-signals.js";
export { KomatikPilotProcessor } from "./komatik/pilot.js";
export { KomatikOutcomeWriter } from "./komatik/outcome-writer.js";

export type {
  Action,
  AdapterInput,
  AdapterResult,
  Assumption,
  Clarification,
  ClarificationOption,
  CompactionResult,
  ContextAdapter,
  ContextLayer,
  ConversationTurn,
  DecisionRecord,
  EmotionalLoad,
  EnrichedPrompt,
  EnrichmentMetadata,
  EnrichmentStrategy,
  FollowupCategory,
  FollowupSuggestion,
  GovernanceIntervention,
  GovernancePreset,
  GovernanceSummary,
  Gap,
  GapResolution,
  HandoffArtifact,
  IntentSignal,
  ModelCallerFn,
  ModelCallerInput,
  ModelCallerOutput,
  ModelOption,
  ModelProvider,
  ModelRecommendation,
  ModelRouterConfig,
  PipelineHooks,
  PreflightPolicy,
  PreflightResult,
  ProcessResult,
  ResponseSignals,
  Scope,
  ScoringWeights,
  SessionHealth,
  SessionMemoryInput,
  SessionMonitorConfig,
  SessionSnapshot,
  SessionState,
  SessionWriter,
  Specificity,
  SuggestionFeedback,
  SuggestionInput,
  SuggestionResult,
  SuggestionsConfig,
  MemoryGovernancePolicy,
  EnrichmentTrace,
  EnrichmentTraceEvent,
  TraceStage,
  ObservabilityConfig,
  OutcomeVerdict,
  OutcomeVerdictInput,
  OutcomeWriter,
  OutcomeWriterConfig,
  CascadeRisk,
  CascadeRiskLevel,
  Correction,
  CostTier,
  TierRecommendation,
  DegradationSummary,
  HealthStatus,
  HealthCheckResult,
  AdapterHealth,
  TaskDomain,
  TargetPlatform,
  SlipstreamConfig,
} from "./types.js";

export type {
  PilotProcessResult,
  PilotProcessTelemetry,
  PilotOutcome,
  PilotRequestContext,
  PilotRoiSummary,
  PilotTelemetrySink,
  ProcessInvoker,
} from "./komatik/pilot.js";
