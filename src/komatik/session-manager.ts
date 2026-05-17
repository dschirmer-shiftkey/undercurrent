import { randomUUID } from "node:crypto";
import { Slipstream } from "../index.js";
import { ConversationAdapter } from "../adapters/conversation.js";
import { DefaultStrategy } from "../strategies/default.js";
import { DriftMonitor } from "../engine/drift-monitor.js";
import type { DriftGauge } from "../engine/drift-monitor.js";
import { KomatikPilotProcessor } from "./pilot.js";
import type { PilotOutcome, PilotRoiSummary, PilotProcessTelemetry } from "./pilot.js";
import { KomatikOutcomeWriter } from "./outcome-writer.js";
import type {
  ConversationTurn,
  EnrichedPrompt,
  ModelCallerFn,
  ModelRecommendation,
  ScoringWeights,
  TargetPlatform,
} from "../types.js";
import type { KomatikDataClient, KomatikWriteClient } from "./client.js";

/**
 * High-level façade for the Komatik Workbench IDE. One class, one config,
 * one method per IDE action. Wraps Slipstream + KomatikPilotProcessor +
 * KomatikOutcomeWriter + DriftMonitor under a single contract so the IDE
 * does not need to know which Slipstream primitive owns what.
 *
 * Replaces the IDE's manual "budget / balanced / premier" tier picker:
 * Slipstream's model router picks the actual model per request, with the
 * tier bias acting as a soft preference on scoring weights.
 */

export type TierBias = "budget" | "balanced" | "premier";

export type SessionScope = "sandbox" | "project";

export interface SessionStartInput {
  /** Stable ID for this session (e.g., IDE tab id, project workspace id). */
  sessionId: string;
  /** "sandbox" = ephemeral, no Komatik persistence. "project" = full persistence. */
  scope: SessionScope;
  user: {
    id: string;
    /** Per-user preference override; falls back to manager's defaultTierBias. */
    tierBias?: TierBias;
  };
  /** Optional initial conversation (e.g., resumed session). */
  conversation?: ConversationTurn[];
}

export interface SessionHandle {
  sessionId: string;
  scope: SessionScope;
  userId: string;
  tierBias: TierBias;
  startedAt: number;
}

export interface ProcessInput {
  sessionId: string;
  message: string;
  /** Conversation context. If omitted, manager uses the running session log. */
  conversation?: ConversationTurn[];
  /** Override platform-aware formatting for this call. */
  targetPlatform?: TargetPlatform;
}

export interface ProcessOutput {
  requestId: string;
  enrichedPrompt: EnrichedPrompt;
  modelRecommendation: ModelRecommendation;
  modelResponse: { content: string; model: string; provider: string; latencyMs: number };
  telemetry: PilotProcessTelemetry;
  /** Current drift gauge after this turn. */
  drift: DriftGauge;
}

export interface RecordOutcomeInput {
  sessionId: string;
  requestId: string;
  accepted: boolean;
  reason?: string;
  /** Optional fine-grained outcome details (passed through to OutcomeWriter). */
  assumptionsAccepted?: string[];
  assumptionsCorrected?: string[];
  correctionDetails?: Record<string, unknown>;
}

export type SessionEvent =
  | { kind: "session-started"; handle: SessionHandle }
  | { kind: "model-selected"; sessionId: string; recommendation: ModelRecommendation }
  | { kind: "outcome-recorded"; sessionId: string; outcome: PilotOutcome }
  | { kind: "drift-elevated"; sessionId: string; gauge: DriftGauge }
  | { kind: "session-ended"; sessionId: string; roi: PilotRoiSummary };

export interface SessionManagerConfig {
  /** Read-side Komatik client for scoring/preferences/etc. */
  client: KomatikDataClient;
  /** Write-side Komatik client (used only for project-scope sessions). */
  writeClient: KomatikWriteClient;
  /** The IDE's LLM gateway. */
  caller: ModelCallerFn;
  /** Default tier bias when the user has no preference. Defaults to "balanced". */
  defaultTierBias?: TierBias;
  /** Drift score threshold that emits drift-elevated events. Default 40. */
  driftRefreshThreshold?: number;
  /** Observability hook — fired on every notable lifecycle event. */
  onSessionEvent?: (event: SessionEvent) => void;
  /** Default target platform if none passed per request. Default "cursor". */
  defaultPlatform?: TargetPlatform;
}

/**
 * Tier bias → scoring weight presets. The router still picks the actual
 * model per request; tier shifts the weighting toward cost/latency
 * (budget), quality (premier), or balanced default.
 */
export const TIER_WEIGHT_PRESETS: Record<TierBias, ScoringWeights> = {
  budget: {
    successRate: 0.3,
    acceptanceRate: 0.2,
    latency: 0.4,
    affinity: 0.1,
  },
  balanced: {
    successRate: 0.35,
    acceptanceRate: 0.3,
    latency: 0.1,
    affinity: 0.25,
  },
  premier: {
    successRate: 0.4,
    acceptanceRate: 0.5,
    latency: 0.05,
    affinity: 0.05,
  },
};

interface SessionState {
  handle: SessionHandle;
  slipstream: Slipstream;
  pilot: KomatikPilotProcessor;
  drift: DriftMonitor;
  conversation: ConversationTurn[];
  turnCount: number;
}

export class SlipstreamSessionManager {
  private readonly config: Required<Pick<SessionManagerConfig, "defaultTierBias" | "driftRefreshThreshold" | "defaultPlatform">> &
    SessionManagerConfig;
  private readonly sessions = new Map<string, SessionState>();
  private readonly emittedDriftElevated = new Set<string>();

  constructor(config: SessionManagerConfig) {
    this.config = {
      defaultTierBias: "balanced",
      driftRefreshThreshold: 40,
      defaultPlatform: "cursor",
      ...config,
    };
  }

  /** Start a new session. Sandbox sessions skip outcome persistence. */
  async startSession(input: SessionStartInput): Promise<SessionHandle> {
    if (this.sessions.has(input.sessionId)) {
      throw new Error(`SlipstreamSessionManager: session ${input.sessionId} already started.`);
    }
    const tierBias = input.user.tierBias ?? this.config.defaultTierBias;
    const handle: SessionHandle = {
      sessionId: input.sessionId,
      scope: input.scope,
      userId: input.user.id,
      tierBias,
      startedAt: Date.now(),
    };

    const slipstream = new Slipstream({
      adapters: [new ConversationAdapter()],
      strategy: new DefaultStrategy(),
      targetPlatform: this.config.defaultPlatform,
      modelRouter: {
        enabled: true,
        caller: this.config.caller,
        userId: input.user.id,
        client: this.config.client,
        scoringWeights: TIER_WEIGHT_PRESETS[tierBias],
        onModelSelected: (rec) =>
          this.config.onSessionEvent?.({
            kind: "model-selected",
            sessionId: input.sessionId,
            recommendation: rec,
          }),
      },
    });

    // Project-scope sessions persist outcomes; sandbox sessions do not.
    const outcomeWriter =
      input.scope === "project"
        ? new KomatikOutcomeWriter(this.config.writeClient, input.user.id)
        : undefined;

    const pilot = new KomatikPilotProcessor(slipstream, {
      sink: {
        onOutcome: (outcome) =>
          this.config.onSessionEvent?.({
            kind: "outcome-recorded",
            sessionId: input.sessionId,
            outcome,
          }),
      },
      outcomeWriter,
    });

    const drift = new DriftMonitor({ refreshThreshold: this.config.driftRefreshThreshold });

    this.sessions.set(input.sessionId, {
      handle,
      slipstream,
      pilot,
      drift,
      conversation: input.conversation ? [...input.conversation] : [],
      turnCount: 0,
    });

    this.config.onSessionEvent?.({ kind: "session-started", handle });
    return handle;
  }

  /** Process a user message through the full Slipstream + pilot + drift pipeline. */
  async process(input: ProcessInput): Promise<ProcessOutput> {
    const state = this.requireSession(input.sessionId);
    const conversation = input.conversation ?? state.conversation;
    const requestId = randomUUID();

    const result = await state.pilot.process(
      {
        message: input.message,
        conversation,
        targetPlatform: input.targetPlatform ?? this.config.defaultPlatform,
      },
      {
        sourceApp: "komatik-workbench",
        userId: state.handle.userId,
        sessionId: state.handle.sessionId,
        requestId,
      },
    );

    // Track the user turn + assistant response in the session log so the IDE
    // doesn't have to manage the conversation array itself.
    state.conversation.push({ role: "user", content: input.message });
    state.conversation.push({ role: "assistant", content: result.modelResponse.content });
    state.turnCount++;

    // Run drift on the user message; emit drift-elevated event on threshold cross.
    state.drift.observe(input.message, state.turnCount * 2 - 2);
    const gauge = state.drift.gauge();
    if (gauge.refreshRecommended && !this.emittedDriftElevated.has(input.sessionId)) {
      this.emittedDriftElevated.add(input.sessionId);
      this.config.onSessionEvent?.({
        kind: "drift-elevated",
        sessionId: input.sessionId,
        gauge,
      });
    } else if (!gauge.refreshRecommended) {
      // Reset latch when drift cools off so we re-emit if it climbs again.
      this.emittedDriftElevated.delete(input.sessionId);
    }

    return {
      requestId,
      enrichedPrompt: result.enrichedPrompt,
      modelRecommendation: result.enrichedPrompt.metadata.modelRecommendation!,
      modelResponse: {
        content: result.modelResponse.content,
        model: result.modelResponse.model,
        provider: result.modelResponse.provider,
        latencyMs: result.modelResponse.latencyMs,
      },
      telemetry: result.pilotTelemetry,
      drift: gauge,
    };
  }

  /** Record an accept/reject verdict against a previous process() call. */
  async recordOutcome(input: RecordOutcomeInput): Promise<void> {
    const state = this.requireSession(input.sessionId);
    await state.pilot.recordOutcome({
      requestId: input.requestId,
      accepted: input.accepted,
      reason: input.reason,
      assumptionsAccepted: input.assumptionsAccepted,
      assumptionsCorrected: input.assumptionsCorrected,
      correctionDetails: input.correctionDetails,
    });
  }

  /** End a session — emits final ROI event and frees state. */
  async endSession(sessionId: string): Promise<PilotRoiSummary> {
    const state = this.requireSession(sessionId);
    const roi = state.pilot.summarizeRoi();
    this.config.onSessionEvent?.({ kind: "session-ended", sessionId, roi });
    this.sessions.delete(sessionId);
    this.emittedDriftElevated.delete(sessionId);
    return roi;
  }

  /** Get the current drift gauge for a session (informational). */
  getDriftGauge(sessionId: string): DriftGauge {
    return this.requireSession(sessionId).drift.gauge();
  }

  /** Get the running ROI summary for a session. */
  getRoiSummary(sessionId: string): PilotRoiSummary {
    return this.requireSession(sessionId).pilot.summarizeRoi();
  }

  /** Returns the live session handle (or null). Useful for the IDE to inspect state. */
  getSession(sessionId: string): SessionHandle | null {
    return this.sessions.get(sessionId)?.handle ?? null;
  }

  /** Returns true if a session with this ID is active. */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  private requireSession(sessionId: string): SessionState {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`SlipstreamSessionManager: no active session for ${sessionId}.`);
    }
    return state;
  }
}
