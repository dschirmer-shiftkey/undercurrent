import type {
  CompactionResult,
  ContextLayer,
  ConversationTurn,
  HandoffArtifact,
  SessionMemoryInput,
  SessionSnapshot,
  SessionState,
  SessionWriter,
} from "../types.js";
import type { Compactor } from "./compactor.js";
import type { SessionMonitor } from "./session-monitor.js";

export class Checkpointer {
  private readonly writer: SessionWriter;
  private readonly compactor: Compactor;
  private readonly userId: string;

  constructor(options: { writer: SessionWriter; compactor: Compactor; userId: string }) {
    this.writer = options.writer;
    this.compactor = options.compactor;
    this.userId = options.userId;
  }

  async checkpoint(monitor: SessionMonitor, _conversation: ConversationTurn[]): Promise<void> {
    const state = monitor.getState();
    const memories = this.buildMemories(state);

    if (memories.length === 0) return;

    try {
      await this.writer.writeMemories(this.userId, memories);
      monitor.markCheckpoint();
    } catch {
      // Graceful degradation — checkpoint failure doesn't break the pipeline
    }
  }

  async compactAndCheckpoint(
    monitor: SessionMonitor,
    conversation: ConversationTurn[],
    _contextLayers: ContextLayer[],
  ): Promise<CompactionResult> {
    const state = monitor.getState();
    const compaction = await this.compactor.compact(conversation, state);

    const snapshot: SessionSnapshot = {
      sessionId: state.sessionId,
      createdAt: Date.now(),
      state,
      compaction,
      handoff: null,
    };

    const memories = this.buildCompactionMemories(compaction, state);

    try {
      await Promise.allSettled([
        this.writer.writeSnapshot(snapshot),
        this.writer.writeMemories(this.userId, memories),
        this.expireSupersededMemories(state),
      ]);

      monitor.markCheckpoint();
    } catch {
      // Graceful degradation
    }

    return compaction;
  }

  async produceHandoff(
    monitor: SessionMonitor,
    conversation: ConversationTurn[],
    contextLayers: ContextLayer[],
  ): Promise<HandoffArtifact> {
    const state = monitor.getState();
    const compaction = await this.compactor.compact(conversation, state);

    const handoff: HandoffArtifact = {
      sessionId: state.sessionId,
      createdAt: Date.now(),
      summary: compaction.summary,
      completedWork: this.inferCompletedWork(state, compaction),
      activeWork: compaction.activeWork,
      unresolvedItems: compaction.unresolved,
      decisions: state.decisionsThisSession.map((d, i) => ({
        summary: d,
        madeAt: state.startedAt + i * 60_000,
        turnIndex: i,
      })),
      keyTerminology: compaction.terminology,
      nextSteps: this.inferNextSteps(compaction),
      contextLayers: contextLayers.map((l) => ({
        source: l.source,
        priority: l.priority,
        timestamp: l.timestamp,
        data: l.data,
        summary: l.summary,
      })),
    };

    const snapshot: SessionSnapshot = {
      sessionId: state.sessionId,
      createdAt: Date.now(),
      state,
      compaction,
      handoff,
    };

    const memories = this.buildHandoffMemories(handoff);

    try {
      await Promise.allSettled([
        this.writer.writeSnapshot(snapshot),
        this.writer.writeMemories(this.userId, memories),
      ]);
    } catch {
      // Graceful degradation
    }

    return handoff;
  }

  async restoreFromSnapshot(): Promise<ContextLayer[]> {
    let snapshot: SessionSnapshot | null;
    try {
      snapshot = await this.writer.getLatestSnapshot(this.userId);
    } catch {
      return [];
    }

    if (!snapshot) return [];

    const layers: ContextLayer[] = [];
    const now = Date.now();

    if (snapshot.handoff) {
      layers.push(this.handoffToContextLayer(snapshot.handoff, now));
    } else if (snapshot.compaction) {
      layers.push(this.compactionToContextLayer(snapshot.compaction, snapshot.state, now));
    }

    return layers;
  }

  private buildMemories(state: SessionState): SessionMemoryInput[] {
    const memories: SessionMemoryInput[] = [];

    for (const work of state.activeWorkItems) {
      memories.push({
        memoryType: "active-work",
        content: work,
        contextKey: `active-work:${state.sessionId}`,
        relevanceScore: 0.9,
        expiresAt: expiresInHours(48),
      });
    }

    const recentDecisions = state.decisionsThisSession.slice(-3);
    for (const decision of recentDecisions) {
      memories.push({
        memoryType: "decision",
        content: decision,
        contextKey: `decision:${state.sessionId}`,
        relevanceScore: 0.8,
        expiresAt: expiresInHours(168),
      });
    }

    for (const item of state.unresolvedItems) {
      memories.push({
        memoryType: "unresolved",
        content: item,
        contextKey: `unresolved:${state.sessionId}`,
        relevanceScore: 0.85,
        expiresAt: expiresInHours(72),
      });
    }

    return memories;
  }

  private buildCompactionMemories(
    compaction: CompactionResult,
    state: SessionState,
  ): SessionMemoryInput[] {
    const memories: SessionMemoryInput[] = [];

    for (const work of compaction.activeWork) {
      memories.push({
        memoryType: "active-work",
        content: work,
        contextKey: `active-work:${state.sessionId}`,
        relevanceScore: 0.95,
        expiresAt: expiresInHours(48),
      });
    }

    for (const decision of compaction.decisions) {
      memories.push({
        memoryType: "decision",
        content: decision,
        contextKey: `decision:${state.sessionId}`,
        relevanceScore: 0.85,
        expiresAt: expiresInHours(168),
      });
    }

    for (const item of compaction.unresolved) {
      memories.push({
        memoryType: "unresolved",
        content: item,
        contextKey: `unresolved:${state.sessionId}`,
        relevanceScore: 0.9,
        expiresAt: expiresInHours(72),
      });
    }

    return memories;
  }

  private buildHandoffMemories(handoff: HandoffArtifact): SessionMemoryInput[] {
    const memories: SessionMemoryInput[] = [];

    memories.push({
      memoryType: "active-work",
      content: `Session handoff: ${handoff.summary}`,
      contextKey: `handoff:${handoff.sessionId}`,
      relevanceScore: 1.0,
      expiresAt: expiresInHours(48),
    });

    for (const work of handoff.activeWork) {
      memories.push({
        memoryType: "active-work",
        content: work,
        contextKey: `active-work:${handoff.sessionId}`,
        relevanceScore: 0.95,
        expiresAt: expiresInHours(48),
      });
    }

    for (const item of handoff.unresolvedItems) {
      memories.push({
        memoryType: "unresolved",
        content: item,
        contextKey: `unresolved:${handoff.sessionId}`,
        relevanceScore: 0.9,
        expiresAt: expiresInHours(72),
      });
    }

    for (const decision of handoff.decisions) {
      memories.push({
        memoryType: "decision",
        content: decision.summary,
        contextKey: `decision:${handoff.sessionId}`,
        relevanceScore: 0.85,
        expiresAt: expiresInHours(168),
      });
    }

    return memories;
  }

  private async expireSupersededMemories(state: SessionState): Promise<void> {
    const keysToExpire = [`active-work:${state.sessionId}`, `unresolved:${state.sessionId}`];

    try {
      await this.writer.expireMemories(this.userId, keysToExpire);
    } catch {
      // Graceful degradation
    }
  }

  private inferCompletedWork(state: SessionState, compaction: CompactionResult): string[] {
    const completed: string[] = [];
    if (state.messageCount > 10 && compaction.decisions.length > 0) {
      completed.push(
        `Processed ${state.messageCount} messages with ${compaction.decisions.length} decision(s)`,
      );
    }
    return completed;
  }

  private inferNextSteps(compaction: CompactionResult): string[] {
    const steps: string[] = [];
    for (const item of compaction.unresolved) {
      steps.push(`Resolve: ${item}`);
    }
    for (const work of compaction.activeWork) {
      steps.push(`Continue: ${work}`);
    }
    return steps.slice(0, 5);
  }

  private handoffToContextLayer(handoff: HandoffArtifact, now: number): ContextLayer {
    const parts: string[] = [];
    parts.push(`Previous session: ${handoff.summary}`);

    if (handoff.activeWork.length > 0) {
      parts.push(`Active work: ${handoff.activeWork.join("; ")}`);
    }
    if (handoff.unresolvedItems.length > 0) {
      parts.push(`Unresolved: ${handoff.unresolvedItems.join("; ")}`);
    }
    if (handoff.decisions.length > 0) {
      const recentDecisions = handoff.decisions.slice(-3);
      parts.push(`Recent decisions: ${recentDecisions.map((d) => d.summary).join("; ")}`);
    }
    if (handoff.nextSteps.length > 0) {
      parts.push(`Suggested next steps: ${handoff.nextSteps.join("; ")}`);
    }

    return {
      source: "session-handoff",
      priority: 0,
      timestamp: now,
      data: {
        sessionId: handoff.sessionId,
        handoff,
      },
      summary: parts.join(". "),
    };
  }

  private compactionToContextLayer(
    compaction: CompactionResult,
    state: SessionState,
    now: number,
  ): ContextLayer {
    const parts: string[] = [];
    parts.push(compaction.summary);

    if (compaction.activeWork.length > 0) {
      parts.push(`Active work: ${compaction.activeWork.join("; ")}`);
    }
    if (compaction.unresolved.length > 0) {
      parts.push(`Unresolved: ${compaction.unresolved.join("; ")}`);
    }
    if (compaction.decisions.length > 0) {
      const recentDecisions = compaction.decisions.slice(-3);
      parts.push(`Recent decisions: ${recentDecisions.join("; ")}`);
    }

    return {
      source: "session-compaction",
      priority: 0,
      timestamp: now,
      data: {
        sessionId: state.sessionId,
        compaction,
      },
      summary: parts.join(". "),
    };
  }
}

function expiresInHours(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}
