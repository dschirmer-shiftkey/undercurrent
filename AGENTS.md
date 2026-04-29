# Base Camp — Autonomous Agent Coordination Protocol

> This file is auto-generated from the Komatik hub workspace.
> Source: Komatik/.cursor/rules/KOMATIK-BASE-CAMP-PROMPT.md
> Last distributed: 2026-04-14
> Do not edit the Base Camp sections manually — they will be overwritten on next distribution.

# Working Safely with Base Camp — Autonomous Agent Coordination Protocol

> **Copy this entire document into the rules, AGENTS.md, or system prompt of any workspace
> that shares a repository with the Komatik platform ecosystem.**

---

## What Is Base Camp?

A team of **17 specialized AI agents** runs **24/7** on a headless Intel NUC (Ubuntu 24.04 LTS),
autonomously monitoring repositories, creating branches, opening pull requests, merging code,
running security scans, discovering knowledge, and coordinating through a custom MCP server
with 40+ RBAC-enforced tools. This system is called **Base Camp** and lives in the
`komatik-agents` repository (dashboard in `komatik-base-camp`).

**You are the last line of defense.** Agent-authored code flows into `dev` continuously —
sometimes 13+ PRs in a single day. Before any code reaches `staging` or `master`, it must
pass through human-supervised review. That review happens in YOUR workspace.

### Code Flow

```
┌──────────────────────────────────────────────┐
│  Base Camp NUC (24/7 Autonomous)               │
│  17 agents → branches → PRs → dev             │
│                                                │
│  GitHub Webhooks (BC6) ─────────────────┐     │
│  push, PR, CI, issues → events table    │     │
│  PR opened → auto-review workflow:      │     │
│    security-qa → api-architect →        │     │
│    release-mgr                          │     │
└────────────────────┬────────────────────┘
                     │  PRs flow continuously
                     ▼
┌──────────────────────────────────────────────┐
│  YOUR Workspace (Human-Supervised)            │
│  Review → Approve/Fix → staging → master      │
│  (Base Camp may have already pre-reviewed the PR) │
└──────────────────────────────────────────────┘
```

The NUC agents handle volume. You handle quality gates. Never merge agent code without review.

**New (BC6)**: When a PR is opened or marked ready-for-review, Base Camp automatically spawns a
3-step review workflow: **Sentinel** (security-qa) → **Blueprint** (api-architect) →
**Harbor** (release-mgr). Their findings appear as workflow steps in the events table.
Check for existing Base Camp review results before duplicating that work.

---

## The Base Camp Agent Team


| Codename      | Agent ID          | Role                                                        | Risk Level                    |
| ------------- | ----------------- | ----------------------------------------------------------- | ----------------------------- |
| **Koda**      | coordinator       | Chief of Staff — delegation, briefings, strategic oversight | LOW (orchestration only)      |
| **Relay**     | pipeline-ops      | Prebuild pipeline monitoring, DB health, Edge Functions     | **HIGH** (pipeline + DB)      |
| **Pixel**     | frontend-dev      | Next.js / React UI across all web applications              | MEDIUM (UI changes)           |
| **Vault**     | infra-ops         | Supabase, migrations, RLS policies, cron jobs               | **CRITICAL** (schema + infra) |
| **Sentinel**  | security-qa       | Security audits, vulnerability scanning (has veto power)    | LOW (read-only scanner)       |
| **Compass**   | product-pm        | Business logic, pricing, economics                          | LOW (advisory)                |
| **Ledger**    | payments          | Stripe integration, payouts, invoicing                      | **HIGH** (financial code)     |
| **Weaver**    | prompt-eng        | LLM prompt quality, model routing configuration             | MEDIUM (prompt/config)        |
| **Harbor**    | release-mgr       | Git operations, PRs, branch management, releases            | MEDIUM (merge authority)      |
| **Blueprint** | api-architect     | API contracts, cross-service validation (tiebreaker role)   | MEDIUM (contracts)            |
| **Scribe**    | tech-writer       | Documentation accuracy, README freshness                    | LOW (docs only)               |
| **Mirror**    | agent-tuner       | Agent performance tuning, prompt refinement                 | LOW (advisory)                |
| **Tracker**   | knowledge-scout   | Tool discovery, pattern mining, knowledge gaps              | LOW (research)                |
| **Orbit**     | satellite-watcher | Cross-repo monitoring — issues, CI, PRs across 11+ repos    | LOW (read-only)               |
| **Edison**    | rd-platform       | R&D platform research                                       | LOW (research)                |
| **Tesla**     | rd-satellite      | R&D satellite product research                              | LOW (research)                |
| **Beacon**    | marketing         | Marketing, growth, content, SEO tracking                    | LOW (content)                 |


### Monitored Repositories (11+)

The Base Camp agents track these repos. If your workspace touches any of them, Base Camp agents may also
be creating PRs against it:

- **Komatik** — parent monorepo (Next.js platform, orchestrator, knowledge engine)
- **komatik-agents** — the agent infrastructure itself
- **komatik-base-camp** — Base Camp dashboard
- **deployguard** — CI/CD deployment gates
- **daydream-studio** — AI game engine IDE
- **storyboard-studio** — AI narrative creation IDE
- **shieldcheck** — Floe: AI code security audits (security scanning arm of the GTM orbit)
- **reviewflow** — Traverse: AI-augmented code review
- **mcp-brokerage** — Forge: MCP tool marketplace
- **rescue-engineering** — Triage: production rescue service (beachhead product)
- **shadow-ai-governance** — Watchtower: enterprise shadow AI tool monitoring
- **cognitive-debt** — team health diagnostics
- **Bored** — infinite canvas desktop OS

---

## Recognizing Agent Branches

Base Camp agents create branches with these naming patterns. Learn to recognize them:


| Pattern                                | Origin                            | Example                                         |
| -------------------------------------- | --------------------------------- | ----------------------------------------------- |
| `claude/<two-word-slug>`               | Claude Code session on NUC        | `claude/keen-bell`, `claude/flamboyant-faraday` |
| `agent/<agent-id>/<description>`       | OpenClaw scheduled agent          | `agent/frontend-dev/fix-nav-a11y`               |
| `cursor/<description>-<4-char-hex>`    | Cursor session on NUC             | `cursor/deployguard-logic-issues-5ef5`          |
| `cursor/<description>` (no hex suffix) | **Probably YOUR local workspace** | `cursor/promote-dev-to-staging`                 |


**Ambiguity warning**: Both local workspaces and the NUC create `cursor/`* branches. To
confirm origin, check the commit author:

```bash
git log origin/<branch> -1 --format='%an <%ae>'
```

---

## The 4 Mandatory Workflows

### Workflow 1: Session Start — "What happened while I was away?"

**Run this at the start of EVERY new conversation before doing any work.**

```bash
# 1. Sync remote state
git fetch origin --prune

# 2. How far behind are we?
git log --oneline HEAD..origin/dev | wc -l

# 3. What agent PRs are open?
gh pr list --state open \
  --json number,title,headRefName,additions,deletions \
  --jq '.[] | select(.headRefName | test("^(claude/|agent/)")) | "#\(.number) +\(.additions)/-\(.deletions) — \(.title)"'

# 4. What agent PRs merged recently?
gh pr list --state merged --limit 20 \
  --json number,title,headRefName,mergedAt,additions,deletions \
  --jq '.[] | select(.headRefName | test("^(claude/|agent/)")) | "\(.mergedAt) #\(.number) +\(.additions)/-\(.deletions) — \(.title)"'
```

```bash
# 5. Check real-time GitHub events from Base Camp (BC6 webhook data)
CallMcpTool(server="user-komatik-readonly", toolName="query_events", arguments={"limit": 10})

# 6. Check if any NUC agent sent you a message
CallMcpTool(server="user-komatik-readonly", toolName="get_messages", arguments={"agent_id": "cursor-workspace"})
```

**Decision tree:**

- 0 behind, 0 open, 0 merged → Base Camp quiet. Proceed normally.
- Behind dev → Pull before starting work: `git pull origin dev`
- Open agent PRs → Check if Base Camp's automated review already ran (query events). Review if relevant to your current task.
- Many merged PRs (5+) → Pull dev, then run build + tests to verify stability.
- CI failure events in events table → Check if pipeline-ops is already handling it before investigating.

---

### Workflow 2: Before Starting a Task — "Did an agent already do this?"

**Run this BEFORE creating any feature branch for new work.**

```bash
# Search PRs by keyword (replace KEYWORD with your feature, e.g. "deployguard")
gh pr list --state all --limit 50 \
  --json number,title,headRefName,state \
  --jq '.[] | select(.title | test("KEYWORD"; "i")) | "\(.state) #\(.number) \(.headRefName) — \(.title)"'

# Search remote branches by keyword
git branch -r | grep -i "KEYWORD"
```

**Decision tree:**

```
Found matching work?
│
├── YES, open PR exists
│   → Review it using Workflow 3. If good, merge it. Do NOT reimplement.
│
├── YES, merged recently
│   → Pull dev. Verify the merge works. Skip reimplementation.
│
├── YES, branch exists but no PR
│   → Inspect the diff:
│     git log origin/<branch> --oneline --not origin/dev
│     If useful work → adopt it or open a PR from it.
│     If stale/incorrect → ignore it, start fresh.
│
└── NO matches found
    → Safe to proceed with new work.
```

**Why this matters**: In real testing, searching "deployguard" surfaced 6 recently merged
agent PRs and 3 stale agent branches — all covering work that would have been duplicated
without this check.

---

### Workflow 3: Reviewing an Agent PR — The 10-Point Security Checklist

**Run this for EVERY open PR from an agent branch before merging.**

#### Step 1: Fetch the full diff

```bash
gh pr diff <PR_NUMBER>
```

#### Step 2: Run the security checklist

A single failure at BLOCKING severity = **reject the PR**.

1. **No destructive SQL** — **BLOCKING**
   `gh pr diff N` — search added lines for `DROP TABLE`, `DELETE FROM` without `WHERE`, `TRUNCATE`, `ALTER TABLE ... DROP`

2. **RLS on new tables** — **BLOCKING**
   `gh pr diff N` — if `CREATE TABLE` appears, verify matching `CREATE POLICY` and `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`

3. **Auth on API routes** — **BLOCKING**
   `gh pr diff N --name-only` — if new `route.ts` files, verify `supabase.auth.getUser()` is present

4. **No secrets in code** — **BLOCKING**
   `gh pr diff N` — search added lines for `sk-`, `sk_live`, API key patterns, hardcoded passwords

5. **No force pushes** — **BLOCKING**
   Verify single clean commit chain — no rewritten history on shared branches

6. **Prompt sanitization** — **BLOCKING**
   Any new LLM calls (`callLLM`, `sendMessage`, `generateContent`) must wrap user input in `sanitizeForPrompt()`

7. **Ownership checks** — HIGH
   Data mutation routes must verify authenticated user owns the resource being modified

8. **Rate limiting** — HIGH
   Routes calling LLMs, Stripe, or batch operations must have rate limiting

9. **Type safety** — HIGH
   `gh pr diff N` — search added lines for `any` casts, `@ts-ignore`, `as unknown as`

10. **Import resolution** — MEDIUM
    New imports must resolve: `git ls-tree -r origin/dev --name-only` to verify imported files exist


#### Step 3: Check CI status

```bash
gh pr checks <PR_NUMBER>
```

All relevant checks should pass. Known pre-existing failures (like `Supabase Preview`) may
be non-blocking — use judgment.

#### Step 4: Check for local conflicts

```bash
gh pr diff <PR_NUMBER> --name-only   # files the agent PR touches
git diff --name-only                  # files we have modified locally
# If any files appear in BOTH lists = potential conflict. Resolve before merging.
```

#### Step 5: Render verdict

```bash
# APPROVE — all checks pass, CI green, no conflicts
gh pr review <PR_NUMBER> --approve --body "Reviewed: 10-point security checklist passed, CI green."

# REQUEST CHANGES — blocking issue found
gh pr review <PR_NUMBER> --request-changes --body "BLOCKING: [describe the specific issue and how to fix it]"

# CLOSE — destructive, fundamentally wrong, or superseded by other work
gh pr close <PR_NUMBER> --comment "Closing: [reason — e.g., superseded by #NNN, or contains destructive migration]"
```

---

### Workflow 4: After Agent Merges — Stability Check

**Run this after pulling dev that contains agent-merged code, or before any dev → staging promotion.**

```bash
# Pull latest
git checkout dev && git pull origin dev

# Build verification
npm run build

# Test verification
npm test
```

If agent merges touched **2 or more components** (e.g., migrations + API routes + UI), run
a structural coherence check: verify that schema changes have matching code updates, new
RPCs have callers, imports resolve, and API response shapes match their consumers.

---

## Trust Levels — What to Scrutinize

### HIGH TRUST (usually correct, quick review)

- Documentation updates (from Scribe agent)
- Dependency patch/minor updates
- Linter and formatter fixes
- Observability wiring (logging, tracing)
- Test additions

### VERIFY CAREFULLY (scan diff, check logic)

- Pipeline logic changes (from Relay) — complex state machines
- Model routing config (from Weaver) — affects LLM cost and output quality
- UI component changes (from Pixel) — may break responsive layouts
- API route modifications (from Blueprint) — contract changes cascade to consumers

### ALWAYS FULL LINE-BY-LINE REVIEW (never skip)

- **Schema migrations** (from Vault) — irreversible in production
- **RLS policy changes** — security-critical, one mistake = data leak
- **Stripe/payment code** (from Ledger) — financial impact
- **Auth code** — security-critical
- **Edge Function deployments** — go live in production immediately upon deploy

---

## Rapid-Fire Merge Detection

If you detect **3 or more PRs** from the same agent session merged within 60 minutes:

1. **Flag it** — rapid merges often mean the review-before-merge step was skipped or rushed
2. **Spot-check the middle PRs** — first and last PRs naturally get attention; middle ones slip through
3. **Run full build + test suite** on the result
4. **Check for accumulating regressions** — each PR may be fine alone but compound into bugs

Real-world example: `claude/keen-bell` merged 13 PRs in 6 hours (Apr 11, 2026), touching
pipeline logic, knowledge enrichment, model routing, and chassis provisioning.

---

## Emergency Procedure: Agent Merged Destructive Code

If you discover an agent merged harmful code (destructive SQL, auth bypass, secret leak):

1. **Don't panic.** `dev` is not production. `staging` and `master` are protected branches.
2. **Revert the merge commit immediately:**
  ```bash
   git revert <merge-commit-hash> --no-edit
   git push origin dev
  ```
3. **Close any open PRs** from the same agent session to prevent further damage.
4. **Notify David** — include the PR number, what was destructive, and the revert commit.
5. **Document the incident** for future reference.

---

## Base Camp Infrastructure Reference

These services run on the NUC (accessible via Tailscale VPN at `100.87.31.3`):


| Service              | Port  | Purpose                                         |
| -------------------- | ----- | ----------------------------------------------- |
| OpenClaw Gateway     | 18789 | Agent orchestration engine                      |
| Base Camp Dashboard  | 3100  | Unified command center (agents, CRM, financials, marketing) |
| Grafana              | 3200  | Time-series metrics and dashboards              |
| PostgreSQL 16        | 5432  | 25-table structured data store                  |
| ChromaDB             | 8000  | Vector database for semantic code search        |
| Plausible Analytics  | 8100  | Self-hosted website analytics (SEO, traffic)    |
| Code Server          | 3300  | VS Code in browser                              |
| Prometheus           | 9090  | Metrics scraping                                |

### Public Access via Tailscale Funnel (BC6)

Port 3100 is exposed publicly via Tailscale Funnel at:

```
https://komatik.tailf56017.ts.net
```

This is used by GitHub webhooks to deliver events. The webhook handler at
`/api/webhooks/github` validates HMAC-SHA256 signatures before writing to the `events`
table. A polling fallback cron runs every 15 minutes to catch missed events.

### GitHub Webhook Integration (BC6 — live as of April 12, 2026)

All 11 project repos have registered webhooks delivering these event types in real-time:
- `push` — branch updates, commits
- `pull_request` — opened, closed, merged, ready-for-review
- `check_run` — CI pass/fail
- `issues` — created, closed, labeled

**Automated PR review pipeline**: When a PR is opened or marked ready-for-review, Base Camp
spawns a 3-step workflow:
1. **Sentinel** (security-qa) — security scan
2. **Blueprint** (api-architect) — API contract validation
3. **Harbor** (release-mgr) — release readiness check

These review results are visible via `query_events` or the dashboard Activity feed.


---

## Base Camp Agent Scheduling

The agents run on cron schedules. All times are **US Pacific (PT)** — the NUC timezone.


| Time (PT) | Agent                     | Activity                                   |
| --------- | ------------------------- | ------------------------------------------ |
| 02:00     | Relay (pipeline-ops)      | Pipeline health check                      |
| 02:30     | Vault (infra-ops)         | Migration drift detection + DB health      |
| 06:00     | Tracker (knowledge-scout) | Research sweep (npm, PyPI, GitHub, MCP)    |
| 07:00     | Orbit (satellite-watcher) | Cross-repo status check                    |
| 08:00     | Relay (pipeline-ops)      | Pipeline health check                      |
| 09:00     | Koda (coordinator)        | **Morning briefing**                       |
| 10:00     | Pixel + Blueprint + others| **Dev sprint** (workflow step execution)   |
| 12:00     | Sentinel (security-qa)    | Security scan                              |
| 15:00     | Tracker (knowledge-scout) | Afternoon research sweep                   |
| 17:00     | Orbit (satellite-watcher) | Afternoon repo scan                        |
| 18:00     | Koda (coordinator)        | **Evening wrap-up**                        |
| 22:00     | Pixel (frontend-dev)      | Overnight dependency updates + issue fixes |


Heaviest autonomous coding activity happens overnight (22:00–06:00 PT). Expect the most
PRs and merges to accumulate during this window.

---

## Conflict Resolution

When your work conflicts with agent-created work:

1. **Same file, same fix** → If the agent's version is correct, adopt it. Don't create a competing fix.
2. **Same file, different approach** → Evaluate both. Prefer whichever is more consistent with existing patterns and has better test coverage.
3. **Schema conflicts** → The most recent migration wins IF it's been applied to dev. If it hasn't been applied, coordinate carefully — never create competing migrations with the same timestamp.
4. **Config conflicts** (model routing, cron schedules) → Your manual changes take precedence over agent changes. Agents can be re-run; manual decisions should be preserved.

---

## Quick Reference Card


| Situation                       | What to Do                                                   |
| ------------------------------- | ------------------------------------------------------------ |
| Starting a new session          | Fetch origin, check how far behind dev, check open agent PRs, check events table, check `get_messages` for Base Camp agent replies |
| Starting a new feature          | Search PRs + branches for keyword overlap first              |
| Open agent PR exists            | Check if Base Camp auto-review ran (`query_events`), then apply 10-point checklist |
| Agent PR has BLOCKING issue     | Request changes with specific fix instructions               |
| Agent merged bad code to dev    | `git revert <hash> --no-edit && git push origin dev`         |
| 3+ agent PRs merged in <1 hour  | Spot-check middle PRs, run full test suite                   |
| Agent branch but no PR          | Inspect diff — adopt if useful, ignore if stale              |
| Agent touched same files as you | Check for conflicts before committing your work              |
| Promoting dev → staging         | Review ALL agent merges since last promotion                 |
| Schema migration from agent     | **ALWAYS full line-by-line review** — never auto-merge       |
| CI failure in events table      | Check if pipeline-ops is already on it before acting         |
| Unsure about agent code quality | When in doubt, request changes. Better safe than sorry.      |
| Found issue during PR review    | `create_task` to put it on the board for a NUC agent to pick up |
| Need to redirect agent work     | `send_message` to coordinator — reads messages every 4 hours |
| Made an architectural decision  | `log_decision` to record reasoning in the audit trail        |


---

## Verifying Base Camp Runtime State

### The MCP Bridge — Read + Write (available in all Cursor workspaces)

An MCP server (`komatik-readonly`) connects every Cursor workspace to the NUC's
PostgreSQL database over Tailscale. It exposes 12 read tools and 5 rate-limited write
tools. Every write is tagged `cursor-workspace` so NUC agents know it came from you.

**Read tools (query state):**

```
CallMcpTool(server="user-komatik-readonly", toolName="get_system_health", arguments={})
CallMcpTool(server="user-komatik-readonly", toolName="query_agent_runs", arguments={"limit": 10})
CallMcpTool(server="user-komatik-readonly", toolName="query_tasks", arguments={"status": "active"})
CallMcpTool(server="user-komatik-readonly", toolName="get_messages", arguments={"limit": 5})
CallMcpTool(server="user-komatik-readonly", toolName="query_events", arguments={"limit": 20})
CallMcpTool(server="user-komatik-readonly", toolName="query_sql", arguments={"sql": "SELECT COUNT(*) FROM agent_runs"})
```

Available read tools: `get_system_health`, `query_agent_runs`, `query_tasks`, `query_events`,
`get_messages`, `query_sql` (SELECT only), `get_workflow`, `query_deals`, `query_contacts`,
`query_invoices`, `query_financials`, `list_skill_proposals`.

**Write tools (coordinate with NUC agents):**

| Tool | What It Does | Limit/Session |
| ---- | ------------ | ------------- |
| `send_message` | Send async message to any NUC agent (delivered at their next cron session) | 10 |
| `create_task` | Create a task on a project Kanban board (always lands in backlog) | 10 |
| `update_task_status` | Move a task to a new column (backlog/in-progress/review/done) | 20 |
| `log_decision` | Record a decision to the audit trail | 20 |
| `propose_skill` | Submit a skill/config change proposal (pending until human approves) | 5 |

```
CallMcpTool(server="user-komatik-readonly", toolName="send_message", arguments={"to_agent": "coordinator", "subject": "Priority shift", "body": "Deprioritize Floe bootstrap, focus on DeployGuard CI hardening", "priority": "high"})
CallMcpTool(server="user-komatik-readonly", toolName="create_task", arguments={"project_slug": "komatik", "title": "Fix OAuth redirect bug", "description": "Users get 404 after callback", "priority": "high"})
CallMcpTool(server="user-komatik-readonly", toolName="update_task_status", arguments={"task_id": "<uuid>", "column": "done"})
CallMcpTool(server="user-komatik-readonly", toolName="log_decision", arguments={"title": "Chose JWT over sessions", "reasoning": "Stateless auth simplifies NUC agent access", "outcome": "Implementing JWT with 24h expiry", "confidence": "high"})
CallMcpTool(server="user-komatik-readonly", toolName="propose_skill", arguments={"title": "Add Lighthouse CI", "description": "Run Lighthouse on every PR to track performance regressions", "skill_type": "cron"})
```

**How to use write tools effectively:**

- **Session start**: In addition to git fetch and `query_events`, check `get_messages(agent_id: "cursor-workspace")` to see if any NUC agent sent you a response.
- **When you find an issue during review**: `create_task` to put it on the board so a NUC agent picks it up (e.g., missing RLS policy → create a critical task assigned to security-qa).
- **When you need to redirect agent work**: `send_message` to the coordinator instead of waiting for David. The coordinator reads messages at every heartbeat (every 4 hours).
- **When you make an architectural decision**: `log_decision` to record the reasoning for the audit trail.

**Real-time GitHub events (BC6)** — the `events` table receives webhook data from all
11 repos. Query it to see pushes, PRs, CI failures, and issues in real-time:

```
CallMcpTool(server="user-komatik-readonly", toolName="query_events", arguments={"limit": 20})
CallMcpTool(server="user-komatik-readonly", toolName="query_sql", arguments={"sql": "SELECT event_type, repo, created_at FROM events ORDER BY created_at DESC LIMIT 10"})
```

### What You Still Cannot Do (by design)

Even with the write bridge, some operations remain restricted:

- Trigger cron jobs or agent sessions
- Write files to the NUC workspace or repos
- Create git branches, commits, or PRs on NUC repos
- Manipulate workflows (create, advance, complete, fail)
- Reset circuit breakers
- Create CRM records (deals, contacts, invoices)
- Approve skill proposals
- Access **OpenClaw gateway** internals (session scheduling, rate limits, queue depth)
- View **MCP tool invocation logs** (which tools agents called, RBAC denials)
- Read **live file contents** on the NUC (use `scripts/sync-to-cursor.sh` from the komatik-agents workspace for file sync)

### The Rule

**NEVER conclude that Base Camp "hasn't launched" or "isn't operational" based on
static git analysis alone.** Always query the MCP bridge first. The system is live and
operational — as of April 12, 2026: 41 agent runs completed (95% success), 9 of 17
agents active, 34 inter-agent messages, 5 running workflows, 38 tasks on the board.

Placeholder files in git (like empty intel reports) do NOT mean the system hasn't run.
Runtime state lives in PostgreSQL, not in git-committed files.

### Roadmap Status (as of April 12, 2026)

- **BC6 (GitHub Webhook Integration)**: COMPLETED — real-time event delivery from all 11 repos
- **BC8 (QuickBooks Online OAuth2 flow)**: Active — the only remaining Base Camp goal

### Known Open Issues (as of April 12, 2026)

1. **5 of 6 intel files still placeholders** — only `intel/REPO-STATUS.md` has real data
   from satellite-watcher. The other 5 (DAILY-INTEL, INCIDENTS, INFRA-HEALTH,
   PIPELINE-HEALTH, SECURITY-REPORT) are awaiting their first agent-written sweep.

---

## Summary

> **The agents work for us. We don't work for them.**
>
> They generate code at scale. We ensure that code is safe, correct, and consistent.
> Never let velocity override quality. A single destructive migration or auth bypass
> undoes the value of a hundred clean PRs.
>
> Check before you build. Review before you merge. Test before you promote.
>
> And never judge a running system by its git snapshots alone.


---

## Project-Specific

<!-- Add project-specific Claude Code instructions below this line -->
<!-- These sections are preserved across re-distributions -->

### Undercurrent — Developer Context

**What this is**: Undercurrent (`@komatik/slipstream`) — a context engineering and personalization SDK. 4-stage pipeline that invisibly transforms vague human messages into structured, context-rich prompts before the model sees them. Internally we call it the "translation device."

**Stack**: TypeScript 6.0+, ESM-only, Node 20+, zero runtime dependencies. Dev deps: vitest, typescript, @types/node, @modelcontextprotocol/sdk, zod.

**Build & test**:
```bash
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
npm test            # vitest run — 341 tests in 28 files
npm run start:mcp   # Run the MCP server (requires env vars)
npm run playground  # Interactive REPL — live pipeline testing (tsx)
npm run replay      # Batch transcript replay with reports (tsx)
```

**Source layout**:
```
src/
├── types.ts                 # THE protocol — read first before any work
├── index.ts                 # Public API (Undercurrent class + re-exports)
├── engine/
│   ├── pipeline.ts          # 4-stage pipeline: classify → harvest → analyze → compose + process()
│   ├── session-monitor.ts   # Session health tracking (cold-start → healthy → degrading → critical)
│   ├── compactor.ts         # Context distillation (heuristic + LLM-assisted)
│   ├── checkpointer.ts      # Persistence orchestration via pluggable SessionWriter
│   └── model-router.ts      # TaskDomainClassifier, ModelScorer, ModelRouter
├── adapters/                # Pluggable context sources
│   ├── conversation.ts      # Chat history (decisions, topics, terminology)
│   ├── git.ts               # Branch, commits, diff, working tree
│   └── filesystem.ts        # Project structure, recent files, relevant content
├── komatik/                 # Komatik ecosystem identity layer (@komatik/slipstream/komatik)
│   ├── client.ts            # KomatikDataClient + KomatikWriteClient interfaces
│   ├── types.ts             # Row types for all Supabase tables (PR #800 + internal track)
│   ├── identity-adapter.ts  # komatik_profiles → who is this user
│   ├── preference-adapter.ts # user_preferences → tone, style, code conventions
│   ├── memory-adapter.ts    # session_memories → cross-session decisions, active work
│   ├── history-adapter.ts   # user_product_events + crm_activities → behavioral history
│   ├── outcome-adapter.ts   # enrichment_outcomes → acceptance/rejection feedback loop
│   ├── project-adapter.ts   # triage_intakes + floe_scans → active projects
│   ├── marketplace-adapter.ts # forge_usage + forge_tools → marketplace activity
│   ├── session-writer.ts    # KomatikSessionWriter → session_memories persistence
│   ├── model-usage-adapter.ts # model_availability + llm_usage + enrichment_outcomes → scoring
│   └── testing.ts           # createMockClient() for tests
├── mcp/                     # External MCP server (@komatik/slipstream/mcp)
│   ├── postgrest-client.ts  # Lightweight PostgREST adapter (native fetch, no Supabase SDK)
│   ├── server.ts            # McpServer: 2 tools, 7 resources, 1 prompt
│   └── index.ts             # Bin entry (undercurrent-mcp) — reads env vars, stdio transport
├── strategies/              # Pluggable enrichment logic
│   ├── default.ts           # Heuristic (no LLM, deterministic) — reference impl
│   ├── llm.ts               # LLM-assisted strategy (pluggable llmCall callback, DefaultStrategy fallback)
│   ├── komatik-pipeline.ts  # Domain-specific (Komatik marketplace enrichment)
│   └── platform-composer.ts # Platform-aware output formatting (Cursor, Claude, ChatGPT, API, MCP)
├── playground/              # Live pipeline test harness (excluded from build, runs via tsx)
│   ├── transcript-parser.ts # Parse .jsonl agent transcripts → pipeline-ready input
│   ├── formatter.ts         # Colorized stage-by-stage terminal output
│   ├── repl.ts              # Interactive REPL (npm run playground)
│   └── replay.ts            # Batch transcript replay with reports (npm run replay)
└── transports/
    └── middleware.ts         # Express middleware + Fetch API handler
```

**Key conventions**:
- All imports use `.js` extension (`import { Foo } from "./foo.js"`)
- Type-only imports use `import type`
- Node built-ins use `node:` prefix
- No `any`, no `@ts-ignore` — use `unknown` and narrow
- Unused params prefixed with `_`
- Barrel exports in each directory's `index.ts`
- Tests colocated: `pipeline.ts` → `pipeline.test.ts`

**Komatik identity layer** (`src/komatik/`):
- 7 adapters query Supabase tables from Komatik ecosystem architecture
- `KomatikDataClient` interface — accepts any Supabase client, zero deps
- `EnrichInput.enrichmentContext` — optional per-message metadata (source app, session ID)
- Import from `@komatik/slipstream/komatik`
- Mock client for tests: `createMockClient()` from `src/komatik/testing.ts`
- New internal track adapters (3 new tables):
  - `KomatikPreferenceAdapter` → `user_preferences` — tone, style, code conventions, always/never assume rules
  - `KomatikOutcomeAdapter` → `enrichment_outcomes` — tracks acceptance/rejection/revision of past enrichments
  - `KomatikMemoryAdapter` → `session_memories` — cross-session persistent context (decisions, active work, unresolved items)

**External MCP server** (`src/mcp/`):
- Exposes Undercurrent to Cursor, Claude, AntiGravity via stdio MCP transport
- Tools: `enrich` (full pipeline, accepts `platform` param), `get_context` (raw context layers)
- Resources (7): `komatik://user/profile`, `komatik://user/preferences`, `komatik://user/memory`, `komatik://user/history`, `komatik://user/outcomes`, `komatik://user/projects`, `komatik://user/tools`
- Prompts: `enrich-message` (system prompt pre-loaded with full user context from all 7 adapters)
- `PostgREST client` — lightweight `KomatikDataClient` using native `fetch`, no `@supabase/supabase-js`
- Env vars: `KOMATIK_SUPABASE_URL`, `KOMATIK_SUPABASE_KEY`, `KOMATIK_USER_ID`
- Import from `@komatik/slipstream/mcp`; bin: `undercurrent-mcp`

**Platform-aware composition** (`src/strategies/platform-composer.ts`):
- Formats enriched output differently per target platform via `TargetPlatform` type
- `cursor` — XML-tagged blocks (`<user_request>`, `<context>`, `<assumptions>`)
- `claude` — Semantic XML with user profile grouping, memory, learning blocks
- `chatgpt` — Markdown-formatted with bold headers and bullet lists
- `api` — Structured JSON with full data payloads
- `mcp` — Compact text with separator for MCP tool responses
- `generic` — Labeled text blocks (backward-compatible default format)
- Per-request override via `EnrichInput.targetPlatform` or config default

**Graduated scope calibration** (`pipeline.determineDepth`):
- Replaced binary passthrough with multi-signal scoring system
- Signals: specificity, scope, action complexity, emotional load, confidence
- Score → depth mapping: ≤1 none, 2-3 light, 4-6 standard, ≥7 deep
- Frustrated/uncertain users get escalated depth automatically
- Low-confidence classifications trigger deeper enrichment

**Playground / test harness** (`src/playground/`):
- `npm run playground` — interactive REPL: type messages, see stage-by-stage enrichment (intent, depth, context, gaps, assumptions, enriched output). Commands: `/platform <target>`, `/debug`, `/reset`, `/replay <path>`, `/history`.
- `npm run replay -- <path.jsonl>` — batch-process Cursor agent transcripts (.jsonl). Per-message table, aggregate stats (depth distribution, intent actions, domain hints, gap types), interesting-case analysis. `--output report.json` for machine-readable output, `--verbose` for full detail.
- Both tools wire real pipeline with generic adapters (Conversation, Git, Filesystem). No mocks, no Komatik adapters.
- Excluded from tsconfig build. Runs via `tsx` (devDep).

**Session Lifecycle Management** (`src/engine/session-monitor.ts`, `compactor.ts`, `checkpointer.ts`):
- Invisible context management that eliminates the "session tax" — no manual briefing, cleanup, or resuming
- `SessionMonitor` tracks health: cold-start → healthy → warm → degrading → critical (based on message count, estimated tokens, elapsed time, topic drift)
- `Compactor` distills degrading sessions via heuristic or LLM-assisted compaction into `CompactionResult` (summary, decisions, active work, unresolved items, terminology, token savings)
- `Checkpointer` persists state via pluggable `SessionWriter` interface — writes memories, snapshots, handoff artifacts
- `KomatikSessionWriter` (`src/komatik/session-writer.ts`) implements persistence to Komatik's `session_memories` table via `KomatikWriteClient`
- Pipeline auto-restores context on cold starts (empty conversation + existing snapshot), auto-compacts on degradation/critical health
- `HandoffArtifact` — structured document for cross-session continuity (completed work, active work, decisions, next steps, terminology)
- Config: `UndercurrentConfig.sessionMonitor` with `tokenBudget`, `checkpointInterval`, `compactionThreshold`, `writer`, `compactorLlmCall`

**Intelligent Model Router** (`src/engine/model-router.ts`, `src/komatik/model-usage-adapter.ts`):
- Per-user, per-domain model selection — Komatik internal first, opt-in via `UndercurrentConfig.modelRouter`
- `TaskDomainClassifier` maps `IntentSignal` to 6 domains: coding, creative, analysis, planning, debugging, conversation (heuristic, no LLM needed)
- `ModelScorer` ranks active models: `score = (w1 * successRate) + (w2 * acceptanceRate) + (w3 * (1 - normLatency)) + (w4 * affinityBonus)` — affinity weight auto-decays from 0.25 to 0.05 as real data exceeds 50 points
- Default affinities: coding → Anthropic/OpenAI, creative → Google/Anthropic, analysis → OpenAI/Google
- `KomatikModelUsageAdapter` queries three tables: `model_availability` (active roster from Tracker agent), `llm_usage` (success/latency/cost per model per user), `enrichment_outcomes` (acceptance rate per provider)
- `Undercurrent.process(input)` = enrich → classify domain → load scoring data → rank models → call top model via pluggable `ModelCallerFn` → return `ProcessResult`
- `enrich()` unchanged; `process()` is additive; zero new runtime dependencies
- Komatik products pass their existing LLM gateway function as the `caller` callback
- `ModelRecommendation` includes confidence (0-1), human-readable reasoning, data points count
- `onModelSelected` callback for observability

**Critical invariants**:
- Zero external runtime dependencies in core — only `node:*` built-ins (`src/mcp/` has `@modelcontextprotocol/sdk` + `zod`)
- DefaultStrategy is fully deterministic — same input = same output, no network, no randomness
- Pipeline never crashes on adapter failure — graceful degradation via Promise.allSettled
- High-specificity + atomic-scope messages pass through unchanged (zero enrichment overhead)
- Max 2 clarifications surface to the user; everything else is assumed and transparently stated
- Expired session memories are automatically filtered out at query time

**Design principles** (violating any of these is a bug):
1. Invisible by default — user never sees the enrichment
2. 3-Second Rule — any clarification answerable in < 3 seconds
3. Bias toward action — assume and state, don't interrogate
4. Proportional enrichment — simple = passthrough, complex = deep
5. Container, not contents — pipeline + plugin system, not business logic
6. The user travels with their context — preferences, memory, and outcomes persist across platforms and sessions
