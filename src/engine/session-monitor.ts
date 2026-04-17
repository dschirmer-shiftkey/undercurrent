import { randomUUID } from "node:crypto";
import type {
  ConversationTurn,
  SessionHealth,
  SessionState,
  SessionMonitorConfig,
} from "../types.js";

const DEFAULT_TOKEN_BUDGET = 100_000;
const DEFAULT_CHECKPOINT_INTERVAL = 5;
const DEFAULT_COMPACTION_THRESHOLD = 0.65;

const CHARS_PER_TOKEN = 4;

interface HealthThresholds {
  warmRatio: number;
  degradingRatio: number;
  criticalRatio: number;
  warmTopicShifts: number;
  degradingTopicShifts: number;
  degradingDurationMs: number;
}

const DEFAULT_THRESHOLDS: HealthThresholds = {
  warmRatio: 0.4,
  degradingRatio: 0.65,
  criticalRatio: 0.85,
  warmTopicShifts: 3,
  degradingTopicShifts: 6,
  degradingDurationMs: 60 * 60 * 1000,
};

export class SessionMonitor {
  private state: SessionState;
  private previousTopics: string[] = [];
  readonly tokenBudget: number;
  readonly checkpointInterval: number;
  readonly compactionThreshold: number;
  private readonly thresholds: HealthThresholds;

  constructor(config?: SessionMonitorConfig) {
    this.tokenBudget = config?.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    this.checkpointInterval = config?.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL;
    this.compactionThreshold = config?.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD;
    this.thresholds = DEFAULT_THRESHOLDS;

    this.state = {
      sessionId: randomUUID(),
      startedAt: Date.now(),
      messageCount: 0,
      estimatedTokens: 0,
      tokenBudget: this.tokenBudget,
      topicShiftCount: 0,
      health: "cold-start",
      lastCheckpoint: null,
      decisionsThisSession: [],
      activeWorkItems: [],
      unresolvedItems: [],
    };
  }

  getState(): Readonly<SessionState> {
    return { ...this.state };
  }

  getHealth(): SessionHealth {
    return this.state.health;
  }

  getSessionId(): string {
    return this.state.sessionId;
  }

  needsCheckpoint(): boolean {
    if (this.state.lastCheckpoint === null) {
      return this.state.messageCount >= this.checkpointInterval;
    }
    return this.state.messageCount - this.state.lastCheckpoint >= this.checkpointInterval;
  }

  markCheckpoint(): void {
    this.state.lastCheckpoint = this.state.messageCount;
  }

  track(
    message: string,
    conversation: ConversationTurn[],
    enrichedMessage?: string,
  ): SessionHealth {
    this.state.messageCount += 1;

    const messageTokens = estimateTokens(message);
    const enrichedTokens = enrichedMessage ? estimateTokens(enrichedMessage) : 0;
    this.state.estimatedTokens += messageTokens + enrichedTokens;

    this.detectTopicShift(message);
    this.extractDecisionSignals(message);
    this.state.health = this.computeHealth(conversation);

    return this.state.health;
  }

  addDecision(decision: string): void {
    this.state.decisionsThisSession.push(decision);
  }

  setActiveWork(items: string[]): void {
    this.state.activeWorkItems = items;
  }

  addUnresolved(item: string): void {
    if (!this.state.unresolvedItems.includes(item)) {
      this.state.unresolvedItems.push(item);
    }
  }

  resolveItem(item: string): void {
    this.state.unresolvedItems = this.state.unresolvedItems.filter((i) => i !== item);
  }

  resetAfterCompaction(retainedTokenEstimate: number): void {
    this.state.estimatedTokens = retainedTokenEstimate;
    this.state.health = this.computeHealthFromBudget(retainedTokenEstimate);
  }

  private computeHealth(conversation: ConversationTurn[]): SessionHealth {
    if (this.state.messageCount <= 1 && conversation.length === 0) {
      return "cold-start";
    }

    const ratio = this.state.estimatedTokens / this.state.tokenBudget;
    const elapsed = Date.now() - this.state.startedAt;
    const shifts = this.state.topicShiftCount;

    if (ratio >= this.thresholds.criticalRatio) {
      return "critical";
    }

    if (
      ratio >= this.thresholds.degradingRatio ||
      shifts >= this.thresholds.degradingTopicShifts ||
      elapsed >= this.thresholds.degradingDurationMs
    ) {
      return "degrading";
    }

    if (ratio >= this.thresholds.warmRatio || shifts >= this.thresholds.warmTopicShifts) {
      return "warm";
    }

    return "healthy";
  }

  private computeHealthFromBudget(tokens: number): SessionHealth {
    const ratio = tokens / this.state.tokenBudget;
    if (ratio >= this.thresholds.criticalRatio) return "critical";
    if (ratio >= this.thresholds.degradingRatio) return "degrading";
    if (ratio >= this.thresholds.warmRatio) return "warm";
    return "healthy";
  }

  private detectTopicShift(message: string): void {
    const keywords = extractTopicKeywords(message);
    if (keywords.length === 0) return;

    const currentSignature = keywords.join(" ");

    if (this.previousTopics.length > 0) {
      const lastSignature = this.previousTopics[this.previousTopics.length - 1]!;
      const overlap = computeOverlap(lastSignature.split(" "), keywords);
      if (overlap < 0.25) {
        this.state.topicShiftCount += 1;
      }
    }

    this.previousTopics.push(currentSignature);
    if (this.previousTopics.length > 20) {
      this.previousTopics.shift();
    }
  }

  private extractDecisionSignals(message: string): void {
    const decisionPatterns = [
      /let'?s?\s+(go with|use|do|stick with|keep)\s+(.{5,80})/i,
      /i('ll| will)\s+(go with|use|do)\s+(.{5,80})/i,
      /decided?\s+(to|on)\s+(.{5,80})/i,
      /we('re| are)\s+going\s+(with|to)\s+(.{5,80})/i,
    ];

    for (const pattern of decisionPatterns) {
      const match = message.match(pattern);
      if (match) {
        const sentence = extractSentenceAround(message, match.index ?? 0);
        if (sentence.length > 10) {
          this.state.decisionsThisSession.push(sentence.slice(0, 200));
        }
        break;
      }
    }
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function extractTopicKeywords(message: string): string[] {
  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s-_]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4);

  const stopWords = new Set([
    "about",
    "after",
    "again",
    "being",
    "between",
    "could",
    "every",
    "first",
    "going",
    "great",
    "their",
    "there",
    "these",
    "thing",
    "think",
    "those",
    "through",
    "under",
    "using",
    "where",
    "which",
    "while",
    "would",
    "should",
    "please",
    "thanks",
    "really",
    "actually",
    "basically",
  ]);

  return words.filter((w) => !stopWords.has(w)).slice(0, 5);
}

function computeOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const intersection = b.filter((w) => setA.has(w));
  return intersection.length / Math.max(a.length, b.length);
}

function extractSentenceAround(text: string, position: number): string {
  const before = text.lastIndexOf(".", position - 1);
  const after = text.indexOf(".", position);
  const start = before === -1 ? 0 : before + 1;
  const end = after === -1 ? text.length : after + 1;
  return text.slice(start, end).trim();
}
