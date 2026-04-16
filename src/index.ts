import { Pipeline } from "./engine/pipeline.js";
import type { EnrichInput } from "./engine/pipeline.js";
import { createFetchHandler, createMiddleware } from "./transports/middleware.js";
import type { MiddlewareOptions } from "./transports/middleware.js";
import type {
  ContextAdapter,
  EnrichedPrompt,
  EnrichmentStrategy,
  PipelineHooks,
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
}

export { Pipeline } from "./engine/pipeline.js";
export type { EnrichInput } from "./engine/pipeline.js";

export type {
  Action,
  AdapterInput,
  Assumption,
  Clarification,
  ClarificationOption,
  ContextAdapter,
  ContextLayer,
  ConversationTurn,
  EmotionalLoad,
  EnrichedPrompt,
  EnrichmentMetadata,
  EnrichmentStrategy,
  Gap,
  GapResolution,
  IntentSignal,
  PipelineHooks,
  Scope,
  Specificity,
  TargetPlatform,
  UndercurrentConfig,
} from "./types.js";
