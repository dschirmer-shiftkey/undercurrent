import type {
  AdapterResult,
  Assumption,
  AssumptionProvenance,
  BudgetMeter,
  ContextAdapter,
  ContextLayer,
  ConversationTurn,
  EnrichedPrompt,
  EnrichmentTraceEvent,
  EnrichmentMetadata,
  EnrichmentStrategy,
  Gap,
  GapResolution,
  GovernanceIntervention,
  GovernancePreset,
  GovernanceSummary,
  IntentSignal,
  MemoryGovernancePolicy,
  ModelCallerFn,
  ModelRecommendation,
  ModelRouterConfig,
  PipelineHooks,
  ProcessResult,
  SessionHealth,
  TargetPlatform,
  TokenAccounting,
  UndercurrentConfig,
} from "../types.js";
import { Checkpointer } from "./checkpointer.js";
import { Compactor } from "./compactor.js";
import { ModelRouter } from "./model-router.js";
import { KomatikModelUsageAdapter } from "../komatik/model-usage-adapter.js";
import { SessionMonitor, estimateTokens } from "./session-monitor.js";

const PIPELINE_VERSION = "0.2.0";

type EnrichmentDepth = EnrichmentMetadata["enrichmentDepth"];

export interface EnrichInput {
  message: string;
  conversation?: ConversationTurn[];
  enrichmentContext?: Record<string, unknown>;
  targetPlatform?: TargetPlatform;
  preset?: GovernancePreset;
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
  private readonly recentEnrichmentTokens: number[] = [];
  private readonly defaultPreset: GovernancePreset;
  private readonly governanceOverrides: Partial<MemoryGovernancePolicy>;
  private readonly includeTrace: boolean;
  private readonly maxTraceEvents: number;
  private traceEvents: EnrichmentTraceEvent[] = [];

  constructor(config: UndercurrentConfig) {
    this.adapters = [...config.adapters].sort((a, b) => a.priority - b.priority);
    this.strategy = config.strategy;
    this.maxClarifications = config.maxClarifications ?? 2;
    this.confidenceThreshold = config.assumptionConfidenceThreshold ?? 0.6;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.defaultPlatform = config.targetPlatform ?? "generic";
    this.debug = config.debug ?? false;
    this.onEnrichment = config.onEnrichment;
    this.defaultPreset = config.preset ?? "balanced";
    this.governanceOverrides = config.governance ?? {};
    this.includeTrace = config.observability?.includeTrace ?? true;
    this.maxTraceEvents = config.observability?.maxTraceEvents ?? 64;

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
    const policy = this.resolveGovernancePolicy(input.preset);
    const interventions: GovernanceIntervention[] = [];
    this.resetTrace();

    // ── Session Lifecycle: Cold-Start Restoration ────────────────────────
    let restoredLayers: ContextLayer[] = [];
    if (this.monitor && this.checkpointer && conversation.length === 0) {
      try {
        restoredLayers = await this.checkpointer.restoreFromSnapshot();
        this.log("cold-start restoration", restoredLayers.length, "layers");
        this.pushTrace("gather", "restore_snapshot", "Loaded cold-start snapshot layers.", {
          restoredLayers: restoredLayers.length,
        });
      } catch {
        this.log("cold-start restoration failed, continuing without");
        this.pushTrace(
          "gather",
          "restore_snapshot_failed",
          "Cold-start restoration failed; continuing without snapshot layers.",
        );
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
    this.pushTrace("classify", "intent_classified", "Intent classified for enrichment.", {
      confidence: intent.confidence,
    });

    const depth = this.determineDepth(intent);
    this.pushTrace("classify", "depth_selected", `Selected enrichment depth: ${depth}.`);

    if (depth === "none") {
      const result = this.passthrough(input.message, intent, start, platform, policy.preset);
      this.trackSession(input.message, conversation, result.enrichedMessage);
      return result;
    }

    // ── Stage 2: Context Harvesting ──────────────────────────────────────
    this.hooks.beforeGather?.(intent);
    const { layers: harvested, adapterResults } = await this.harvestContext(
      input.message,
      intent,
      conversation,
      adapterTimings,
      input.enrichmentContext,
    );
    const combinedContext = [...restoredLayers, ...harvested];
    const { layers: context, interventions: contextInterventions } = this.applyContextGovernance(
      combinedContext,
      policy,
    );
    interventions.push(...contextInterventions);
    const governanceSummary: GovernanceSummary = {
      preset: policy.preset,
      contextLayersBefore: combinedContext.length,
      contextLayersAfter: context.length,
      assumptionsBefore: 0,
      assumptionsAfter: 0,
      interventions: [...interventions],
    };
    this.hooks.afterGovernance?.(governanceSummary);
    this.pushTrace(
      "govern",
      "context_governed",
      "Applied context governance policy.",
      {
        before: combinedContext.length,
        after: context.length,
      },
      { preset: policy.preset },
    );
    this.hooks.afterGather?.(context);
    this.log("context layers", context.length);

    // ── Stage 3: Gap Analysis ────────────────────────────────────────────
    const rawGaps = await this.withTimeout(
      this.strategy.analyzeGaps(intent, context, input.message),
      "analyzeGaps",
    );
    this.hooks.beforeAnalyze?.(rawGaps);

    const resolvedGaps = await this.resolveGaps(rawGaps, context);
    const governedGaps = this.applyAssumptionGovernance(resolvedGaps, policy, interventions);
    this.hooks.afterAnalyze?.(governedGaps);
    this.log("gaps", { total: rawGaps.length, resolved: governedGaps.length });
    this.pushTrace("govern", "assumptions_governed", "Applied assumption governance policy.", {
      interventions: interventions.length,
    });

    const assumptions = this.extractAssumptions(governedGaps);
    const clarifications = this.extractClarifications(governedGaps);
    governanceSummary.assumptionsBefore = this.extractAssumptions(resolvedGaps).length;
    governanceSummary.assumptionsAfter = assumptions.length;
    governanceSummary.interventions = [...interventions];
    this.hooks.afterGovernance?.(governanceSummary);

    // ── Stage 4: Enrichment Composition ──────────────────────────────────
    this.hooks.beforeCompose?.({
      message: input.message,
      intent,
      context,
    });

    const enrichedMessage = await this.withTimeout(
      this.strategy.compose(input.message, intent, context, assumptions, governedGaps),
      "compose",
    );
    this.pushTrace("compose", "message_composed", "Generated enriched message.");

    const tokens = this.computeTokens(input.message, enrichedMessage, context);
    this.recordEnrichmentTokens(tokens.enrichedMessage + tokens.context);
    const result: EnrichedPrompt = {
      originalMessage: input.message,
      intent,
      context,
      gaps: governedGaps,
      assumptions,
      clarifications: clarifications.slice(0, this.maxClarifications),
      enrichedMessage,
      metadata: {
        pipelineVersion: PIPELINE_VERSION,
        enrichmentDepth: depth,
        processingTimeMs: performance.now() - start,
        adapterTimings,
        adapterResults,
        strategyUsed: this.strategy.name,
        targetPlatform: platform,
        tokens,
        budget: this.computeBudget(tokens),
        governance: governanceSummary,
        trace: this.includeTrace
          ? { sessionId: this.monitor?.getSessionId(), events: [...this.traceEvents] }
          : undefined,
      },
    };
    this.pushTrace("finalize", "enrichment_complete", "Enrichment pipeline completed.", {
      processingMs: result.metadata.processingTimeMs,
      assumptions: assumptions.length,
      clarifications: clarifications.length,
    });
    if (result.metadata.trace) {
      result.metadata.trace.events = [...this.traceEvents];
    }

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
          compaction.recentExchanges.reduce(
            (sum, t) => sum + estimateTokens(t.content, this.monitor!.model),
            0,
          ),
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
    if (intent.action === "acknowledge" || intent.action === "report") return "none";

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
      acknowledge: 0,
      report: 0,
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
    preset: GovernancePreset,
  ): EnrichedPrompt {
    const tokens = this.computeTokens(message, message, []);
    this.recordEnrichmentTokens(tokens.enrichedMessage);
    this.pushTrace("finalize", "passthrough", "Message passed through without enrichment.");
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
        tokens,
        budget: this.computeBudget(tokens),
        governance: {
          preset,
          contextLayersBefore: 0,
          contextLayersAfter: 0,
          assumptionsBefore: 0,
          assumptionsAfter: 0,
          interventions: [],
        },
        trace: this.includeTrace
          ? { sessionId: this.monitor?.getSessionId(), events: [...this.traceEvents] }
          : undefined,
      },
    };
  }

  private resolveGovernancePolicy(requestPreset?: GovernancePreset): MemoryGovernancePolicy {
    const preset = requestPreset ?? this.defaultPreset;
    const defaultsByPreset: Record<GovernancePreset, MemoryGovernancePolicy> = {
      "strict-governance": {
        preset,
        maxContextAgeMs: 24 * 60 * 60 * 1000,
        criticalAssumptionMinConfidence: 0.8,
        assumptionMinConfidence: 0.72,
        blockLowConfidenceAssumptions: true,
        dropStaleContext: true,
        maxAssumptionsPerMessage: 2,
      },
      balanced: {
        preset,
        maxContextAgeMs: 72 * 60 * 60 * 1000,
        criticalAssumptionMinConfidence: 0.7,
        assumptionMinConfidence: 0.62,
        blockLowConfidenceAssumptions: true,
        dropStaleContext: true,
        maxAssumptionsPerMessage: 3,
      },
      "speed-first": {
        preset,
        maxContextAgeMs: 7 * 24 * 60 * 60 * 1000,
        criticalAssumptionMinConfidence: 0.6,
        assumptionMinConfidence: 0.5,
        blockLowConfidenceAssumptions: false,
        dropStaleContext: false,
        maxAssumptionsPerMessage: 5,
      },
    };
    return { ...defaultsByPreset[preset], ...this.governanceOverrides, preset };
  }

  private applyContextGovernance(
    layers: ContextLayer[],
    policy: MemoryGovernancePolicy,
  ): { layers: ContextLayer[]; interventions: GovernanceIntervention[] } {
    if (!policy.dropStaleContext) {
      return { layers, interventions: [] };
    }
    const now = Date.now();
    const interventions: GovernanceIntervention[] = [];
    const filtered = layers.filter((layer) => {
      const age = now - layer.timestamp;
      const stale = age > policy.maxContextAgeMs;
      if (stale) {
        interventions.push({
          type: "context-filtered",
          reason: `Dropped stale context layer older than ${policy.maxContextAgeMs}ms.`,
          targetId: `${layer.source}:${layer.timestamp}`,
          severity: "info",
        });
      }
      return !stale;
    });
    return { layers: filtered, interventions };
  }

  private applyAssumptionGovernance(
    gaps: Gap[],
    policy: MemoryGovernancePolicy,
    interventions: GovernanceIntervention[],
  ): Gap[] {
    const governed: Gap[] = [];
    const assumedIndexes: number[] = [];

    for (const gap of gaps) {
      if (gap.resolution?.type !== "assumed") {
        governed.push(gap);
        continue;
      }
      const assumption = {
        ...gap.resolution.assumption,
        provenance: this.buildAssumptionProvenance(gap.resolution.assumption),
      };
      const min = gap.critical
        ? policy.criticalAssumptionMinConfidence
        : policy.assumptionMinConfidence;
      if (assumption.confidence < min && policy.blockLowConfidenceAssumptions) {
        interventions.push({
          type: "assumption-blocked",
          reason: `Assumption confidence ${assumption.confidence.toFixed(2)} below threshold ${min.toFixed(2)}.`,
          targetId: gap.id,
          severity: "warn",
        });
        governed.push({
          ...gap,
          resolution: {
            type: "needs-clarification",
            clarification: this.buildClarificationForBlockedAssumption(gap, assumption.confidence),
          },
        });
        continue;
      }
      governed.push({
        ...gap,
        resolution: { ...gap.resolution, assumption },
      });
      assumedIndexes.push(governed.length - 1);
    }

    if (assumedIndexes.length > policy.maxAssumptionsPerMessage) {
      const ranked = assumedIndexes
        .map((idx) => ({
          idx,
          confidence:
            ((governed[idx]!.resolution as Extract<GapResolution, { type: "assumed" }>).assumption
              .confidence ?? 0),
        }))
        .sort((a, b) => b.confidence - a.confidence);
      const keep = new Set(
        ranked.slice(0, policy.maxAssumptionsPerMessage).map((entry) => entry.idx),
      );
      for (const entry of ranked.slice(policy.maxAssumptionsPerMessage)) {
        const gap = governed[entry.idx]!;
        interventions.push({
          type: "assumption-trimmed",
          reason: `Trimmed to maxAssumptionsPerMessage=${policy.maxAssumptionsPerMessage}.`,
          targetId: gap.id,
          severity: "info",
        });
        if (!keep.has(entry.idx)) {
          governed[entry.idx] = {
            ...gap,
            resolution: {
              type: "needs-clarification",
              clarification: this.buildClarificationForBlockedAssumption(gap, entry.confidence),
            },
          };
        }
      }
    }

    return governed;
  }

  private buildAssumptionProvenance(assumption: Assumption): AssumptionProvenance {
    return {
      contextSources: [assumption.source],
      contextLayerCount: 1,
      resolutionType: "inferred",
      generatedAt: Date.now(),
    };
  }

  private buildClarificationForBlockedAssumption(gap: Gap, confidence: number) {
    return {
      id: `clarify-${gap.id}`,
      question: `Need confirmation: ${gap.description}`,
      options: [
        { id: "yes", label: "Yes, that's correct", isDefault: true },
        { id: "no", label: "No, use a different assumption", isDefault: false },
      ],
      allowMultiple: false,
      defaultOptionId: "yes",
      reason: `Assumption confidence too low (${Math.round(confidence * 100)}%).`,
    };
  }

  private resetTrace(): void {
    this.traceEvents = [];
  }

  private pushTrace(
    stage: EnrichmentTraceEvent["stage"],
    event: string,
    detail: string,
    metrics?: Record<string, number>,
    meta?: Record<string, unknown>,
  ): void {
    if (!this.includeTrace) return;
    if (this.traceEvents.length >= this.maxTraceEvents) return;
    this.traceEvents.push({
      at: Date.now(),
      stage,
      event,
      detail,
      metrics,
      meta,
    });
  }

  private recordEnrichmentTokens(total: number): void {
    this.recentEnrichmentTokens.push(total);
    if (this.recentEnrichmentTokens.length > 5) {
      this.recentEnrichmentTokens.shift();
    }
  }

  private computeBudget(tokens: TokenAccounting): BudgetMeter | undefined {
    if (!this.monitor) return undefined;

    const budget = this.monitor.tokenBudget;
    const used = this.monitor.getState().estimatedTokens + tokens.enrichedMessage;
    const utilization = budget > 0 ? Math.min(1, used / budget) : 0;

    let pressure: BudgetMeter["pressure"];
    if (utilization >= 0.85) pressure = "critical";
    else if (utilization >= 0.65) pressure = "high";
    else if (utilization >= 0.4) pressure = "moderate";
    else pressure = "low";

    let trend: BudgetMeter["trend"] = "stable";
    if (this.recentEnrichmentTokens.length >= 3) {
      const window = this.recentEnrichmentTokens.slice(-3);
      const first = window[0]!;
      const last = window[window.length - 1]!;
      if (first > 0) {
        const delta = (last - first) / first;
        if (delta > 0.2) trend = "growing";
        else if (delta < -0.2) trend = "shrinking";
      }
    }

    return {
      used,
      budget,
      available: Math.max(0, budget - used),
      utilization,
      pressure,
      perAdapter: tokens.contextByAdapter,
      trend,
    };
  }

  private computeTokens(
    originalMessage: string,
    enrichedMessage: string,
    context: ContextLayer[],
  ): TokenAccounting {
    const model = this.monitor?.model;
    const original = estimateTokens(originalMessage, model);
    const enriched = estimateTokens(enrichedMessage, model);

    const contextByAdapter: Record<string, number> = {};
    let contextTotal = 0;
    for (const layer of context) {
      const layerTokens =
        estimateTokens(layer.summary, model) +
        estimateTokens(JSON.stringify(layer.data), model);
      contextByAdapter[layer.source] = (contextByAdapter[layer.source] ?? 0) + layerTokens;
      contextTotal += layerTokens;
    }

    return {
      originalMessage: original,
      enrichedMessage: enriched,
      context: contextTotal,
      contextByAdapter,
      overhead: enriched - original,
    };
  }

  private async harvestContext(
    message: string,
    intent: IntentSignal,
    conversation: ConversationTurn[],
    timings: Record<string, number>,
    enrichmentContext?: Record<string, unknown>,
  ): Promise<{ layers: ContextLayer[]; adapterResults: Record<string, AdapterResult> }> {
    const adapterResults: Record<string, AdapterResult> = {};

    const available = await Promise.all(
      this.adapters.map(async (adapter) => {
        try {
          const ok = await adapter.available();
          if (!ok) {
            adapterResults[adapter.name] = { status: "unavailable", layerCount: 0 };
          }
          return ok ? adapter : null;
        } catch (err) {
          this.log(`adapter ${adapter.name} availability check failed`);
          adapterResults[adapter.name] = {
            status: "error",
            layerCount: 0,
            error: `availability check failed: ${err instanceof Error ? err.message : String(err)}`,
          };
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
          adapterResults[adapter.name] = {
            status: layers.length > 0 ? "ok" : "empty",
            layerCount: layers.length,
          };
          return layers;
        } catch (err) {
          timings[adapter.name] = performance.now() - adapterStart;
          this.log(`adapter ${adapter.name} failed`, err);
          adapterResults[adapter.name] = {
            status: "error",
            layerCount: 0,
            error: err instanceof Error ? err.message : String(err),
          };
          return [] as ContextLayer[];
        }
      }),
    );

    const layers = results
      .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
      .sort((a, b) => a.priority - b.priority);

    return { layers, adapterResults };
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
