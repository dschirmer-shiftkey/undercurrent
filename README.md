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
                    ┌─────────────────────────┐
                    │     Your Application     │
                    │                          │
  "fix the auth" → │  ┌────────────────────┐  │
                    │  │    Undercurrent     │  │
                    │  │                     │  │
                    │  │  ┌──────────────┐   │  │
                    │  │  │   Pipeline    │   │  │
                    │  │  │              │   │  │
                    │  │  │  1. Classify  │   │  │
                    │  │  │  2. Harvest   │◄──┼──┼── Adapters (pluggable)
                    │  │  │  3. Analyze   │   │  │   ├── Conversation
                    │  │  │  4. Compose   │◄──┼──┼── Strategy (pluggable)
                    │  │  │              │   │  │   ├── Filesystem
                    │  │  └──────┬───────┘   │  │   ├── Git
                    │  │         │            │  │   └── (your own)
                    │  └─────────┼────────────┘  │
                    │            ▼                │
                    │     EnrichedPrompt → LLM   │
                    └─────────────────────────────┘
```

## Core Concepts

### The Pipeline

4 stages, executed in order:

| Stage | What It Does | Who Controls It |
|-------|-------------|-----------------|
| **Classify** | Determines intent (action, specificity, scope, emotion) | Strategy |
| **Harvest** | Gathers context from all available adapters in parallel | Adapters |
| **Analyze** | Identifies gaps and resolves them (auto-fill, assume, or clarify) | Strategy |
| **Compose** | Builds the enriched message from all signals | Strategy |

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

Ship with: `ConversationAdapter`, `FilesystemAdapter`, `GitAdapter`. Build your own for Jira, Slack, Notion, databases, session stores — anything that holds context about what the user is doing.

### Strategies

Pluggable enrichment logic. Each strategy implements `EnrichmentStrategy`:

```ts
interface EnrichmentStrategy {
  readonly name: string;
  classifyIntent(message: string, conversation: ConversationTurn[]): Promise<IntentSignal>;
  analyzeGaps(intent: IntentSignal, context: ContextLayer[], message: string): Promise<Gap[]>;
  resolveGap(gap: Gap, context: ContextLayer[], threshold: number): Promise<GapResolution>;
  compose(message: string, intent: IntentSignal, context: ContextLayer[], assumptions: Assumption[], gaps: Gap[]): Promise<string>;
}
```

Ships with: `DefaultStrategy` (heuristic, no LLM, fully deterministic). Build your own that delegates to GPT, Claude, Gemini — or a fine-tuned model trained on your domain.

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

### The EnrichedPrompt

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
  metadata: EnrichmentMetadata;   // Pipeline timing, depth, adapter performance
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

| Principle | What It Means |
|-----------|---------------|
| **Container, not contents** | Undercurrent provides the pipeline and plugin system. You bring the intelligence. |
| **Invisible by default** | The user never knows enrichment is happening. They just get better responses. |
| **Bias toward action** | A stated wrong assumption is cheaper than a right question. The engine assumes and surfaces, rather than interrogating. |
| **3-Second Rule** | Any clarification that reaches the user must be answerable in under 3 seconds. Binary, default-with-opt-out, or pick-from-3. |
| **Proportional enrichment** | Simple messages get zero overhead. Complex messages get the full pipeline. The engine calibrates automatically. |
| **No LLM dependency** | The default strategy is pure heuristics. You can add LLM-powered strategies, but the core works offline. |

## Project Structure

```
undercurrent/
├── src/
│   ├── index.ts                 # Public API — Undercurrent class + re-exports
│   ├── types.ts                 # The protocol — all interfaces and types
│   ├── engine/
│   │   └── pipeline.ts          # The 4-stage enrichment pipeline
│   ├── adapters/
│   │   ├── conversation.ts      # Extracts decisions, topics, terminology from chat history
│   │   ├── filesystem.ts        # Project structure, recent files, relevance-scored content
│   │   └── git.ts               # Branch, commits, diff, working tree state
│   ├── strategies/
│   │   └── default.ts           # Heuristic intent classification + gap analysis
│   └── transports/
│       └── middleware.ts         # Express middleware + Fetch API handler
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT
