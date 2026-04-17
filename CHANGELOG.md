# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-04-17

### Added
- Session lifecycle management — invisible context tracking across long sessions
  - `SessionMonitor` tracks health: cold-start, healthy, warm, degrading, critical
  - `Compactor` distills degrading sessions via heuristic or LLM-assisted compaction
  - `Checkpointer` persists state via pluggable `SessionWriter` interface
  - `KomatikSessionWriter` writes to Komatik's `session_memories` table
- Intelligent model router — per-user, per-domain model selection
  - `TaskDomainClassifier` maps intent to 6 domains (coding, creative, analysis, planning, debugging, conversation)
  - `ModelScorer` ranks models by success rate, acceptance rate, latency, and affinity
  - `KomatikModelUsageAdapter` queries `model_availability`, `llm_usage`, `enrichment_outcomes`
  - `Undercurrent.process()` = enrich + classify + score + call via pluggable `ModelCallerFn`
- Live pipeline test harness (`npm run playground`, `npm run replay`)
- Platform-aware composition for Cursor, Claude, ChatGPT, API, MCP, and generic targets
- Graduated scope calibration — multi-signal scoring replaces binary passthrough
- Internal development track adapters: preferences, outcomes, memory
- npm publish readiness: `files` field, `prepublishOnly`, `publishConfig`, LICENSE
- Release workflow: publish to npm on tag push
- CI: build verification and package validation steps
- Vitest coverage configuration with thresholds
- ESLint + Prettier configuration
- Dependabot for automated dependency updates

### Changed
- MCP dependencies (`@modelcontextprotocol/sdk`, `zod`) moved to optional peer dependencies
- Version bumped to 0.2.0

## [0.1.0] - 2026-04-16

### Added
- Core 4-stage pipeline: classify intent, harvest context, analyze gaps, compose output
- `DefaultStrategy` — heuristic, deterministic, zero LLM dependency
- `KomatikPipelineStrategy` — domain-specific enrichment for the Komatik marketplace
- Generic adapters: `ConversationAdapter`, `GitAdapter`, `FilesystemAdapter`
- Komatik identity layer: 7 adapters for identity-aware enrichment via Komatik ID
- External MCP server with 2 tools, 7 resources, 1 prompt
- PostgREST client for Supabase access without `@supabase/supabase-js`
- Express middleware + Fetch API handler transports
- Pipeline hooks for observability
- Zero external runtime dependencies in core
