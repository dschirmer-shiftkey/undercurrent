import type { CompactionResult, ConversationTurn, SessionState } from "../types.js";
import { estimateTokens } from "./session-monitor.js";

const RECENT_EXCHANGES_TO_KEEP = 5;

const COMPACTION_PROMPT_TEMPLATE = `You are a session compaction engine. Summarize the following conversation into a structured handoff document. Preserve:
- All architectural decisions and their reasoning
- Active work items and their current status
- Unresolved bugs, questions, or blockers
- Key terminology and naming conventions established
- Implementation details that would be expensive to rediscover

Discard:
- Redundant tool outputs (file listings, build logs, etc.)
- Greetings, pleasantries, and meta-conversation
- Superseded approaches that were abandoned

Format your response as:
SUMMARY: <1-3 sentence overview of the session>
DECISIONS: <bullet list of decisions made>
ACTIVE_WORK: <bullet list of in-progress items>
UNRESOLVED: <bullet list of open questions/blockers>
TERMINOLOGY: <key=value pairs of established terms>

--- CONVERSATION ---
`;

export class Compactor {
  private readonly llmCall?: (prompt: string) => Promise<string>;

  constructor(options?: { llmCall?: (prompt: string) => Promise<string> }) {
    this.llmCall = options?.llmCall;
  }

  async compact(
    conversation: ConversationTurn[],
    sessionState: SessionState,
  ): Promise<CompactionResult> {
    if (this.llmCall) {
      return this.llmCompact(conversation, sessionState);
    }
    return this.heuristicCompact(conversation, sessionState);
  }

  heuristicCompact(conversation: ConversationTurn[], sessionState: SessionState): CompactionResult {
    const decisions = [...sessionState.decisionsThisSession, ...extractDecisions(conversation)];
    const uniqueDecisions = [...new Set(decisions)];

    const activeWork =
      sessionState.activeWorkItems.length > 0
        ? [...sessionState.activeWorkItems]
        : extractActiveWork(conversation);

    const unresolved =
      sessionState.unresolvedItems.length > 0
        ? [...sessionState.unresolvedItems]
        : extractUnresolved(conversation);

    const terminology = extractTerminology(conversation);

    const recentExchanges = conversation.slice(-RECENT_EXCHANGES_TO_KEEP * 2);

    const originalTokens = conversation.reduce(
      (sum, turn) => sum + estimateTokens(turn.content),
      0,
    );

    const compactedTokens =
      uniqueDecisions.reduce((s, d) => s + estimateTokens(d), 0) +
      activeWork.reduce((s, w) => s + estimateTokens(w), 0) +
      unresolved.reduce((s, u) => s + estimateTokens(u), 0) +
      recentExchanges.reduce((s, t) => s + estimateTokens(t.content), 0) +
      Object.entries(terminology).reduce((s, [k, v]) => s + estimateTokens(`${k}: ${v}`), 0);

    const summaryParts: string[] = [];
    if (uniqueDecisions.length > 0) {
      summaryParts.push(`${uniqueDecisions.length} decision(s) made`);
    }
    if (activeWork.length > 0) {
      summaryParts.push(`${activeWork.length} active work item(s)`);
    }
    if (unresolved.length > 0) {
      summaryParts.push(`${unresolved.length} unresolved item(s)`);
    }
    summaryParts.push(
      `${sessionState.messageCount} messages over ${formatDuration(Date.now() - sessionState.startedAt)}`,
    );

    return {
      summary: `Session compaction: ${summaryParts.join(", ")}.`,
      decisions: uniqueDecisions,
      activeWork,
      unresolved,
      terminology,
      recentExchanges,
      estimatedTokensSaved: Math.max(0, originalTokens - compactedTokens),
    };
  }

  private async llmCompact(
    conversation: ConversationTurn[],
    sessionState: SessionState,
  ): Promise<CompactionResult> {
    const conversationText = conversation.map((t) => `[${t.role}]: ${t.content}`).join("\n\n");

    const prompt = COMPACTION_PROMPT_TEMPLATE + conversationText;

    let llmResponse: string;
    try {
      llmResponse = await this.llmCall!(prompt);
    } catch {
      return this.heuristicCompact(conversation, sessionState);
    }

    const parsed = parseLlmCompactionResponse(llmResponse);
    const recentExchanges = conversation.slice(-RECENT_EXCHANGES_TO_KEEP * 2);

    const originalTokens = conversation.reduce(
      (sum, turn) => sum + estimateTokens(turn.content),
      0,
    );
    const compactedTokens =
      estimateTokens(llmResponse) +
      recentExchanges.reduce((s, t) => s + estimateTokens(t.content), 0);

    return {
      summary: parsed.summary || `LLM-compacted session (${sessionState.messageCount} messages).`,
      decisions: parsed.decisions.length > 0 ? parsed.decisions : sessionState.decisionsThisSession,
      activeWork: parsed.activeWork.length > 0 ? parsed.activeWork : sessionState.activeWorkItems,
      unresolved: parsed.unresolved.length > 0 ? parsed.unresolved : sessionState.unresolvedItems,
      terminology: parsed.terminology,
      recentExchanges,
      estimatedTokensSaved: Math.max(0, originalTokens - compactedTokens),
    };
  }
}

function extractDecisions(conversation: ConversationTurn[]): string[] {
  const decisionPatterns = [
    /let'?s?\s+(go with|use|do|stick with|keep)\s+/i,
    /i('ll| will)\s+(go with|use|do)\s+/i,
    /decided?\s+(to|on)\s+/i,
    /we('re| are)\s+going\s+(with|to)\s+/i,
  ];

  const decisions: string[] = [];

  for (const turn of conversation) {
    if (turn.role !== "user") continue;
    for (const pattern of decisionPatterns) {
      const match = turn.content.match(pattern);
      if (match) {
        const sentence = extractSentenceAround(turn.content, match.index ?? 0);
        if (sentence.length > 10) {
          decisions.push(sentence.slice(0, 200));
        }
        break;
      }
    }
  }

  return decisions;
}

function extractActiveWork(conversation: ConversationTurn[]): string[] {
  const workPatterns = [
    /(?:working on|building|implementing|creating|adding|fixing)\s+(.{10,120})/i,
    /(?:task|todo|next step|need to)\s*:?\s+(.{10,120})/i,
  ];

  const items: string[] = [];
  const recentTurns = conversation.slice(-20);

  for (const turn of recentTurns) {
    for (const pattern of workPatterns) {
      const match = turn.content.match(pattern);
      if (match?.[1]) {
        items.push(match[1].trim().slice(0, 150));
        break;
      }
    }
  }

  return [...new Set(items)].slice(0, 5);
}

function extractUnresolved(conversation: ConversationTurn[]): string[] {
  const unresolvedPatterns = [
    /(?:still need|haven'?t|todo|unresolved|open question|blocker|blocked by)\s+(.{10,120})/i,
    /(?:\?)\s*$/m,
  ];

  const items: string[] = [];
  const recentTurns = conversation.slice(-10);

  for (const turn of recentTurns) {
    if (turn.role !== "user") continue;
    for (const pattern of unresolvedPatterns) {
      const match = turn.content.match(pattern);
      if (match?.[1]) {
        items.push(match[1].trim().slice(0, 150));
        break;
      }
    }
  }

  return [...new Set(items)].slice(0, 5);
}

function extractTerminology(conversation: ConversationTurn[]): Record<string, string> {
  const termCounts = new Map<string, number>();
  const codeTermPattern = /`([^`]+)`/g;

  for (const turn of conversation) {
    let match: RegExpExecArray | null;
    while ((match = codeTermPattern.exec(turn.content)) !== null) {
      const term = match[1]!;
      if (term.length > 2 && term.length < 60) {
        termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
      }
    }
  }

  const terminology: Record<string, string> = {};
  for (const [term, count] of termCounts) {
    if (count >= 2) {
      terminology[term] = `used ${count}x in conversation`;
    }
  }

  return terminology;
}

function extractSentenceAround(text: string, position: number): string {
  const before = text.lastIndexOf(".", position - 1);
  const after = text.indexOf(".", position);
  const start = before === -1 ? 0 : before + 1;
  const end = after === -1 ? text.length : after + 1;
  return text.slice(start, end).trim();
}

function parseLlmCompactionResponse(response: string): {
  summary: string;
  decisions: string[];
  activeWork: string[];
  unresolved: string[];
  terminology: Record<string, string>;
} {
  const result = {
    summary: "",
    decisions: [] as string[],
    activeWork: [] as string[],
    unresolved: [] as string[],
    terminology: {} as Record<string, string>,
  };

  const summaryMatch = response.match(
    /SUMMARY:\s*(.+?)(?=\n(?:DECISIONS|ACTIVE_WORK|UNRESOLVED|TERMINOLOGY):|$)/s,
  );
  if (summaryMatch?.[1]) {
    result.summary = summaryMatch[1].trim();
  }

  result.decisions = extractBulletList(response, "DECISIONS");
  result.activeWork = extractBulletList(response, "ACTIVE_WORK");
  result.unresolved = extractBulletList(response, "UNRESOLVED");

  const termMatch = response.match(
    /TERMINOLOGY:\s*(.+?)(?=\n(?:SUMMARY|DECISIONS|ACTIVE_WORK|UNRESOLVED):|$)/s,
  );
  if (termMatch?.[1]) {
    const lines = termMatch[1].trim().split("\n");
    for (const line of lines) {
      const kvMatch = line.match(/[-•*]?\s*(.+?)\s*=\s*(.+)/);
      if (kvMatch?.[1] && kvMatch[2]) {
        result.terminology[kvMatch[1].trim()] = kvMatch[2].trim();
      }
    }
  }

  return result;
}

function extractBulletList(text: string, section: string): string[] {
  const pattern = new RegExp(
    `${section}:\\s*(.+?)(?=\\n(?:SUMMARY|DECISIONS|ACTIVE_WORK|UNRESOLVED|TERMINOLOGY):|$)`,
    "s",
  );
  const match = text.match(pattern);
  if (!match?.[1]) return [];

  return match[1]
    .trim()
    .split("\n")
    .map((line) => line.replace(/^[-•*]\s*/, "").trim())
    .filter((line) => line.length > 0);
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes}m`;
}
