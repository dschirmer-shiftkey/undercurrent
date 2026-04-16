// ─── Intent Signal ──────────────────────────────────────────────────────────
// The structured representation of what the human is trying to do.
// Produced by the IntentClassifier stage of the pipeline.

export type Action =
  | "build"
  | "fix"
  | "explore"
  | "design"
  | "discuss"
  | "decide"
  | "vent"
  | "unknown";

export type Specificity = "high" | "medium" | "low";

export type Scope =
  | "atomic"
  | "local"
  | "cross-system"
  | "product"
  | "meta"
  | "unknown";

export type EmotionalLoad =
  | "neutral"
  | "frustrated"
  | "excited"
  | "uncertain";

export interface IntentSignal {
  action: Action;
  specificity: Specificity;
  scope: Scope;
  emotionalLoad: EmotionalLoad;
  confidence: number;
  rawFragments: string[];
  domainHints: string[];
}

// ─── Context ────────────────────────────────────────────────────────────────
// Structured context gathered by adapters. Each adapter produces ContextLayers.
// The harvester collects them, the gap analyzer consumes them.

export interface ContextLayer {
  source: string;
  priority: number;
  timestamp: number;
  data: Record<string, unknown>;
  summary: string;
}

export interface ConversationTurn {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

// ─── Assumptions ────────────────────────────────────────────────────────────
// When the engine fills a gap by inference rather than certainty, it records
// the assumption. These are the "show your work" trail that makes wrong
// guesses cheap to correct.

export interface Assumption {
  id: string;
  claim: string;
  basis: string;
  confidence: number;
  source: string;
  correctable: boolean;
}

// ─── Clarifications ─────────────────────────────────────────────────────────
// When a gap is genuinely unfillable, the engine produces a Clarification
// instead of guessing. These conform to the 3-Second Rule: answerable in
// under 3 seconds of cognitive effort.

export interface ClarificationOption {
  id: string;
  label: string;
  isDefault: boolean;
}

export interface Clarification {
  id: string;
  question: string;
  options: ClarificationOption[];
  allowMultiple: boolean;
  defaultOptionId: string;
  reason: string;
}

// ─── Gap ────────────────────────────────────────────────────────────────────
// A piece of information the engine needs but doesn't have.
// The GapAnalyzer produces these, then resolves them into either
// auto-fills, assumptions, or clarifications.

export type GapResolution =
  | { type: "filled"; value: string; source: string }
  | { type: "assumed"; assumption: Assumption }
  | { type: "needs-clarification"; clarification: Clarification };

export interface Gap {
  id: string;
  description: string;
  critical: boolean;
  resolution: GapResolution | null;
}

// ─── Enriched Prompt ────────────────────────────────────────────────────────
// The final output of the pipeline. Contains everything the AI needs to
// understand the human's actual intent, not just their words.

export interface EnrichedPrompt {
  originalMessage: string;
  intent: IntentSignal;
  context: ContextLayer[];
  gaps: Gap[];
  assumptions: Assumption[];
  clarifications: Clarification[];
  enrichedMessage: string;
  metadata: EnrichmentMetadata;
}

export interface EnrichmentMetadata {
  pipelineVersion: string;
  enrichmentDepth: "none" | "light" | "standard" | "deep";
  processingTimeMs: number;
  adapterTimings: Record<string, number>;
  strategyUsed: string;
}

// ─── Pipeline Configuration ─────────────────────────────────────────────────

export interface UndercurrentConfig {
  adapters: ContextAdapter[];
  strategy: EnrichmentStrategy;
  maxClarifications?: number;
  assumptionConfidenceThreshold?: number;
  timeoutMs?: number;
  onEnrichment?: (result: EnrichedPrompt) => void;
  debug?: boolean;
}

// ─── Adapter Interface ──────────────────────────────────────────────────────
// Adapters are pluggable context sources. They gather information from
// different environments (git, filesystem, conversation, APIs, etc.)
// and produce ContextLayers.

export interface ContextAdapter {
  readonly name: string;
  readonly priority: number;

  available(): Promise<boolean>;

  gather(input: AdapterInput): Promise<ContextLayer[]>;
}

export interface AdapterInput {
  message: string;
  intent: IntentSignal;
  conversation: ConversationTurn[];
  existingContext: ContextLayer[];
}

// ─── Strategy Interface ─────────────────────────────────────────────────────
// Strategies define HOW enrichment happens for a given domain.
// They control intent classification heuristics, gap analysis priorities,
// and how the enriched message is composed.

export interface EnrichmentStrategy {
  readonly name: string;

  classifyIntent(
    message: string,
    conversation: ConversationTurn[],
  ): Promise<IntentSignal>;

  analyzeGaps(
    intent: IntentSignal,
    context: ContextLayer[],
    message: string,
  ): Promise<Gap[]>;

  resolveGap(
    gap: Gap,
    context: ContextLayer[],
    confidenceThreshold: number,
  ): Promise<GapResolution>;

  compose(
    message: string,
    intent: IntentSignal,
    context: ContextLayer[],
    assumptions: Assumption[],
    resolvedGaps: Gap[],
  ): Promise<string>;
}

// ─── Pipeline Stage Hooks ───────────────────────────────────────────────────
// Hooks let consumers observe or modify the pipeline at each stage.
// The container provides the stages; hooks let you instrument them.

export interface PipelineHooks {
  beforeClassify?: (message: string) => void;
  afterClassify?: (intent: IntentSignal) => void;
  beforeGather?: (intent: IntentSignal) => void;
  afterGather?: (context: ContextLayer[]) => void;
  beforeAnalyze?: (gaps: Gap[]) => void;
  afterAnalyze?: (gaps: Gap[]) => void;
  beforeCompose?: (data: { message: string; intent: IntentSignal; context: ContextLayer[] }) => void;
  afterCompose?: (enriched: EnrichedPrompt) => void;
}
