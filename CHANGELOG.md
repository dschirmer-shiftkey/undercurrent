# Changelog

All notable changes to this project will be documented in this file.

## [2.0.0] - 2026-05-17

### BREAKING

- Renamed `Undercurrent` → `Slipstream` throughout. The package has been `@komatik/slipstream` since launch; the class and identity now match.
  - Class: `Undercurrent` → `Slipstream`
  - Config type: `UndercurrentConfig` → `SlipstreamConfig`
  - MCP factory: `createUndercurrentMcpServer` → `createSlipstreamMcpServer`
  - MCP server identity (handshake): `name: "undercurrent"` → `name: "slipstream"`
  - npm bin: `undercurrent-mcp` → `slipstream-mcp`
  - Express middleware property: `req.undercurrent` → `req.slipstream`
  - Preserved: `undercurrent_settings` Komatik Supabase column (renaming would break the integration).

### Added

#### Context Reliability System foundations (PRs #56, #57)
- Governance presets: `strict-governance`, `balanced`, `speed-first` (plus `safety-first` from 1.0.0)
- Stale-context filtering, confidence gates, bounded assumptions per message
- Stage-by-stage `EnrichmentTrace` events and `GovernanceSummary.interventions` in metadata
- Replay-harness benchmarking: quality-per-token, governed vs unguided reliability metrics
- MCP `enrich` accepts preset override and returns trace + governance metadata

#### Production pilot path (PRs #60, #61, #69)
- `KomatikPilotProcessor` wrapping `Slipstream.process()` with per-request ROI telemetry (latency split, token efficiency, governance interventions, blocked assumptions) and acceptance outcome tracking
- MCP pilot tools: `process_with_pilot`, `record_pilot_outcome`, `get_pilot_roi_summary`
- `runPilotSimulation()` end-to-end harness in `@komatik/slipstream/komatik` — wires Slipstream → `KomatikPilotProcessor` → `KomatikOutcomeWriter` with mock clients and stub caller for local iteration before porting to real products
- CLI: `npm run playground:pilot -- --transcript X [--preset safety-first --verbose]`
- Exposes `PilotSimulationOptions`, `PilotSimulationResult`, `PilotSimulationMessage` types

#### CI reliability gate matrix (PRs #60, #68, #69)
- `npm run eval:reliability` runs a (fixture × preset) matrix from `ci/reliability-matrix.json` with per-cell baselines and thresholds
- 7 default cells covering `balanced` / `safety-first` / `strict-governance` presets across `reliability-ci`, `preflight-stress`, and `governance-stress` fixtures
- New metrics target preflight regressions: `blockingClarificationRate` and `highCascadeRiskRate`
- `npm run eval:reliability:single` preserves the single-cell mode; `npm run eval:reliability:update` regenerates baselines
- New fixtures `fixtures/replay/preflight-stress.jsonl` and `fixtures/replay/governance-stress.jsonl`

### Changed

- **Safety-first preflight** (PR #67): tokenized negation detection and content-significance guards in the contradiction detector. Previously, substring matching on `"no"` / `"not"` / `"never"` fired false-positive contradictions on benign messages containing words like `node`, `notion`, `now`, `notes`. Combined with a 40%-overlap threshold over `Math.min(a, b)` that fired on a single shared word against small recent-decision sets, this produced 683 of the 783 blocking clarifications observed during 1.0.0 validation. The fix requires ≥3 content words on both sides and ≥2 shared words before computing the overlap ratio. Negation detection now tokenizes and checks set membership (including the multi-token `do not` and contractions like `cannot`/`cant`/`won't`/`shouldn't`).
- **Reliability gate determinism** (PR #69): the matrix gate now uses `ConversationAdapter` only. Previously the `Git` and `Filesystem` adapters made the gate sensitive to repo state (any new file shifted token counts), masking real strategy/preset/preflight regressions. Restricting the gate to deterministic-by-transcript adapters surfaces the regressions it was designed to catch. Secondary effect: `strict-governance` now actually shows distinct metrics from `balanced` (1.2 interventions/msg, 100% blocked-assumption rate on governance-stress); previously that signal was hidden by adapter noise.

### Fixed

- ReDoS code-scanning alerts in parsing heuristics (PR #58)
- Scanner-based parsing regression coverage to lock in the ReDoS fixes (PR #59)

## [1.0.0] - 2026-05-16

### Added

- Closed enrichment feedback loop persistence:
  - `KomatikOutcomeWriter` for writing `enrichment_outcomes` telemetry rows and verdict updates
  - `Slipstream.recordVerdict()` API for linking user feedback to `metadata.enrichmentId`
  - `OutcomeWriter`/`OutcomeWriterConfig` protocol types
- `EnrichmentMetadata.enrichmentId` on every enrichment result for stable verdict linkage.
- Safety-first preflight interception layer:
  - `src/engine/preflight.ts` with typo correction, continuation normalization, cascade-risk scoring, and contradiction detection
  - `PreflightResult`, `Correction`, `CascadeRisk`, `PreflightPolicy` types
  - New governance preset: `safety-first`
- Replay harness metrics for preflight behavior:
  - `preflightCorrectionsTotal`
  - `blockingClarificationsTotal`
  - `cascadeRiskDistribution`
  - `--preset` support in replay runs
- New MCP capabilities:
  - `suggest_followups`
  - `record_suggestion_feedback`
  - `process_with_pilot`
  - `record_pilot_outcome`
  - `get_pilot_roi_summary`
  - `digest_tool_result`

### Changed

- Pipeline now supports optional pre-classification interception under `safety-first`.
- Gap resolution is stricter under high cascade risk, biasing toward clarifications over assumptions.
- MCP `preset` enum now includes `safety-first`.

### Security

- Replaced regex-based preflight token/whitespace trimming with linear character scanning to resolve CodeQL polynomial ReDoS findings (`js/polynomial-redos`).

## [0.4.0] - 2026-04-25

### Added

#### Token-waste reduction (PR #35)
- `metadata.tokens` (`TokenAccounting`) on every enrichment result — `{ originalMessage, enrichedMessage, context, contextByAdapter, overhead }` for granular per-adapter accounting
- `metadata.budget` (`BudgetMeter`) when `sessionMonitor` is configured — `{ used, budget, available, utilization, pressure, perAdapter, trend }` with low/moderate/high/critical pressure levels
- Per-model token estimation in `SessionMonitor` — Claude/GPT/Gemini-aware chars-per-token lookup replaces the fixed 4-chars/token heuristic
- `FilesystemAdapter.maxContentTokens` budget — slices file contents to fit, annotates layers with `truncated: boolean` and `estimatedTokens: number` (default 5000 tokens, replaces unbounded 5×50KB ceiling)
- `KomatikMemoryAdapter.maxRestoreTokens` cap — handoff restoration respects a token budget and appends `[truncated]` when reached
- `KomatikSessionWriter` dedup — within-batch + cross-session normalized-content dedup before upsert; query failures gracefully fall back to within-batch only
- Re-read detection in `ConversationAdapter` — flags file paths and grep queries fetched 2+ times across recent assistant turns
- Abandonment detection in `ConversationAdapter` — pivot regexes (`scratch that`, `different approach`, `actually let's…`) tag preceding turns as superseded
- Drift+age compaction trigger in `SessionMonitor` — 3+ topic shifts AND >30min elapsed → `degrading` health even below the 65% token threshold

#### Follow-up suggestions (PR #32)
- `Slipstream.suggestFollowups()` — experimental post-response reflection; given the user's message and the agent's response, returns 3-5 auto-complete prompt suggestions categorized as `continue` / `amend` / `stop`
- `Slipstream.recordSuggestionFeedback()` — logs `accepted` / `dismissed` / `edited` outcomes back to `enrichment_outcomes` for the scoring loop
- `suggest_followups` and `record_suggestion_feedback` MCP tools

### Changed
- External positioning leads with "context engineering and personalization SDK" — `package.json` description, `README.md` hero, MCP `enrich` tool description, `AGENTS.md` project-section opener (PR #36)
- MCP server identity version aligned to package version (was hardcoded `0.2.0` since 0.2 → 0.3 transition)

## [0.3.1] - 2026-04-23

### Added
- `acknowledge` and `report` action types — conversational acknowledgments ("thanks", "perfect", "sounds good") and status pastes (CI output, test reports, stack traces) bypass enrichment entirely via new `Action` variants
- Typo-tolerant action classifier — Damerau-Levenshtein fallback catches misspelled verbs like `udpate`, `imlement`, `destoryed`, `refactr` after exact patterns miss (length-aware threshold: 1 edit for 4–6 char words, 2 for longer)
- Selection-reference detection — messages like "option a please", "A+B", "all of the above", "items 1-5", "both" fire a critical gap when no memory context exists; file/scope gaps are suppressed (prior turn established those)
- Context-aware gap suppression — file-location and scope-ambiguity gaps no longer fire when conversation/memory layers already establish those; vague-pronoun threshold raised when conversation context is present
- Claude Code `.jsonl` parser in `transcript-parser.ts` — auto-detects Cursor vs Claude Code format, filters `isMeta`/`isSidechain`/tool-result envelopes, strips `<system-reminder>` and `<command-*>` tags
- Replay-harness fixtures and tests for both transcript formats

### Changed
- `DefaultStrategy.classifyAction` routes through status-paste → acknowledgment → pattern → fuzzy-match → fallback
- `DefaultStrategy.extractKeyFragments` captures selection tokens (option a, A+B, items 1-5, first/second/last one)
- `Pipeline.determineDepth` short-circuits to `"none"` for `acknowledge` and `report` actions

### Fixed
- Real-transcript replay on a 30-message Komatik corpus: total gaps 59 → 16 (-73%), "no file referenced" noise 24× → 0, unknown-action classifications cut in half

## [0.3.0] - 2026-04-19

### Added
- `AdapterResult` type — per-adapter status tracking (`ok`/`empty`/`unavailable`/`error`) in `EnrichmentMetadata.adapterResults`
- `LlmStrategy` — LLM-assisted enrichment with pluggable `llmCall` callback and automatic `DefaultStrategy` fallback
- Temporal/memory reference detection in `DefaultStrategy.analyzeGaps()` — flags "last time", "same approach", "as before" when no memory context exists
- Vague pronoun detection threshold lowered — flags single ambiguous references when no supporting context exists
- Ultra-terse message flagging — messages under 5 words are flagged as underspecified
- File-reference gap detection for `unknown` action intents
- `"memory"` domain hint in `extractDomainHints()` for temporal references
- Temporal phrase extraction in `extractKeyFragments()`
- Expanded action vocabulary: refactor, update, change, modify, rename, move, replace, migrate, optimize, improve, clean up, remove, delete, deploy, ship, publish, release, configure, enable, disable
- Named component specificity boost, feature enumeration detection, transform signals
- Comprehensive tests for adapter result tracking, gap analysis heuristics, and LLM strategy

### Changed
- **TypeScript 6.0** — upgraded from 5.9 (zero source changes required)
- `package.json` exports now include `require` and `default` conditions for CJS compatibility
- Pipeline `harvestContext()` returns `adapterResults` alongside layers
- `@modelcontextprotocol/sdk` and `zod` added to devDependencies (in addition to optional peerDependencies) to ensure CI typecheck reliability

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
  - `Slipstream.process()` = enrich + classify + score + call via pluggable `ModelCallerFn`
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
