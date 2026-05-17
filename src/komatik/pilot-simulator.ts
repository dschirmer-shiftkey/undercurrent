import { randomUUID } from "node:crypto";
import { Undercurrent } from "../index.js";
import { ConversationAdapter } from "../adapters/conversation.js";
import { DefaultStrategy } from "../strategies/default.js";
import type {
  ConversationTurn,
  EnrichedPrompt,
  GovernancePreset,
  ModelCallerFn,
  ModelCallerOutput,
  TargetPlatform,
} from "../types.js";
import { KomatikPilotProcessor } from "./pilot.js";
import type { PilotOutcome, PilotProcessTelemetry, PilotRoiSummary } from "./pilot.js";
import { KomatikOutcomeWriter } from "./outcome-writer.js";
import { createMockClient, createMockWriteClient } from "./testing.js";
import type { MockWriteLog } from "./testing.js";
import type { KomatikDataClient, KomatikWriteClient } from "./client.js";

/**
 * End-to-end harness that wires Undercurrent → KomatikPilotProcessor → OutcomeWriter
 * with mock clients and a stub model caller. Used to validate the consumer-side
 * integration pattern before porting to real Komatik products.
 *
 * Real products replace:
 *   - `caller` with their actual LLM gateway
 *   - `client` / `writeClient` with a real Supabase client
 *   - `verdictRule` with their own acceptance signal (e.g. user clicked apply)
 */

export interface PilotSimulationMessage {
  text: string;
  history?: ConversationTurn[];
}

export interface PilotSimulationOptions {
  messages: (string | PilotSimulationMessage)[];
  client?: KomatikDataClient;
  writeClient?: KomatikWriteClient;
  writes?: Record<string, MockWriteLog>;
  caller?: ModelCallerFn;
  verdictRule?: (telemetry: PilotProcessTelemetry, enriched: EnrichedPrompt) => boolean;
  userId?: string;
  sourceApp?: string;
  preset?: GovernancePreset;
  targetPlatform?: TargetPlatform;
}

export interface PilotSimulationResult {
  roi: PilotRoiSummary;
  events: PilotProcessTelemetry[];
  outcomes: PilotOutcome[];
  enrichments: EnrichedPrompt[];
  writes: Record<string, MockWriteLog>;
}

const DEFAULT_MODEL_ROSTER = [
  {
    provider: "anthropic",
    api_model_name: "claude-sonnet-4-6",
    status: "active",
    smoke_test_latency_ms: 240,
  },
  {
    provider: "openai",
    api_model_name: "gpt-5-mini",
    status: "active",
    smoke_test_latency_ms: 210,
  },
  {
    provider: "google",
    api_model_name: "gemini-2-pro",
    status: "active",
    smoke_test_latency_ms: 260,
  },
];

function defaultClient(): KomatikDataClient {
  return createMockClient({
    model_availability: DEFAULT_MODEL_ROSTER,
    llm_usage: [],
    enrichment_outcomes: [],
    komatik_profiles: [],
    user_preferences: [],
  });
}

function defaultWriteClient(): { client: KomatikWriteClient; writes: Record<string, MockWriteLog> } {
  return createMockWriteClient({
    enrichment_outcomes: [],
    session_memories: [],
  });
}

function defaultCaller(): ModelCallerFn {
  return async ({ model, provider, enrichedSystemPrompt }): Promise<ModelCallerOutput> => {
    // Simulated latency derived from prompt length — bounded so tests stay fast.
    const latency = Math.min(80 + Math.floor(enrichedSystemPrompt.length / 40), 300);
    await new Promise((r) => setTimeout(r, latency));
    return {
      content: `Simulated ${provider}/${model} response.`,
      model,
      provider,
      inputTokens: Math.ceil(enrichedSystemPrompt.length / 4),
      outputTokens: 32,
      latencyMs: latency,
    };
  };
}

function defaultVerdictRule(
  telemetry: PilotProcessTelemetry,
  enriched: EnrichedPrompt,
): boolean {
  // Accept if enrichment did real work AND stayed within reasonable token/latency budget.
  if (enriched.metadata.enrichmentDepth === "none") return true;
  if (telemetry.tokenMultiplier > 4) return false;
  if (telemetry.modelLatencyMs > 800) return false;
  return true;
}

export async function runPilotSimulation(
  options: PilotSimulationOptions,
): Promise<PilotSimulationResult> {
  const userId = options.userId ?? "sim-user-1";
  const sourceApp = options.sourceApp ?? "platform";
  const client = options.client ?? defaultClient();
  const writeBundle = options.writeClient
    ? { client: options.writeClient, writes: options.writes ?? {} }
    : defaultWriteClient();
  const caller = options.caller ?? defaultCaller();
  const verdictRule = options.verdictRule ?? defaultVerdictRule;

  const undercurrent = new Undercurrent({
    adapters: [new ConversationAdapter()],
    strategy: new DefaultStrategy(),
    preset: options.preset,
    targetPlatform: options.targetPlatform ?? "generic",
    modelRouter: {
      enabled: true,
      caller,
      userId,
      client,
    },
  });

  const outcomeWriter = new KomatikOutcomeWriter(writeBundle.client, userId);

  const events: PilotProcessTelemetry[] = [];
  const outcomes: PilotOutcome[] = [];
  const enrichments: EnrichedPrompt[] = [];

  const pilot = new KomatikPilotProcessor(undercurrent, {
    sink: {
      onProcessTelemetry: (e) => {
        events.push(e);
      },
      onOutcome: (o) => {
        outcomes.push(o);
      },
    },
    outcomeWriter,
  });

  for (const raw of options.messages) {
    const msg = typeof raw === "string" ? { text: raw } : raw;
    const requestId = randomUUID();
    const result = await pilot.process(
      {
        message: msg.text,
        conversation: msg.history ?? [],
        preset: options.preset,
        targetPlatform: options.targetPlatform ?? "generic",
      },
      { sourceApp, userId, requestId },
    );
    enrichments.push(result.enrichedPrompt);
    const accepted = verdictRule(result.pilotTelemetry, result.enrichedPrompt);
    await pilot.recordOutcome({ requestId, accepted });
  }

  return {
    roi: pilot.summarizeRoi(),
    events,
    outcomes,
    enrichments,
    writes: writeBundle.writes,
  };
}
