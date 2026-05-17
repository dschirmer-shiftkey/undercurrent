# Slipstream

**A context engineering and personalization layer for AI.** Invisibly transforms vague human messages into structured, context-rich prompts — before the model ever sees them.

Think of it as a translation device sitting between humans and AI: you speak naturally, Slipstream fills in what you meant from your conversation, files, history, and preferences.

**Slipstream is the container, not the contents.** It provides the enrichment pipeline, plugin architecture, and protocol. You bring your own context sources (adapters), enrichment logic (strategies), and integration method (transports).

## The Problem

Every human message to an AI system is a lossy compression of their actual intent. The human has a rich mental model — they express 10% of it. Current solutions either ask the human to write better prompts (they won't) or ask 20 clarifying questions (they hate that). Slipstream takes a third path: silently enrich the message with inferred intent, harvested context, and transparent assumptions.

## Context Reliability System (CRS)

Slipstream now ships a core reliability layer for high-stakes enrichment workflows:

- **Memory governance**: precedence-aware assumptions, stale-context filtering, confidence gates, and bounded assumptions per message.
- **Decision observability**: stage-by-stage trace events and explicit governance intervention records in metadata.
- **Operational presets**: `strict-governance`, `balanced`, `speed-first`, and `safety-first` for predictable behavior by environment.
- **Preflight interception**: typo correction, continuation normalization, cascade-risk scoring, and contradiction checks before intent classification (in `safety-first` mode).

This is designed to avoid the most common production failures in context systems: silent stale memory usage, low-confidence assumptions, and opaque enrichment behavior.

## Quick Start

```ts
import { Slipstream } from "@komatik/slipstream";
import { ConversationAdapter, GitAdapter, FilesystemAdapter } from "@komatik/slipstream/adapters";
import { DefaultStrategy } from "@komatik/slipstream/strategies";

const uc = new Slipstream({
  adapters: [
    new ConversationAdapter(),
    new GitAdapter({ cwd: process.cwd() }),
    new FilesystemAdapter({ root: "./src" }),
  ],
  strategy: new DefaultStrategy(),
  preset: "balanced", // or "strict-governance" | "speed-first" | "safety-first"
  governance: {
    maxContextAgeMs: 72 * 60 * 60 * 1000,
    assumptionMinConfidence: 0.62,
  },
});

const result = await uc.enrich({
  message: "fix the auth thing",
  conversation: [
    { role: "user", content: "I've been working on the login flow all day" },
    { role: "assistant", content: "I see you've modified auth/middleware.ts" },
  ],
});

console.log(result.intent);
// { action: 'fix', specificity: 'low', scope: 'local', emotionalLoad: 'neutral', ... }

console.log(result.assumptions);
// [{ claim: 'Inferred resolution for: No specific file referenced',
//    basis: 'Based on 3 context layers from conversation, git, filesystem', ... }]

console.log(result.enrichedMessage);
// [Original]: fix the auth thing
// [Intent]: fix (low specificity, local scope)
// [Domain]: auth
// [Context]:
//   - conversation: Topic trajectory: login flow → auth thing
//   - git: On branch feat/auth-flow. 4 changes in working tree.
//   - filesystem: Recently modified: src/auth/middleware.ts, src/auth/login.ts
// [Assumptions]:
//   - Inferred resolution for: No specific file referenced (confidence: 65%)
```

## Architecture

```
                    ┌─────────────────────────────────┐
                    │       Your Application           │
                    │                                  │
  "fix the auth" → │  ┌────────────────────────────┐  │
                    │  │       Slipstream          │  │
                    │  │                             │  │
                    │  │  ┌──────────────────────┐   │  │
                    │  │  │      Pipeline         │   │  │
                    │  │  │                       │   │  │
                    │  │  │  1. Classify Intent   │   │  │   Adapters (pluggable)
                    │  │  │  2. Harvest Context ◄─┼───┼──┼── ├── Conversation
                    │  │  │  3. Analyze Gaps      │   │  │   ├── Git
                    │  │  │  4. Compose Output  ◄─┼───┼──┼── ├── Filesystem
                    │  │  │                       │   │  │   ├── Komatik Identity (7)
                    │  │  └──────────┬────────────┘   │  │   └── (your own)
                    │  │             │                 │  │
                    │  │  ┌──────────▼────────────┐   │  │   Strategies (pluggable)
                    │  │  │  Platform Composer     │   │  │   ├── Default (heuristic)
                    │  │  │  cursor│claude│chatgpt │   │  │   ├── LLM (llmCall callback)
                    │  │  │  api│mcp│generic       │   │  │   ├── Komatik Pipeline
                    │  │  │                        │   │  │   └── (your own)
                    │  │  └──────────┬────────────┘   │  │
                    │  └─────────────┼────────────────┘  │
                    │                ▼                    │
                    │         EnrichedPrompt → LLM       │
                    └────────────────────────────────────┘
```

## Core Concepts

### The Pipeline

Core pipeline stages execute in order, with optional preflight interception first:


| Stage         | What It Does                                                      | Who Controls It |
| ------------- | ----------------------------------------------------------------- | --------------- |
| **Preflight** | Optional interception layer for typo/continuation/cascade checks  | Pipeline policy |
| **Classify**  | Determines intent (action, specificity, scope, emotion)           | Strategy        |
| **Harvest**   | Gathers context from all available adapters in parallel           | Adapters        |
| **Analyze**   | Identifies gaps and resolves them (auto-fill, assume, or clarify) | Strategy        |
| **Compose**   | Builds the enriched message from all signals                      | Strategy        |


### Graduated Scope Calibration

The pipeline auto-calibrates depth based on a multi-signal scoring system — specificity, scope, action complexity, emotional load, and classification confidence:


| Score | Depth      | Behavior                                       |
| ----- | ---------- | ---------------------------------------------- |
| ≤ 1   | `none`     | Passthrough — zero enrichment overhead         |
| 2–3   | `light`    | Identity + preferences only, skip gap analysis |
| 4–6   | `standard` | Full pipeline with harvesting + gap resolution |
| ≥ 7   | `deep`     | All adapters, proactive context loading        |


Frustrated or uncertain users get escalated depth automatically. Low-confidence intent classifications trigger deeper enrichment.

### Adapters

Pluggable context sources. Each adapter implements `ContextAdapter`:

```ts
interface ContextAdapter {
  readonly name: string;
  readonly priority: number;
  available(): Promise<boolean>;
  gather(input: AdapterInput): Promise<ContextLayer[]>;
}
```

**Built-in generic adapters** (`@komatik/slipstream/adapters`):


| Adapter               | What It Gathers                                           |
| --------------------- | --------------------------------------------------------- |
| `ConversationAdapter` | Decisions, topics, and terminology from chat history      |
| `GitAdapter`          | Branch, commits, diff, working tree state                 |
| `FilesystemAdapter`   | Project structure, recent files, relevance-scored content |


**Komatik identity adapters** (`@komatik/slipstream/komatik`) — make enrichment identity-aware via Komatik ID (Supabase user UUID):


| Adapter                     | Source Table(s)                          | What It Gathers                                        |
| --------------------------- | ---------------------------------------- | ------------------------------------------------------ |
| `KomatikIdentityAdapter`    | `komatik_profiles`                       | Who is this user, their role, products used            |
| `KomatikPreferenceAdapter`  | `user_preferences`                       | Tone, style, code conventions, always/never rules      |
| `KomatikMemoryAdapter`      | `session_memories`                       | Cross-session decisions, active work, unresolved items |
| `KomatikHistoryAdapter`     | `user_product_events` + `crm_activities` | Behavioral trajectory, lead score                      |
| `KomatikOutcomeAdapter`     | `enrichment_outcomes`                    | Acceptance/rejection feedback loop                     |
| `KomatikProjectAdapter`     | `triage_intakes` + `floe_scans`          | Active projects, diagnostics, scan findings            |
| `KomatikMarketplaceAdapter` | `forge_usage` + `forge_tools`            | MCP tool usage, authored tools                         |


All Komatik adapters accept `{ client: KomatikDataClient, userId: string }`. The `KomatikDataClient` interface matches Supabase's query builder — zero new dependencies.

Build your own adapters for Jira, Slack, Notion, databases, session stores — anything that holds context about what the user is doing.

### Strategies

Pluggable enrichment logic. Each strategy implements `EnrichmentStrategy`:

```ts
interface EnrichmentStrategy {
  readonly name: string;
  classifyIntent(message: string, conversation: ConversationTurn[]): Promise<IntentSignal>;
  analyzeGaps(intent: IntentSignal, context: ContextLayer[], message: string): Promise<Gap[]>;
  resolveGap(gap: Gap, context: ContextLayer[], threshold: number): Promise<GapResolution>;
  compose(message: string, intent: IntentSignal, context: ContextLayer[], assumptions: Assumption[], resolvedGaps: Gap[]): Promise<string>;
}
```

Ships with:

- **`DefaultStrategy`** — Heuristic, no LLM, fully deterministic. Same input always produces the same output.
- **`LlmStrategy`** — LLM-assisted enrichment via a pluggable `llmCall` callback. Uses the LLM for intent classification, gap analysis, gap resolution, and composition. Falls back to `DefaultStrategy` heuristics when the LLM is unavailable or returns unparseable output. Skips the LLM entirely for high-confidence, high-specificity messages where heuristics are sufficient.
- **`KomatikPipelineStrategy`** — Domain-specific strategy for the Komatik marketplace. Detects project domains (ecommerce, SaaS, education, etc.), infers tech stacks, identifies features, and assesses readiness. Supports optional LLM-assisted composition via `llmCall` callback.

#### LlmStrategy

```ts
import { LlmStrategy } from "@komatik/slipstream/strategies";

const strategy = new LlmStrategy({
  llmCall: async (prompt) => {
    const response = await myLlmGateway.call({ prompt });
    return response.text;
  },
  maxConversationTurns: 10,        // conversation context window (default: 10)
  heuristicConfidenceThreshold: 0.8, // skip LLM above this (default: 0.8)
});

const uc = new Slipstream({ adapters, strategy });
```

The `llmCall` callback receives a plain string prompt and must return a plain string response. No SDK dependency — you bring your own LLM gateway (OpenAI, Anthropic, Google, local model, etc.). JSON parsing is resilient: handles raw JSON, markdown-fenced code blocks, and embedded JSON in prose.

## Presets and reliability posture

`@komatik/slipstream` exposes four governance presets:

- `strict-governance`: strongest confidence gates, shortest context freshness window, lowest assumption tolerance.
- `balanced`: recommended default for most production teams.
- `speed-first`: lighter safety gates when minimizing latency and manual clarifications is the top priority.
- `safety-first`: enables preflight interception and blocks high-cascade-risk ambiguity behind explicit clarifications.

Programmatic helper:

```ts
import { withPreset } from "@komatik/slipstream";

const config = withPreset(
  {
    adapters,
    strategy,
  },
  "strict-governance",
);
```

## Benchmarked outcomes via replay harness

The replay harness now reports measurable reliability outcomes so teams can compare governed vs unguided behavior on their own transcripts:

- assumption reduction after governance
- stale context filtered
- intervention counts by type
- token overhead and token multiplier
- average trace events per message
- preflight correction count and cascade-risk distribution (when enabled)

Run:

```bash
npm run replay -- path/to/transcript.jsonl --verbose
```

These outputs are intended to provide an ROI loop before changing pricing/packaging: prove quality-per-token and reliability gains first, then optimize rollout strategy.

## Komatik IDE integration (recommended shape)

For the **Komatik platform IDE** (`platform/web/app/api/workspace-agent/route.ts`), Slipstream does **not** own model selection — the host's `getModelConfigForPhase(phase, tier)` does. Slipstream contributes a **tier recommendation** via `enrich().metadata.tierRecommendation`. The IDE chooses whether to honor it based on the user's `undercurrent_settings.autoTier` flag.

```ts
// In workspace-agent/route.ts
import { Slipstream, recommendTier } from "@komatik/slipstream";
import { KomatikPreferenceClient } from "@komatik/slipstream/komatik";

const settings = await prefClient.getUndercurrentSettings(user.id);
// → { enabled, enrichmentDepth, strategy, showEnrichmentDetails, autoTier?, defaultTier? }

if (settings.enabled) {
  const enriched = await slipstream.enrich({
    message: userMessage,
    conversation,
    targetPlatform: "api",
  });

  // NEW in v2.1+: tier recommendation from the enriched intent
  const recommended = enriched.metadata.tierRecommendation;
  // → { tier: 'budget' | 'balanced' | 'premium', confidence, reasoning, signals }

  const effectiveTier =
    settings.autoTier && recommended && recommended.confidence >= 0.5
      ? recommended.tier
      : (userPickedTier ?? settings.defaultTier ?? "balanced");

  const modelConfig = getModelConfigForPhase(phase, effectiveTier);
  // …call model with enriched.enrichedMessage and modelConfig
}
```

### What Slipstream provides for the IDE

| Surface | Purpose |
|---|---|
| `enrich().enrichedMessage` | The prompt to send to the model (existing) |
| `enrich().metadata.tierRecommendation` | **NEW** — `{ tier, confidence, reasoning, signals }` for the host's router |
| `enrich().metadata.preflight` | Cascade-risk + typo/contradiction signals (existing) |
| `enrich().metadata.governance` | Stale-context filtering + assumption blocks (existing) |
| `DriftMonitor` | Per-session entity-drift detection; emits `refreshRecommended` for the IDE to wire into `resetSessionState()` |
| `KomatikOutcomeWriter` | Persist accept/reject verdicts to `enrichment_outcomes` |
| `KomatikPreferenceClient` | Read/write `undercurrent_settings` with type-safe schema matching the IDE's UI |

### What Slipstream does NOT do for the IDE

- **Does not call models.** The host owns `getModelConfigForPhase` and model invocation.
- **Does not own session lifecycle.** The host's `workspace-agent/route.ts` owns context prep, act loop, post-flight, memory.
- **Does not maintain a parallel model registry.** Komatik's `model_availability` is the source of truth.

### Graceful degradation when Komatik is down

`Slipstream.enrich()` defaults to `failureMode: "degraded"` — adapter failures (Supabase down, auth expired, RLS denial, network timeout) are recorded in `metadata.degradation` but never throw. Partial backend failure produces partial enrichment instead of total failure.

```ts
const result = await slipstream.enrich({ message, conversation });
if (result.metadata.degradation) {
  // Surface to telemetry; the IDE chat can still proceed with the (partial) enriched message.
  log.warn("slipstream degraded", result.metadata.degradation);
}
```

For a pre-flight check (e.g., the IDE wants to show a "Slipstream offline" badge before opening a chat):

```ts
const health = await slipstream.healthCheck();
// → { status: 'healthy' | 'degraded' | 'unavailable', adapters: [...], modelRouter?: {...} }
```

Per-adapter timeout via `adapterTimeoutMs` prevents one slow remote-backed adapter from eating the whole pipeline budget. `failureMode: "strict"` is available for callers that need errors to propagate.

### OpenTelemetry-GenAI telemetry

Slipstream emits standards-compliant spans per `enrich()` and `process()` call when a `TelemetryEmitter` is configured. Attribute names follow the [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) so spans push directly to Langfuse, Helicone, Arize Phoenix, Datadog, or any OTel backend via a thin adapter.

```ts
import type { TelemetryEmitter, TelemetrySpan } from "@komatik/slipstream";

const otelEmitter: TelemetryEmitter = {
  async emit(span: TelemetrySpan) {
    // Push to your OTel SDK / Langfuse / Helicone / etc.
    tracer.startActiveSpan(span.name, (s) => {
      Object.entries(span.attributes).forEach(([k, v]) => s.setAttribute(k, v));
      span.events?.forEach((e) => s.addEvent(e.name, e.attributes, new Date(e.at)));
      s.setStatus({ code: span.status === "ok" ? 1 : 2, message: span.error?.message });
      s.end(new Date(span.endedAt));
    });
  },
};

const slip = new Slipstream({
  adapters: [...],
  strategy: new DefaultStrategy(),
  telemetry: otelEmitter,
});
```

Each span carries:

| Convention | Attribute | Notes |
|---|---|---|
| OTel GenAI | `gen_ai.system`, `gen_ai.operation.name`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.model` | Standard cross-vendor |
| Slipstream | `slipstream.tier_recommended`, `slipstream.tier_bias_applied`, `slipstream.tier_bias_reason` | Tier-recommendation telemetry |
| Slipstream | `slipstream.degraded`, `slipstream.failed_adapter_count`, `slipstream.model_router_degraded` | Backend degradation |
| Slipstream | `slipstream.preflight_cascade_risk`, `slipstream.preflight_blocking_clarification`, `slipstream.governance_interventions` | Governance + preflight signals |
| Slipstream | `slipstream.intent_action`, `slipstream.intent_specificity`, `slipstream.intent_scope`, `slipstream.intent_emotional_load` | Per-message intent for segmentation |

A throwing emitter never breaks the enrichment path — `safelyEmit()` wraps every call.

### Validating tier-recommendation rollout

The `runTierRecommendationHarness` helper compares user-picked-tier strategies against `slipstream-recommended`, with the host's tier→model mapping held constant:

```ts
import { runTierRecommendationHarness } from "@komatik/slipstream/komatik";

const comparison = await runTierRecommendationHarness({
  workload: realProductionMessages,
  variants: [
    { name: "user-pick-balanced", strategy: { kind: "user-pick", userPick: "balanced" } },
    { name: "slipstream-auto", strategy: { kind: "slipstream-recommended" } },
  ],
  models: realModelTable,
  tierToModel: { pick: (tier) => realKomatikRouter.pickFor(tier) },
});

console.log(comparison.results);     // per-variant acceptance + cost + tier histogram
console.log(comparison.winners);     // { byAcceptance, byCost }
```

**Honest framing:** the harness is a methodology. Plug in real production acceptance data and the real `getModelConfigForPhase` for a real conclusion.

### `SlipstreamSessionManager` is deprecated for IDE consumers

The `SlipstreamSessionManager` façade (added in v2.0) was built for an integration shape the live Komatik IDE doesn't need — the IDE already owns session lifecycle, model selection, telemetry, and memory. The façade remains exported for non-IDE consumers (Sundog, Kindling, third-party apps) that want a one-class wrapper. It will be removed in v3 unless a real consumer surfaces.

If you previously used `SlipstreamSessionManager` for Komatik IDE wiring, migrate to direct `Slipstream.enrich()` + `metadata.tierRecommendation` as shown above.

## Production pilot integration (`process`)

For a real Komatik app path (Forge/Triage/Floe), use `KomatikPilotProcessor` to wrap `Slipstream.process()` and emit ROI telemetry per request:

```ts
import { Slipstream } from "@komatik/slipstream";
import { KomatikPilotProcessor } from "@komatik/slipstream/komatik";

const uc = new Slipstream(configWithModelRouter);
const pilot = new KomatikPilotProcessor(uc, {
  onProcessTelemetry: (event) => console.log("process telemetry", event),
  onOutcome: (event) => console.log("accept/reject", event),
});

const result = await pilot.process(
  { message: "fix auth flow", conversation },
  { sourceApp: "forge", userId: "user-123", sessionId: "sess-abc" },
);

// Later, once user accepts/rejects
await pilot.recordOutcome({ requestId: result.pilotTelemetry.requestId, accepted: true });
console.log(pilot.summarizeRoi());
```

Telemetry includes:
- end-to-end latency (`totalLatencyMs`) and split (`enrichmentLatencyMs`, `modelLatencyMs`)
- token efficiency (`tokenMultiplier`, `tokenOverhead`)
- governance effect (`governanceInterventions`, `blockedAssumptions`)
- acceptance rate via `recordOutcome()` + `summarizeRoi()`

### Local pilot harness for iteration

Before porting the pilot path to a real product, use `runPilotSimulation()` to wire the full chain (Slipstream → KomatikPilotProcessor → outcome writer → ROI summary) with mock clients and a stub model caller. Replace `caller`, `client`, and `writeClient` with real implementations when porting.

```ts
import { runPilotSimulation } from "@komatik/slipstream/komatik";

const result = await runPilotSimulation({
  messages: ["Fix the auth crash in login.ts", "Add a regression test"],
  sourceApp: "forge",
  preset: "balanced",
  // caller, client, writeClient default to in-memory simulators
  // verdictRule defaults to: accept if depth=none OR (mult<4 AND latency<800ms)
});

console.log(result.roi);
console.log(result.writes.enrichment_outcomes);
```

CLI version replays a transcript end-to-end:

```bash
npm run playground:pilot -- --transcript fixtures/replay/preflight-stress.jsonl --preset safety-first --verbose
```

## Closed feedback loop persistence

Use `KomatikOutcomeWriter` to persist every enrichment and later attach user verdicts (`accepted`/`rejected`/`revised`/`ignored`) to the same enrichment id:

```ts
import { Slipstream, KomatikOutcomeWriter } from "@komatik/slipstream";

const outcomeWriter = new KomatikOutcomeWriter(supabaseClient, userId);
const uc = new Slipstream({
  adapters,
  strategy,
  outcomeWriter: {
    writer: outcomeWriter,
    sessionId: "sess-123",
    workspaceId: "ws-456",
  },
});

const enriched = await uc.enrich({ message, conversation });
await uc.recordVerdict({
  enrichmentId: enriched.metadata.enrichmentId,
  verdict: "accepted",
});
```

## CI reliability eval gate

Slipstream ships a replay-based reliability gate that can block merges on regressions:
- baseline depth-distribution drift
- token-multiplier ceiling
- governance intervention bounds
- blocked-assumption rate ceiling
- preflight blocking-clarification rate ceiling (catches safety-first regressions)
- cascade-risk classification rate ceiling

The gate runs a **matrix of (fixture × preset)** cells from `ci/reliability-matrix.json`. Each cell has its own baseline and thresholds, so a regression in any preset path fails the gate. Current matrix covers `reliability-ci`, `preflight-stress`, and `governance-stress` fixtures across `balanced`, `safety-first`, and `strict-governance` presets.

Run locally:

```bash
npm run eval:reliability               # matrix mode (default, CI)
npm run eval:reliability:single        # original single-cell mode
```

Refresh baselines intentionally (after approved behavior changes):

```bash
npm run eval:reliability:update        # regenerates every cell in the matrix
```

### Platform-Aware Composition

Slipstream formats enriched output differently per target platform via the `targetPlatform` option:


| Platform  | Format                                                             | Use Case               |
| --------- | ------------------------------------------------------------------ | ---------------------- |
| `cursor`  | XML-tagged blocks (`<user_request>`, `<context>`, `<assumptions>`) | Cursor IDE integration |
| `claude`  | Semantic XML with user profile, memory, and learning blocks        | Anthropic Claude       |
| `chatgpt` | Markdown with bold headers and bullet lists                        | OpenAI ChatGPT         |
| `api`     | Structured JSON with full data payloads                            | REST/GraphQL APIs      |
| `mcp`     | Compact text with separator lines                                  | MCP tool responses     |
| `generic` | Labeled text blocks (backward-compatible default)                  | Everything else        |


```ts
const result = await uc.enrich({
  message: "fix the auth thing",
  targetPlatform: "cursor",
});
```

### Transports

How Slipstream integrates with your stack:

```ts
// Direct SDK
const result = await uc.enrich({ message: "..." });

// Express/Connect middleware
app.use(uc.middleware());
app.post("/chat", (req, res) => {
  const enriched = req.slipstream; // EnrichedPrompt attached
});

// Web Fetch API (Next.js, Hono, Cloudflare Workers, Deno)
const handler = uc.fetchHandler();
export async function POST(request: Request) {
  const { enriched } = await handler(request);
}
```

## External MCP Server

Slipstream ships an MCP server that exposes the enrichment pipeline and Komatik user context to external AI tools (Cursor, Claude, AntiGravity) via the stdio transport.

```
External Tool (Cursor/Claude) ←→ stdin/stdout JSON-RPC ←→ McpServer ←→ Slipstream Pipeline
                                                                        ├── 7 Komatik Adapters
                                                                        └── PostgREST Client → Supabase
```

**Tools:**


| Tool                         | Description                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `enrich`                     | Full enrichment pipeline with Komatik context (`platform` + `preset` support).                                  |
| `get_context`                | Raw context layers from all 7 adapters without running enrichment.                                                |
| `suggest_followups`          | Generates continue/amend/stop suggestions from user message + agent response.                                    |
| `record_suggestion_feedback` | Records accepted/dismissed/edited suggestion outcomes.                                                            |
| `process_with_pilot`         | Full `process()` path (enrich + model route + call) with pilot telemetry.                                        |
| `record_pilot_outcome`       | Records pilot accept/reject outcome for ROI tracking.                                                             |
| `get_pilot_roi_summary`      | Returns pilot ROI summary snapshot.                                                                               |
| `digest_tool_result`         | Deduplicates repeated tool output and returns compact references when content repeats.                            |


**Resources:**


| URI                          | Description                              |
| ---------------------------- | ---------------------------------------- |
| `komatik://user/profile`     | Identity, role, products used            |
| `komatik://user/preferences` | Tone, style, code conventions            |
| `komatik://user/memory`      | Cross-session persistent context         |
| `komatik://user/history`     | Product events, CRM activity             |
| `komatik://user/outcomes`    | Enrichment acceptance/rejection feedback |
| `komatik://user/projects`    | Triage intakes, Floe scans               |
| `komatik://user/tools`       | Forge marketplace tools                  |


**Prompts:**


| Prompt           | Description                                                          |
| ---------------- | -------------------------------------------------------------------- |
| `enrich-message` | System prompt pre-loaded with full user context from all 7 adapters. |


### Running the MCP Server

```bash
# Set required environment variables
export KOMATIK_SUPABASE_URL="https://your-project.supabase.co"
export KOMATIK_SUPABASE_KEY="your-anon-key"
export KOMATIK_USER_ID="user-uuid"

# Run via npm
npm run start:mcp

# Or directly
npx slipstream-mcp
```

The PostgREST client uses native `fetch` against Supabase's REST API — no `@supabase/supabase-js` dependency required.

## The EnrichedPrompt

The output of the pipeline. Contains everything the downstream AI needs:

```ts
interface EnrichedPrompt {
  originalMessage: string;        // What the human actually said
  intent: IntentSignal;           // Classified intent (action, specificity, scope, emotion)
  context: ContextLayer[];        // All gathered context from adapters
  gaps: Gap[];                    // Identified gaps and their resolutions
  assumptions: Assumption[];      // What the engine assumed (transparent, correctable)
  clarifications: Clarification[];// Questions that couldn't be auto-resolved (max 2)
  enrichedMessage: string;        // The composed enriched prompt
  metadata: EnrichmentMetadata;   // Pipeline timing, depth, platform, adapter performance
}
```

## Pipeline Hooks

Observe or instrument every stage:

```ts
uc.setHooks({
  afterClassify: (intent) => telemetry.track("intent", intent),
  afterGather: (ctx) => console.log(`${ctx.length} context layers gathered`),
  afterCompose: (result) => metrics.record(result.metadata),
});
```

## Komatik Integration

Full end-to-end wiring for a Komatik product (Triage, Floe, Forge, or the platform). This shows every subsystem connected — identity-aware adapters, LLM strategy, session lifecycle, and model routing:

```ts
import { Slipstream } from "@komatik/slipstream";
import { ConversationAdapter, GitAdapter, FilesystemAdapter } from "@komatik/slipstream/adapters";
import { LlmStrategy } from "@komatik/slipstream/strategies";
import {
  KomatikIdentityAdapter,
  KomatikPreferenceAdapter,
  KomatikMemoryAdapter,
  KomatikHistoryAdapter,
  KomatikProjectAdapter,
  KomatikMarketplaceAdapter,
  KomatikOutcomeAdapter,
  KomatikSessionWriter,
} from "@komatik/slipstream/komatik";

// 1. Identity-aware adapters — generic + Komatik ecosystem
const adapters = [
  new ConversationAdapter(),
  new GitAdapter({ cwd: process.cwd() }),
  new FilesystemAdapter({ root: "./src" }),
  new KomatikIdentityAdapter({ client, userId }),
  new KomatikPreferenceAdapter({ client, userId }),
  new KomatikMemoryAdapter({ client, userId }),
  new KomatikHistoryAdapter({ client, userId }),
  new KomatikProjectAdapter({ client, userId }),
  new KomatikMarketplaceAdapter({ client, userId }),
  new KomatikOutcomeAdapter({ client, userId }),
];

// 2. LLM strategy with the product's existing gateway
const strategy = new LlmStrategy({
  llmCall: (prompt) => myLlmGateway.generate(prompt),
});

// 3. Full pipeline with session lifecycle + model routing
const uc = new Slipstream({
  adapters,
  strategy,
  targetPlatform: "cursor",
  sessionMonitor: {
    userId,
    writer: new KomatikSessionWriter({ client, userId }),
    compactorLlmCall: (prompt) => myLlmGateway.generate(prompt),
  },
  modelRouter: {
    enabled: true,
    caller: (input) => myLlmGateway.call(input),
    userId,
    client,
  },
});

// 4. Enrich only (strategy picks model externally)
const enriched = await uc.enrich({ message, conversation });

// 5. Full process — enrich + route model + call LLM
const result = await uc.process({ message, conversation });
// result.enrichedPrompt — the enriched context
// result.modelRecommendation — which model was selected and why
// result.modelResponse — the LLM's response
```

The `client` is any object implementing `KomatikDataClient` — the interface matches Supabase's query builder, so you can pass your existing Supabase client directly. For the MCP server, a lightweight `PostgREST` client is available that uses native `fetch` instead.

## Design Principles


| Principle                               | What It Means                                                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Container, not contents**             | Slipstream provides the pipeline and plugin system. You bring the intelligence.                                                 |
| **Invisible by default**                | The user never knows enrichment is happening. They just get better responses.                                                     |
| **Bias toward action**                  | A stated wrong assumption is cheaper than a right question. The engine assumes and surfaces, rather than interrogating.           |
| **3-Second Rule**                       | Any clarification that reaches the user must be answerable in under 3 seconds. Binary, default-with-opt-out, or pick-from-3.      |
| **Proportional enrichment**             | Simple messages get zero overhead. Complex messages get the full pipeline. The engine calibrates automatically.                   |
| **No LLM dependency**                   | The default strategy is pure heuristics. You can add LLM-powered strategies, but the core works offline.                          |
| **Zero external runtime deps**          | Core pipeline depends only on Node.js built-ins. MCP server deps (`@modelcontextprotocol/sdk`, `zod`) are isolated to `src/mcp/`. |
| **The user travels with their context** | Preferences, memory, and outcomes persist across platforms and sessions via the Komatik identity layer.                           |


## Project Structure

```
slipstream/
├── src/
│   ├── index.ts                      # Public API — Slipstream class + re-exports
│   ├── types.ts                      # The protocol — all interfaces and types
│   ├── engine/
│   │   ├── pipeline.ts               # Core pipeline + governance + preflight integration
│   │   ├── preflight.ts              # Safety-first interception heuristics
│   │   ├── session-monitor.ts        # Session health tracking (cold-start → critical)
│   │   ├── compactor.ts              # Context distillation (heuristic + LLM)
│   │   ├── checkpointer.ts           # Persistence via pluggable SessionWriter
│   │   └── model-router.ts           # TaskDomainClassifier, ModelScorer, ModelRouter
│   ├── adapters/
│   │   ├── conversation.ts           # Decisions, topics, terminology from chat history
│   │   ├── filesystem.ts             # Project structure, recent files, relevance-scored content
│   │   └── git.ts                    # Branch, commits, diff, working tree state
│   ├── komatik/                      # Komatik identity layer (@komatik/slipstream/komatik)
│   │   ├── client.ts                 # KomatikDataClient + KomatikWriteClient interfaces
│   │   ├── types.ts                  # Row types for all ecosystem Supabase tables
│   │   ├── identity-adapter.ts       # komatik_profiles → who is this user
│   │   ├── preference-adapter.ts     # user_preferences → tone, style, code conventions
│   │   ├── memory-adapter.ts         # session_memories → cross-session persistent context
│   │   ├── history-adapter.ts        # user_product_events + crm → behavioral history
│   │   ├── outcome-adapter.ts        # enrichment_outcomes → feedback loop
│   │   ├── outcome-writer.ts         # Persist enrichment records + verdicts
│   │   ├── project-adapter.ts        # triage_intakes + floe_scans → active projects
│   │   ├── marketplace-adapter.ts    # forge_usage + forge_tools → marketplace activity
│   │   ├── session-writer.ts         # KomatikSessionWriter → session_memories persistence
│   │   ├── model-usage-adapter.ts    # model_availability + llm_usage + enrichment_outcomes
│   │   └── testing.ts                # createMockClient() for tests
│   ├── strategies/
│   │   ├── default.ts                # Heuristic (no LLM, deterministic) — reference impl
│   │   ├── llm.ts                    # LLM-assisted (pluggable llmCall, DefaultStrategy fallback)
│   │   ├── komatik-pipeline.ts       # Domain-specific Komatik marketplace enrichment
│   │   └── platform-composer.ts      # Platform-aware output formatting (6 targets)
│   ├── mcp/                          # External MCP server (@komatik/slipstream/mcp)
│   │   ├── postgrest-client.ts       # Lightweight PostgREST adapter (native fetch)
│   │   ├── server.ts                 # McpServer: 2 tools, 7 resources, 1 prompt
│   │   └── index.ts                  # Bin entry (slipstream-mcp)
│   └── transports/
│       └── middleware.ts             # Express middleware + Fetch API handler
├── .github/
│   ├── workflows/ci.yml             # CI: typecheck, build, test on Node 20 & 22
│   ├── workflows/release.yml        # Publish to npm on tag push
│   └── dependabot.yml               # Automated dependency updates
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.js
├── CHANGELOG.md
├── LICENSE
└── README.md
```

## Development

```bash
npm install          # Install dependencies
npm run build        # TypeScript → dist/
npm run typecheck    # Type-check only (no emit)
npm test             # 492 tests across 33 files
npm run dev          # Watch mode (tsc --watch)
npm run start:mcp    # Run the MCP server
```

## License

MIT