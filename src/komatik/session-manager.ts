import { randomUUID } from "node:crypto";
import { Slipstream } from "../index.js";
import { ConversationAdapter } from "../adapters/conversation.js";
import { DefaultStrategy } from "../strategies/default.js";
import { DriftMonitor } from "../engine/drift-monitor.js";
import type { DriftGauge } from "../engine/drift-monitor.js";
import { KomatikPilotProcessor } from "./pilot.js";
import type { PilotOutcome, PilotRoiSummary, PilotProcessTelemetry } from "./pilot.js";
import { KomatikOutcomeWriter } from "./outcome-writer.js";
import { KomatikPreferenceClient } from "./preference-client.js";
import { KomatikSessionWriter } from "./session-writer.js";
import type {
  CompactionResult,
  ConversationTurn,
  EnrichedPrompt,
  ModelCallerFn,
  ModelRecommendation,
  ScoringWeights,
  SessionSnapshot,
  SessionState,
  SessionWriter,
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
    /**
     * Optional explicit override. Takes precedence over the user's stored
     * `tier_bias` preference. Useful for per-session experimentation or
     * when the IDE has just-changed the user's tier via UI.
     */
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
  /**
   * When a project-scope session resumes from a stored snapshot, this is
   * populated with the prior session's summary. null when starting fresh
   * (no prior snapshot) or for sandbox-scope sessions (no persistence).
   */
  resumedFrom: ResumedSessionInfo | null;
}

export interface ResumedSessionInfo {
  /** When the prior snapshot was written. */
  snapshotAt: number;
  /** Short human-readable summary of what was active in the prior session. */
  summary: string;
  /** Number of conversation turns restored from the snapshot. */
  restoredTurns: number;
  /** Drift canonicals restored from the snapshot's keyTerminology. */
  restoredCanonicals: number;
  /** Decisions carried over (for the IDE to show "you were here" prompts). */
  decisions: string[];
  /** Unresolved items from the prior session. */
  unresolvedItems: string[];
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
  | { kind: "session-resumed"; sessionId: string; resumedFrom: ResumedSessionInfo }
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
  /**
   * Override the SessionWriter used for project-scope persistence. Defaults
   * to a KomatikSessionWriter built from writeClient. Useful for tests or
   * for products that want to plug a different persistence backend.
   */
  sessionWriter?: SessionWriter;
  /**
   * How many recent turns to persist in the session snapshot for resume.
   * Default 50. Larger = more faithful resume; smaller = less storage.
   */
  resumeTurnLimit?: number;
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

interface ActiveSessionState {
  handle: SessionHandle;
  slipstream: Slipstream;
  pilot: KomatikPilotProcessor;
  drift: DriftMonitor;
  conversation: ConversationTurn[];
  turnCount: number;
  /** Decisions / unresolved items carried in from a resumed snapshot; persisted again on endSession. */
  resumedDecisions: string[];
  resumedUnresolved: string[];
}

export class SlipstreamSessionManager {
  private readonly config: Required<
    Pick<
      SessionManagerConfig,
      "defaultTierBias" | "driftRefreshThreshold" | "defaultPlatform" | "resumeTurnLimit"
    >
  > &
    SessionManagerConfig;
  private readonly sessions = new Map<string, ActiveSessionState>();
  private readonly emittedDriftElevated = new Set<string>();
  private readonly preferenceClient: KomatikPreferenceClient;
  private readonly sessionWriter: SessionWriter;
  /** In-memory tier-bias cache per user. Avoids re-querying user_preferences for repeat sessions. */
  private readonly tierBiasCache = new Map<string, TierBias | null>();

  constructor(config: SessionManagerConfig) {
    this.config = {
      defaultTierBias: "balanced",
      driftRefreshThreshold: 40,
      defaultPlatform: "cursor",
      resumeTurnLimit: 50,
      ...config,
    };
    this.preferenceClient = new KomatikPreferenceClient({
      client: config.client,
      writeClient: config.writeClient,
    });
    this.sessionWriter = config.sessionWriter ?? new KomatikSessionWriter(config.writeClient);
  }

  /** Start a new session. Sandbox sessions skip outcome persistence. */
  async startSession(input: SessionStartInput): Promise<SessionHandle> {
    if (this.sessions.has(input.sessionId)) {
      throw new Error(`SlipstreamSessionManager: session ${input.sessionId} already started.`);
    }
    // Resolve tier bias in priority order:
    //   1. explicit override on the input (IDE just-changed it)
    //   2. stored user preference (cached after first read)
    //   3. manager-level default
    let tierBias: TierBias;
    if (input.user.tierBias) {
      tierBias = input.user.tierBias;
      // An explicit override updates the cache so subsequent sessions for
      // the same user reflect the latest choice without re-querying.
      this.tierBiasCache.set(input.user.id, tierBias);
    } else {
      const stored = await this.resolveStoredTierBias(input.user.id);
      tierBias = stored ?? this.config.defaultTierBias;
    }
    // Project-scope sessions try to resume from a prior snapshot.
    // Sandbox sessions always start fresh.
    const restored = input.scope === "project" ? await this.loadResume(input.sessionId) : null;

    const handle: SessionHandle = {
      sessionId: input.sessionId,
      scope: input.scope,
      userId: input.user.id,
      tierBias,
      startedAt: Date.now(),
      resumedFrom: restored?.info ?? null,
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
    if (restored) {
      drift.seedCanonicals(restored.canonicals);
    }

    // Conversation seed priority: explicit input > resumed snapshot > empty.
    const seededConversation: ConversationTurn[] = input.conversation
      ? [...input.conversation]
      : restored
        ? [...restored.conversation]
        : [];

    this.sessions.set(input.sessionId, {
      handle,
      slipstream,
      pilot,
      drift,
      conversation: seededConversation,
      turnCount: 0,
      resumedDecisions: restored?.decisions ?? [],
      resumedUnresolved: restored?.unresolved ?? [],
    });

    this.config.onSessionEvent?.({ kind: "session-started", handle });
    if (restored) {
      this.config.onSessionEvent?.({
        kind: "session-resumed",
        sessionId: input.sessionId,
        resumedFrom: restored.info,
      });
    }
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

  /**
   * End a session — emits final ROI event, persists a snapshot for project-
   * scope sessions (so the next startSession can resume), and frees state.
   */
  async endSession(sessionId: string): Promise<PilotRoiSummary> {
    const state = this.requireSession(sessionId);
    const roi = state.pilot.summarizeRoi();

    if (state.handle.scope === "project") {
      await this.persistSnapshot(state);
    }

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

  /**
   * Persist a tier bias choice for a user. Writes to `user_preferences`
   * so the value sticks across sessions and devices. Use from the IDE
   * tier-override UI; subsequent `startSession()` calls without an
   * explicit override will pick this up.
   *
   * Existing in-progress sessions are NOT updated — tier bias is locked
   * at session-start time. End and restart the session to apply.
   */
  async setTierBias(userId: string, tier: TierBias): Promise<void> {
    await this.preferenceClient.setTierBias(userId, tier);
    this.tierBiasCache.set(userId, tier);
  }

  /**
   * Returns the stored tier bias for a user (cached). Returns null when
   * the user has no stored preference yet — caller should fall back to
   * `defaultTierBias`.
   */
  async getStoredTierBias(userId: string): Promise<TierBias | null> {
    return this.resolveStoredTierBias(userId);
  }

  /** Clear the cached tier bias for a user; next read hits the DB. */
  invalidateTierBiasCache(userId?: string): void {
    if (userId) this.tierBiasCache.delete(userId);
    else this.tierBiasCache.clear();
  }

  private async resolveStoredTierBias(userId: string): Promise<TierBias | null> {
    if (this.tierBiasCache.has(userId)) {
      return this.tierBiasCache.get(userId) ?? null;
    }
    const stored = await this.preferenceClient.getTierBias(userId);
    this.tierBiasCache.set(userId, stored);
    return stored;
  }

  private requireSession(sessionId: string): ActiveSessionState {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`SlipstreamSessionManager: no active session for ${sessionId}.`);
    }
    return state;
  }

  /**
   * Load a prior snapshot for this sessionId, if any. Returns the restored
   * state plus a SessionHandle.resumedFrom info object. Returns null when
   * there is no snapshot or the snapshot is unusable.
   *
   * KomatikSessionWriter stores snapshots keyed by sessionId (in the user_id
   * column, see writer impl) — so getLatestSnapshot(sessionId) returns the
   * exact prior session's snapshot, not a cross-session mix.
   */
  private async loadResume(sessionId: string): Promise<ResumedSessionPayload | null> {
    let snapshot: SessionSnapshot | null = null;
    try {
      snapshot = await this.sessionWriter.getLatestSnapshot(sessionId);
    } catch {
      return null;
    }
    if (!snapshot) return null;

    const compaction = snapshot.compaction;
    const handoff = snapshot.handoff;
    const conversation: ConversationTurn[] = compaction?.recentExchanges ?? [];
    const canonicals = compaction?.terminology
      ? Object.values(compaction.terminology)
      : [];
    const decisions = handoff?.decisions.map((d) => d.summary) ?? compaction?.decisions ?? [];
    const unresolved = handoff?.unresolvedItems ?? compaction?.unresolved ?? [];

    const summary =
      handoff?.summary ??
      compaction?.summary ??
      `Prior session snapshot from ${new Date(snapshot.createdAt).toISOString()}`;

    return {
      conversation,
      canonicals,
      decisions,
      unresolved,
      info: {
        snapshotAt: snapshot.createdAt,
        summary,
        restoredTurns: conversation.length,
        restoredCanonicals: canonicals.length,
        decisions,
        unresolvedItems: unresolved,
      },
    };
  }

  /** Build a snapshot from the active session state and write it via the SessionWriter. */
  private async persistSnapshot(state: ActiveSessionState): Promise<void> {
    const recentExchanges = state.conversation.slice(-this.config.resumeTurnLimit);
    const driftRegistry = state.drift.getRegistry();
    const terminology: Record<string, string> = {};
    for (const [key, entry] of driftRegistry) {
      // Only persist canonicals that were actually seen this session (skip pinned
      // defaults that nobody used) so the registry doesn't grow without bound.
      if (entry.occurrences > 0 || entry.firstSeenTurn >= 0) {
        terminology[key] = entry.canonical;
      }
    }

    const compaction: CompactionResult = {
      summary: `Session ${state.handle.sessionId}: ${state.turnCount} turn(s), drift ${state.drift.gauge().level}`,
      decisions: state.resumedDecisions,
      activeWork: [],
      unresolved: state.resumedUnresolved,
      terminology,
      recentExchanges,
      estimatedTokensSaved: 0,
    };

    const sessionState: SessionState = {
      sessionId: state.handle.sessionId,
      startedAt: state.handle.startedAt,
      messageCount: state.turnCount * 2, // user + assistant per turn
      estimatedTokens: 0,
      tokenBudget: 0,
      topicShiftCount: 0,
      health: "healthy",
      lastCheckpoint: Date.now(),
      decisionsThisSession: state.resumedDecisions,
      activeWorkItems: [],
      unresolvedItems: state.resumedUnresolved,
    };

    const snapshot: SessionSnapshot = {
      sessionId: state.handle.sessionId,
      createdAt: Date.now(),
      state: sessionState,
      compaction,
      handoff: null,
    };

    try {
      await this.sessionWriter.writeSnapshot(snapshot);
    } catch {
      // Graceful degradation — failing to save the snapshot doesn't break the IDE flow.
    }
  }
}

interface ResumedSessionPayload {
  conversation: ConversationTurn[];
  canonicals: string[];
  decisions: string[];
  unresolved: string[];
  info: ResumedSessionInfo;
}
