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
  MemoryGovernancePolicy,
  PipelineHooks,
  ProcessResult,
  SessionHealth,
  SuggestionFeedback,
  SuggestionInput,
  SuggestionResult,
  UndercurrentConfig,
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
  },
  balanced: {
    preset: "balanced",
    maxContextAgeMs: 72 * 60 * 60 * 1000,
    criticalAssumptionMinConfidence: 0.7,
    assumptionMinConfidence: 0.62,
    blockLowConfidenceAssumptions: true,
    dropStaleContext: true,
    maxAssumptionsPerMessage: 3,
  },
  "speed-first": {
    preset: "speed-first",
    maxContextAgeMs: 7 * 24 * 60 * 60 * 1000,
    criticalAssumptionMinConfidence: 0.6,
    assumptionMinConfidence: 0.5,
    blockLowConfidenceAssumptions: false,
    dropStaleContext: false,
    maxAssumptionsPerMessage: 5,
  },
};

export function withPreset(
  config: UndercurrentConfig,
  preset: GovernancePreset,
  governanceOverrides?: Partial<MemoryGovernancePolicy>,
): UndercurrentConfig {
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

export class Undercurrent {
  private readonly pipeline: Pipeline;
  private readonly config: UndercurrentConfig;
  private readonly suggester: Suggester;

  constructor(config: UndercurrentConfig) {
    this.config = config;
    this.pipeline = new Pipeline(config);
    this.suggester = new Suggester({
      config: config.suggestions,
      strategy: config.strategy,
    });
  }

  async enrich(input: EnrichInput): Promise<EnrichedPrompt> {
    return this.pipeline.enrich(input);
  }

  async process(input: EnrichInput): Promise<ProcessResult> {
    return this.pipeline.process(input);
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
}

export { Pipeline } from "./engine/pipeline.js";
export type { EnrichInput } from "./engine/pipeline.js";
export { SessionMonitor, estimateTokens } from "./engine/session-monitor.js";
export { Compactor } from "./engine/compactor.js";
export { Checkpointer } from "./engine/checkpointer.js";
export { ModelRouter, TaskDomainClassifier, ModelScorer } from "./engine/model-router.js";
export { Suggester } from "./engine/suggester.js";
export { analyzeResponse } from "./engine/response-signals.js";
export { KomatikPilotProcessor } from "./komatik/pilot.js";

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
  TaskDomain,
  TargetPlatform,
  UndercurrentConfig,
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
