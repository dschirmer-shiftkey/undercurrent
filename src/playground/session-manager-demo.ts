import {
  SlipstreamSessionManager,
  type SessionEvent,
  type TierBias,
} from "../komatik/session-manager.js";
import { createMockClient, createMockWriteClient } from "../komatik/testing.js";
import type { ModelCallerFn, ModelCallerOutput } from "../types.js";

// Simulates the IDE-shaped flow:
//   open session → user message → response → user accepts → next message
//   → eventually close session. Prints model selection, telemetry, and drift
//   gauge per turn so we can validate the end-to-end wiring visually.

const MODEL_ROSTER = [
  { provider: "anthropic", api_model_name: "claude-sonnet-4-6", status: "active", smoke_test_latency_ms: 220 },
  { provider: "anthropic", api_model_name: "claude-opus-4-7", status: "active", smoke_test_latency_ms: 380 },
  { provider: "openai", api_model_name: "gpt-5-mini", status: "active", smoke_test_latency_ms: 190 },
  { provider: "openai", api_model_name: "gpt-5", status: "active", smoke_test_latency_ms: 340 },
  { provider: "google", api_model_name: "gemini-2-pro", status: "active", smoke_test_latency_ms: 260 },
];

function makeCaller(): ModelCallerFn {
  return async ({ model, provider, enrichedSystemPrompt }): Promise<ModelCallerOutput> => {
    // Simulated latency: higher for premier-tier models, lower for cheaper ones.
    const baseLatency =
      model.includes("opus") || model.includes("gpt-5") && !model.includes("mini") ? 320 : 110;
    await new Promise((r) => setTimeout(r, baseLatency));
    return {
      content: `Simulated ${provider}/${model} response to: ${enrichedSystemPrompt.slice(0, 60)}...`,
      model,
      provider,
      inputTokens: Math.ceil(enrichedSystemPrompt.length / 4),
      outputTokens: 48,
      latencyMs: baseLatency,
    };
  };
}

const SCRIPT: { user: string; verdict: boolean }[] = [
  { user: "Fix the auth crash in src/auth/login.ts when token is missing.", verdict: true },
  { user: "Also add a regression test for the null-token path.", verdict: true },
  { user: "Refactor the billing proration to support split ledgers with midpoint rounding.", verdict: true },
  { user: "Switch the worker pool to the node runtime for the developer pages.", verdict: false },
  { user: "Review the notion of caching in the developer pages notes.", verdict: true },
  { user: "Slipstream replay green; merge when CI is green.", verdict: true },
];

function tierFromArgv(): TierBias {
  const idx = process.argv.indexOf("--tier");
  if (idx >= 0 && process.argv[idx + 1]) {
    const v = process.argv[idx + 1]!;
    if (v === "budget" || v === "balanced" || v === "premier") return v;
  }
  return "balanced";
}

function scopeFromArgv(): "sandbox" | "project" {
  const idx = process.argv.indexOf("--scope");
  if (idx >= 0 && process.argv[idx + 1] === "sandbox") return "sandbox";
  return "project";
}

async function main(): Promise<void> {
  const tierBias = tierFromArgv();
  const scope = scopeFromArgv();

  const client = createMockClient({
    model_availability: MODEL_ROSTER,
    llm_usage: [],
    enrichment_outcomes: [],
  });
  const { client: writeClient, writes } = createMockWriteClient({
    enrichment_outcomes: [],
  });

  const events: SessionEvent[] = [];
  const manager = new SlipstreamSessionManager({
    client,
    writeClient,
    caller: makeCaller(),
    onSessionEvent: (e) => events.push(e),
  });

  console.log(`\nIDE session simulation`);
  console.log(`  scope:      ${scope}`);
  console.log(`  tier bias:  ${tierBias}`);
  console.log(`  messages:   ${SCRIPT.length}`);
  console.log("");

  const handle = await manager.startSession({
    sessionId: "ide-tab-1",
    scope,
    user: { id: "demo-user", tierBias },
  });

  console.log(`  ─ session ${handle.sessionId} started (${handle.scope}, ${handle.tierBias})\n`);
  console.log(`  ${"#".padStart(2)}  ${"message".padEnd(50)}  ${"model".padEnd(30)}  lat  drift  ✓`);
  console.log(`  ${"─".repeat(2)}  ${"─".repeat(50)}  ${"─".repeat(30)}  ${"─".repeat(3)}  ${"─".repeat(5)}  ${"─".repeat(1)}`);

  for (let i = 0; i < SCRIPT.length; i++) {
    const turn = SCRIPT[i]!;
    const result = await manager.process({
      sessionId: "ide-tab-1",
      message: turn.user,
    });
    await manager.recordOutcome({
      sessionId: "ide-tab-1",
      requestId: result.requestId,
      accepted: turn.verdict,
    });
    const msg = turn.user.length > 50 ? `${turn.user.slice(0, 49)}…` : turn.user.padEnd(50);
    const model = `${result.modelResponse.provider}/${result.modelResponse.model}`.padEnd(30);
    const lat = `${String(result.modelResponse.latencyMs).padStart(3)}`;
    const drift = result.drift.level.padEnd(5);
    const verdict = turn.verdict ? "✓" : "✗";
    console.log(`  ${String(i + 1).padStart(2)}  ${msg}  ${model}  ${lat}  ${drift}  ${verdict}`);
  }

  const roi = await manager.endSession("ide-tab-1");
  console.log("");
  console.log(`  Session ROI:`);
  console.log(`    Requests:          ${roi.totalRequests}`);
  console.log(`    Acceptance rate:   ${(roi.acceptanceRate * 100).toFixed(1)}%`);
  console.log(`    Avg model latency: ${roi.avgModelLatencyMs}ms`);
  console.log(`    Avg token mult:    ${roi.avgTokenMultiplier}x`);
  console.log("");
  console.log(`  Persisted outcomes (${scope}):`);
  const ins = writes.enrichment_outcomes?.inserts.length ?? 0;
  const upd = writes.enrichment_outcomes?.updates.length ?? 0;
  console.log(`    enrichment_outcomes inserts: ${ins}`);
  console.log(`    enrichment_outcomes updates: ${upd}`);
  if (scope === "sandbox") {
    console.log(`    (sandbox sessions skip persistence by design — IDE should observe 0/0)`);
  }
  console.log("");
  console.log(`  Event stream (${events.length}):`);
  for (const e of events) {
    console.log(`    ${e.kind}`);
  }
}

main().catch((err) => {
  console.error("Session-manager demo fatal:", err);
  process.exit(1);
});
