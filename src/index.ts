import { Pipeline } from "./engine/pipeline.js";
import type { EnrichInput } from "./engine/pipeline.js";
import { createFetchHandler, createMiddleware } from "./transports/middleware.js";
import type { MiddlewareOptions } from "./transports/middleware.js";
import type {
  ContextAdapter,
  EnrichedPrompt,
  EnrichmentStrategy,
  PipelineHooks,
  ProcessResult,
  SessionHealth,
  UndercurrentConfig,
} from "./types.js";

export class Undercurrent {
  private readonly pipeline: Pipeline;
  private readonly config: UndercurrentConfig;

  constructor(config: UndercurrentConfig) {
    this.config = config;
    this.pipeline = new Pipeline(config);
  }

  async enrich(input: EnrichInput): Promise<EnrichedPrompt> {
    return this.pipeline.enrich(input);
  }

  async process(input: EnrichInput): Promise<ProcessResult> {
    return this.pipeline.process(input);
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
  Scope,
  ScoringWeights,
  SessionHealth,
  SessionMemoryInput,
  SessionMonitorConfig,
  SessionSnapshot,
  SessionState,
  SessionWriter,
  Specificity,
  TaskDomain,
  TargetPlatform,
  UndercurrentConfig,
} from "./types.js";
