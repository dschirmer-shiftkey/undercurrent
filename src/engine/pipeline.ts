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
  PipelineHooks,
  UndercurrentConfig,
} from "../types.js";

const PIPELINE_VERSION = "0.1.0";

type EnrichmentDepth = EnrichmentMetadata["enrichmentDepth"];

export interface EnrichInput {
  message: string;
  conversation?: ConversationTurn[];
}

export class Pipeline {
  private readonly adapters: ContextAdapter[];
  private readonly strategy: EnrichmentStrategy;
  private readonly maxClarifications: number;
  private readonly confidenceThreshold: number;
  private readonly timeoutMs: number;
  private readonly debug: boolean;
  private readonly onEnrichment?: (result: EnrichedPrompt) => void;
  private hooks: PipelineHooks = {};

  constructor(config: UndercurrentConfig) {
    this.adapters = [...config.adapters].sort(
      (a, b) => a.priority - b.priority,
    );
    this.strategy = config.strategy;
    this.maxClarifications = config.maxClarifications ?? 2;
    this.confidenceThreshold = config.assumptionConfidenceThreshold ?? 0.6;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.debug = config.debug ?? false;
    this.onEnrichment = config.onEnrichment;
  }

  setHooks(hooks: PipelineHooks): void {
    this.hooks = hooks;
  }

  async enrich(input: EnrichInput): Promise<EnrichedPrompt> {
    const start = performance.now();
    const conversation = input.conversation ?? [];
    const adapterTimings: Record<string, number> = {};

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
      return this.passthrough(input.message, intent, start);
    }

    // ── Stage 2: Context Harvesting ──────────────────────────────────────
    this.hooks.beforeGather?.(intent);
    const context = await this.harvestContext(
      input.message,
      intent,
      conversation,
      adapterTimings,
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
      this.strategy.compose(
        input.message,
        intent,
        context,
        assumptions,
        resolvedGaps,
      ),
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
      },
    };

    this.hooks.afterCompose?.(result);
    this.onEnrichment?.(result);
    return result;
  }

  private determineDepth(intent: IntentSignal): EnrichmentDepth {
    if (intent.specificity === "high" && intent.scope === "atomic") {
      return "none";
    }
    if (intent.specificity === "high") {
      return "light";
    }
    if (intent.specificity === "medium") {
      return "standard";
    }
    return "deep";
  }

  private passthrough(
    message: string,
    intent: IntentSignal,
    startTime: number,
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
      },
    };
  }

  private async harvestContext(
    message: string,
    intent: IntentSignal,
    conversation: ConversationTurn[],
    timings: Record<string, number>,
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

    const activeAdapters = available.filter(
      (a): a is ContextAdapter => a !== null,
    );

    const adapterInput = {
      message,
      intent,
      conversation,
      existingContext: [] as ContextLayer[],
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

  private async resolveGaps(
    gaps: Gap[],
    context: ContextLayer[],
  ): Promise<Gap[]> {
    return Promise.all(
      gaps.map(async (gap) => {
        if (gap.resolution) return gap;
        try {
          const resolution = await this.strategy.resolveGap(
            gap,
            context,
            this.confidenceThreshold,
          );
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
        (g): g is Gap & { resolution: { type: "assumed" } } =>
          g.resolution?.type === "assumed",
      )
      .map((g) => (g.resolution as { type: "assumed"; assumption: Assumption }).assumption);
  }

  private extractClarifications(gaps: Gap[]) {
    return gaps
      .filter((g) => g.resolution?.type === "needs-clarification")
      .map(
        (g) =>
          (g.resolution as Extract<GapResolution, { type: "needs-clarification" }>)
            .clarification,
      );
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    label: string,
  ): Promise<T> {
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
