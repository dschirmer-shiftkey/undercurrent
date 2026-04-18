# Undercurrent

A digital translation device for AI systems. Turns vague human input into precise, context-rich prompts — invisibly, before the AI ever sees the message.

**Undercurrent is the container, not the contents.** It provides the enrichment pipeline, plugin architecture, and protocol. You bring your own context sources (adapters), enrichment logic (strategies), and integration method (transports).

## The Problem

Every human message to an AI system is a lossy compression of their actual intent. The human has a rich mental model — they express 10% of it. Current solutions either ask the human to write better prompts (they won't) or ask 20 clarifying questions (they hate that). Undercurrent takes a third path: silently enrich the message with inferred intent, harvested context, and transparent assumptions.

## Quick Start

```ts
import { Undercurrent } from "@komatik/undercurrent";
import { ConversationAdapter, GitAdapter, FilesystemAdapter } from "@komatik/undercurrent/adapters";
import { DefaultStrategy } from "@komatik/undercurrent/strategies";

const uc = new Undercurrent({
  adapters: [
    new ConversationAdapter(),
    new GitAdapter({ cwd: process.cwd() }),
    new FilesystemAdapter({ root: "./src" }),
  ],
  strategy: new DefaultStrategy(),
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
                    │  │       Undercurrent          │  │
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
                    │  │  │  cursor│claude│chatgpt │   │  │   ├── Komatik Pipeline
                    │  │  │  api│mcp│generic       │   │  │   └── (your own)
                    │  │  └──────────┬────────────┘   │  │
                    │  └─────────────┼────────────────┘  │
                    │                ▼                    │
                    │         EnrichedPrompt → LLM       │
                    └────────────────────────────────────┘
```

## Core Concepts

### The Pipeline

4 stages, executed in order:


| Stage        | What It Does                                                      | Who Controls It |
| ------------ | ----------------------------------------------------------------- | --------------- |
| **Classify** | Determines intent (action, specificity, scope, emotion)           | Strategy        |
| **Harvest**  | Gathers context from all available adapters in parallel           | Adapters        |
| **Analyze**  | Identifies gaps and resolves them (auto-fill, assume, or clarify) | Strategy        |
| **Compose**  | Builds the enriched message from all signals                      | Strategy        |


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

**Built-in generic adapters** (`@komatik/undercurrent/adapters`):


| Adapter               | What It Gathers                                           |
| --------------------- | --------------------------------------------------------- |
| `ConversationAdapter` | Decisions, topics, and terminology from chat history      |
| `GitAdapter`          | Branch, commits, diff, working tree state                 |
| `FilesystemAdapter`   | Project structure, recent files, relevance-scored content |


**Komatik identity adapters** (`@komatik/undercurrent/komatik`) — make enrichment identity-aware via Komatik ID (Supabase user UUID):


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

- `**DefaultStrategy**` — Heuristic, no LLM, fully deterministic. Same input always produces the same output.
- `**KomatikPipelineStrategy**` — Domain-specific strategy for the Komatik marketplace. Detects project domains (ecommerce, SaaS, education, etc.), infers tech stacks, identifies features, and assesses readiness. Supports optional LLM-assisted composition via `llmCall` callback.

### Platform-Aware Composition

Undercurrent formats enriched output differently per target platform via the `targetPlatform` option:


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

How Undercurrent integrates with your stack:

```ts
// Direct SDK
const result = await uc.enrich({ message: "..." });

// Express/Connect middleware
app.use(uc.middleware());
app.post("/chat", (req, res) => {
  const enriched = req.undercurrent; // EnrichedPrompt attached
});

// Web Fetch API (Next.js, Hono, Cloudflare Workers, Deno)
const handler = uc.fetchHandler();
export async function POST(request: Request) {
  const { enriched } = await handler(request);
}
```

## External MCP Server

Undercurrent ships an MCP server that exposes the enrichment pipeline and Komatik user context to external AI tools (Cursor, Claude, AntiGravity) via the stdio transport.

```
External Tool (Cursor/Claude) ←→ stdin/stdout JSON-RPC ←→ McpServer ←→ Undercurrent Pipeline
                                                                        ├── 7 Komatik Adapters
                                                                        └── PostgREST Client → Supabase
```

**Tools:**


| Tool          | Description                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------- |
| `enrich`      | Full 4-stage pipeline with Komatik context. Accepts `platform` param for output formatting. |
| `get_context` | Raw context layers from all 7 adapters without running the pipeline.                        |


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
npx undercurrent-mcp
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

## Design Principles


| Principle                               | What It Means                                                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Container, not contents**             | Undercurrent provides the pipeline and plugin system. You bring the intelligence.                                                 |
| **Invisible by default**                | The user never knows enrichment is happening. They just get better responses.                                                     |
| **Bias toward action**                  | A stated wrong assumption is cheaper than a right question. The engine assumes and surfaces, rather than interrogating.           |
| **3-Second Rule**                       | Any clarification that reaches the user must be answerable in under 3 seconds. Binary, default-with-opt-out, or pick-from-3.      |
| **Proportional enrichment**             | Simple messages get zero overhead. Complex messages get the full pipeline. The engine calibrates automatically.                   |
| **No LLM dependency**                   | The default strategy is pure heuristics. You can add LLM-powered strategies, but the core works offline.                          |
| **Zero external runtime deps**          | Core pipeline depends only on Node.js built-ins. MCP server deps (`@modelcontextprotocol/sdk`, `zod`) are isolated to `src/mcp/`. |
| **The user travels with their context** | Preferences, memory, and outcomes persist across platforms and sessions via the Komatik identity layer.                           |


## Project Structure

```
undercurrent/
├── src/
│   ├── index.ts                      # Public API — Undercurrent class + re-exports
│   ├── types.ts                      # The protocol — all interfaces and types
│   ├── engine/
│   │   ├── pipeline.ts               # 4-stage pipeline with graduated scope calibration
│   │   ├── session-monitor.ts        # Session health tracking (cold-start → critical)
│   │   ├── compactor.ts              # Context distillation (heuristic + LLM)
│   │   ├── checkpointer.ts           # Persistence via pluggable SessionWriter
│   │   └── model-router.ts           # TaskDomainClassifier, ModelScorer, ModelRouter
│   ├── adapters/
│   │   ├── conversation.ts           # Decisions, topics, terminology from chat history
│   │   ├── filesystem.ts             # Project structure, recent files, relevance-scored content
│   │   └── git.ts                    # Branch, commits, diff, working tree state
│   ├── komatik/                      # Komatik identity layer (@komatik/undercurrent/komatik)
│   │   ├── client.ts                 # KomatikDataClient + KomatikWriteClient interfaces
│   │   ├── types.ts                  # Row types for all ecosystem Supabase tables
│   │   ├── identity-adapter.ts       # komatik_profiles → who is this user
│   │   ├── preference-adapter.ts     # user_preferences → tone, style, code conventions
│   │   ├── memory-adapter.ts         # session_memories → cross-session persistent context
│   │   ├── history-adapter.ts        # user_product_events + crm → behavioral history
│   │   ├── outcome-adapter.ts        # enrichment_outcomes → feedback loop
│   │   ├── project-adapter.ts        # triage_intakes + floe_scans → active projects
│   │   ├── marketplace-adapter.ts    # forge_usage + forge_tools → marketplace activity
│   │   ├── session-writer.ts         # KomatikSessionWriter → session_memories persistence
│   │   ├── model-usage-adapter.ts    # model_availability + llm_usage + enrichment_outcomes
│   │   └── testing.ts                # createMockClient() for tests
│   ├── strategies/
│   │   ├── default.ts                # Heuristic (no LLM, deterministic) — reference impl
│   │   ├── komatik-pipeline.ts       # Domain-specific Komatik marketplace enrichment
│   │   └── platform-composer.ts      # Platform-aware output formatting (6 targets)
│   ├── mcp/                          # External MCP server (@komatik/undercurrent/mcp)
│   │   ├── postgrest-client.ts       # Lightweight PostgREST adapter (native fetch)
│   │   ├── server.ts                 # McpServer: 2 tools, 7 resources, 1 prompt
│   │   └── index.ts                  # Bin entry (undercurrent-mcp)
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
npm test             # 296 tests across 27 files
npm run dev          # Watch mode (tsc --watch)
npm run start:mcp    # Run the MCP server
```

## License

MIT