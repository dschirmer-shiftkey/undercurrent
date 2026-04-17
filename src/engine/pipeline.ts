import type {
  Assumption,
  ContextAdapter,
  ContextLayer,
  ConversationTurn,
  EnrichedPrompt,
  EnrichmentMetadata,
  EnrichmentStrategy,
  Gap,
  GapResolution,
  IntentSignal,
  ModelCallerFn,
  ModelRecommendation,
  ModelRouterConfig,
  PipelineHooks,
  ProcessResult,
  SessionHealth,
  TargetPlatform,
  UndercurrentConfig,
} from "../types.js";
import { Checkpointer } from "./checkpointer.js";
import { Compactor } from "./compactor.js";
import { ModelRouter } from "./model-router.js";
import { KomatikModelUsageAdapter } from "../komatik/model-usage-adapter.js";
import { SessionMonitor } from "./session-monitor.js";

const PIPELINE_VERSION = "0.1.0";

type EnrichmentDepth = EnrichmentMetadata["enrichmentDepth"];

export interface EnrichInput {
  message: string;
  conversation?: ConversationTurn[];
  enrichmentContext?: Record<string, unknown>;
  targetPlatform?: TargetPlatform;
}

export class Pipeline {
  private readonly adapters: ContextAdapter[];
  private readonly strategy: EnrichmentStrategy;
  private readonly maxClarifications: number;
  private readonly confidenceThreshold: number;
  private readonly timeoutMs: number;
  private readonly defaultPlatform: TargetPlatform;
  private readonly debug: boolean;
  private readonly onEnrichment?: (result: EnrichedPrompt) => void;
  private hooks: PipelineHooks = {};
  private readonly monitor: SessionMonitor | null;
  private readonly checkpointer: Checkpointer | null;
  private readonly modelRouter: ModelRouter | null;
  private readonly modelRouterConfig: ModelRouterConfig | null;
  private readonly modelUsageAdapter: KomatikModelUsageAdapter | null;
  private lastContext: ContextLayer[] = [];

  constructor(config: UndercurrentConfig) {
    this.adapters = [...config.adapters].sort((a, b) => a.priority - b.priority);
    this.strategy = config.strategy;
    this.maxClarifications = config.maxClarifications ?? 2;
    this.confidenceThreshold = config.assumptionConfidenceThreshold ?? 0.6;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.defaultPlatform = config.targetPlatform ?? "generic";
    this.debug = config.debug ?? false;
    this.onEnrichment = config.onEnrichment;

    if (config.sessionMonitor) {
      this.monitor = new SessionMonitor(config.sessionMonitor);
      const compactor = new Compactor({
        llmCall: config.sessionMonitor.compactorLlmCall,
      });

      if (config.sessionMonitor.writer) {
        this.checkpointer = new Checkpointer({
          writer: config.sessionMonitor.writer,
          compactor,
          userId: config.sessionMonitor.userId ?? "anonymous",
        });
      } else {
        this.checkpointer = null;
      }
    } else {
      this.monitor = null;
      this.checkpointer = null;
    }

    if (config.modelRouter?.enabled) {
      this.modelRouterConfig = config.modelRouter;
      this.modelRouter = new ModelRouter(
        config.modelRouter.scoringWeights,
        config.modelRouter.defaultProvider,
      );
      this.modelUsageAdapter = new KomatikModelUsageAdapter({
        client: config.modelRouter.client,
        userId: config.modelRouter.userId,
      });
    } else {
      this.modelRouterConfig = null;
      this.modelRouter = null;
      this.modelUsageAdapter = null;
    }
  }

  setHooks(hooks: PipelineHooks): void {
    this.hooks = hooks;
  }

  getSessionHealth(): SessionHealth | null {
    return this.monitor?.getHealth() ?? null;
  }

  getSessionId(): string | null {
    return this.monitor?.getSessionId() ?? null;
  }

  async enrich(input: EnrichInput): Promise<EnrichedPrompt> {
    const start = performance.now();
    const conversation = input.conversation ?? [];
    const adapterTimings: Record<string, number> = {};
    const platform = input.targetPlatform ?? this.defaultPlatform;

    // ── Session Lifecycle: Cold-Start Restoration ────────────────────────
    let restoredLayers: ContextLayer[] = [];
    if (this.monitor && this.checkpointer && conversation.length === 0) {
      try {
        restoredLayers = await this.checkpointer.restoreFromSnapshot();
        this.log("cold-start restoration", restoredLayers.length, "layers");
      } catch {
        this.log("cold-start restoration failed, continuing without");
      }
    }

    // ── Stage 1: Intent Classification ───────────────────────────────────
    this.hooks.beforeClassify?.(input.message);
    const intent = await this.withTimeout(
      this.strategy.classifyIntent(input.message, conversation),
      "classifyIntent",
    );
    this.hooks.afterClassify?.(intent);
    this.log("intent", intent);

    const depth = this.determineDepth(intent);

    if (depth === "none") {
      const result = this.passthrough(input.message, intent, start, platform);
      this.trackSession(input.message, conversation, result.enrichedMessage);
      return result;
    }

    // ── Stage 2: Context Harvesting ──────────────────────────────────────
    this.hooks.beforeGather?.(intent);
    const harvested = await this.harvestContext(
      input.message,
      intent,
      conversation,
      adapterTimings,
      input.enrichmentContext,
    );
    const context = [...restoredLayers, ...harvested];
    this.hooks.afterGather?.(context);
    this.log("context layers", context.length);

    // ── Stage 3: Gap Analysis ────────────────────────────────────────────
    const rawGaps = await this.withTimeout(
      this.strategy.analyzeGaps(intent, context, input.message),
      "analyzeGaps",
    );
    this.hooks.beforeAnalyze?.(rawGaps);

    const resolvedGaps = await this.resolveGaps(rawGaps, context);
    this.hooks.afterAnalyze?.(resolvedGaps);
    this.log("gaps", { total: rawGaps.length, resolved: resolvedGaps.length });

    const assumptions = this.extractAssumptions(resolvedGaps);
    const clarifications = this.extractClarifications(resolvedGaps);

    // ── Stage 4: Enrichment Composition ──────────────────────────────────
    this.hooks.beforeCompose?.({
      message: input.message,
      intent,
      context,
    });

    const enrichedMessage = await this.withTimeout(
      this.strategy.compose(input.message, intent, context, assumptions, resolvedGaps),
      "compose",
    );

    const result: EnrichedPrompt = {
      originalMessage: input.message,
      intent,
      context,
      gaps: resolvedGaps,
      assumptions,
      clarifications: clarifications.slice(0, this.maxClarifications),
      enrichedMessage,
      metadata: {
        pipelineVersion: PIPELINE_VERSION,
        enrichmentDepth: depth,
        processingTimeMs: performance.now() - start,
        adapterTimings,
        strategyUsed: this.strategy.name,
        targetPlatform: platform,
      },
    };

    this.hooks.afterCompose?.(result);
    this.onEnrichment?.(result);

    // ── Session Lifecycle: Track + Checkpoint ────────────────────────────
    this.lastContext = context;
    this.trackSession(input.message, conversation, enrichedMessage);
    await this.maybeCheckpoint(conversation);

    return result;
  }

  async process(input: EnrichInput): Promise<ProcessResult> {
    if (!this.modelRouter || !this.modelRouterConfig || !this.modelUsageAdapter) {
      throw new Error("Undercurrent: process() requires modelRouter to be configured and enabled.");
    }

    const enrichedPrompt = await this.enrich(input);
    const recommendation = await this.routeModel(enrichedPrompt.intent);

    enrichedPrompt.metadata.modelRecommendation = recommendation;
    this.modelRouterConfig.onModelSelected?.(recommendation);

    const caller: ModelCallerFn = this.modelRouterConfig.caller;
    const modelResponse = await caller({
      model: recommendation.recommended.model,
      provider: recommendation.recommended.provider,
      messages: input.conversation ?? [],
      enrichedSystemPrompt: enrichedPrompt.enrichedMessage,
    });

    return { enrichedPrompt, modelRecommendation: recommendation, modelResponse };
  }

  private async routeModel(intent: IntentSignal): Promise<ModelRecommendation> {
    if (!this.modelRouter || !this.modelUsageAdapter) {
      throw new Error("Undercurrent: model routing not configured.");
    }

    const scoringData = await this.modelUsageAdapter.loadScoringData();
    return this.modelRouter.recommend(intent, scoringData);
  }

  private trackSession(
    message: string,
    conversation: ConversationTurn[],
    enrichedMessage: string,
  ): void {
    if (!this.monitor) return;
    const health = this.monitor.track(message, conversation, enrichedMessage);
    this.log("session health", health, this.monitor.getState().estimatedTokens, "tokens");
  }

  private async maybeCheckpoint(conversation: ConversationTurn[]): Promise<void> {
    if (!this.monitor || !this.checkpointer) return;

    const health = this.monitor.getHealth();

    if (health === "critical" || health === "degrading") {
      try {
        const compaction = await this.checkpointer.compactAndCheckpoint(
          this.monitor,
          conversation,
          this.lastContext,
        );
        this.monitor.resetAfterCompaction(
          compaction.recentExchanges.reduce((sum, t) => sum + Math.ceil(t.content.length / 4), 0),
        );
        this.log("session compacted, saved ~", compaction.estimatedTokensSaved, "tokens");
      } catch {
        this.log("compaction failed, continuing");
      }
      return;
    }

    if (this.monitor.needsCheckpoint()) {
      try {
        await this.checkpointer.checkpoint(this.monitor, conversation);
        this.log("checkpoint saved");
      } catch {
        this.log("checkpoint failed, continuing");
      }
    }
  }

  /**
   * Graduated scope calibration. Instead of a binary passthrough decision,
   * computes a depth score from multiple signals and maps it to a spectrum:
   *
   *   Score <= 1  → none (passthrough, zero enrichment overhead)
   *   Score 2-3   → light (identity + preferences only, skip gap analysis)
   *   Score 4-6   → standard (full pipeline with harvesting + gaps)
   *   Score >= 7   → deep (all adapters, proactive context loading)
   *
   * Signals: specificity, scope, action complexity, emotional load,
   * conversation length, and whether enrichment context hints are present.
   */
  private determineDepth(intent: IntentSignal): EnrichmentDepth {
    let score = 0;

    const specificityScores: Record<string, number> = {
      high: 0,
      medium: 3,
      low: 5,
    };
    score += specificityScores[intent.specificity] ?? 3;

    const scopeScores: Record<string, number> = {
      atomic: 0,
      local: 1,
      product: 2,
      "cross-system": 3,
      meta: 2,
      unknown: 3,
    };
    score += scopeScores[intent.scope] ?? 2;

    const actionComplexity: Record<string, number> = {
      build: 2,
      design: 2,
      fix: 1,
      decide: 2,
      explore: 0,
      discuss: 1,
      vent: 0,
      unknown: 1,
    };
    score += actionComplexity[intent.action] ?? 1;

    if (intent.emotionalLoad === "frustrated" || intent.emotionalLoad === "uncertain") {
      score += 1;
    }

    if (intent.confidence < 0.5) {
      score += 1;
    }

    if (score <= 1) return "none";
    if (score <= 3) return "light";
    if (score <= 6) return "standard";
    return "deep";
  }

  private passthrough(
    message: string,
    intent: IntentSignal,
    startTime: number,
    platform: TargetPlatform,
  ): EnrichedPrompt {
    return {
      originalMessage: message,
      intent,
      context: [],
      gaps: [],
      assumptions: [],
      clarifications: [],
      enrichedMessage: message,
      metadata: {
        pipelineVersion: PIPELINE_VERSION,
        enrichmentDepth: "none",
        processingTimeMs: performance.now() - startTime,
        adapterTimings: {},
        strategyUsed: this.strategy.name,
        targetPlatform: platform,
      },
    };
  }

  private async harvestContext(
    message: string,
    intent: IntentSignal,
    conversation: ConversationTurn[],
    timings: Record<string, number>,
    enrichmentContext?: Record<string, unknown>,
  ): Promise<ContextLayer[]> {
    const available = await Promise.all(
      this.adapters.map(async (adapter) => {
        try {
          const ok = await adapter.available();
          return ok ? adapter : null;
        } catch {
          this.log(`adapter ${adapter.name} availability check failed`);
          return null;
        }
      }),
    );

    const activeAdapters = available.filter((a): a is ContextAdapter => a !== null);

    const adapterInput = {
      message,
      intent,
      conversation,
      existingContext: [] as ContextLayer[],
      enrichmentContext,
    };

    const results = await Promise.allSettled(
      activeAdapters.map(async (adapter) => {
        const adapterStart = performance.now();
        try {
          const layers = await this.withTimeout(
            adapter.gather(adapterInput),
            `adapter:${adapter.name}`,
          );
          timings[adapter.name] = performance.now() - adapterStart;
          return layers;
        } catch (err) {
          timings[adapter.name] = performance.now() - adapterStart;
          this.log(`adapter ${adapter.name} failed`, err);
          return [] as ContextLayer[];
        }
      }),
    );

    return results
      .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
      .sort((a, b) => a.priority - b.priority);
  }

  private async resolveGaps(gaps: Gap[], context: ContextLayer[]): Promise<Gap[]> {
    return Promise.all(
      gaps.map(async (gap) => {
        if (gap.resolution) return gap;
        try {
          const resolution = await this.strategy.resolveGap(gap, context, this.confidenceThreshold);
          return { ...gap, resolution };
        } catch {
          return gap;
        }
      }),
    );
  }

  private extractAssumptions(gaps: Gap[]): Assumption[] {
    return gaps
      .filter(
        (g): g is Gap & { resolution: { type: "assumed" } } => g.resolution?.type === "assumed",
      )
      .map((g) => (g.resolution as { type: "assumed"; assumption: Assumption }).assumption);
  }

  private extractClarifications(gaps: Gap[]) {
    return gaps
      .filter((g) => g.resolution?.type === "needs-clarification")
      .map(
        (g) =>
          (g.resolution as Extract<GapResolution, { type: "needs-clarification" }>).clarification,
      );
  }

  private async withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Undercurrent timeout: ${label} exceeded ${this.timeoutMs}ms`)),
          this.timeoutMs,
        ),
      ),
    ]);
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log("[undercurrent]", ...args);
    }
  }
}
