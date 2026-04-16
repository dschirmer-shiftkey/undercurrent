import type { AdapterInput, ContextAdapter, ContextLayer } from "../types.js";

/**
 * Extracts context from the conversation history itself.
 * Identifies: prior decisions, rejected approaches, established terminology,
 * emotional trajectory, and topic evolution.
 */
export class ConversationAdapter implements ContextAdapter {
  readonly name = "conversation";
  readonly priority = 1;

  private readonly maxTurnsToAnalyze: number;

  constructor(options?: { maxTurnsToAnalyze?: number }) {
    this.maxTurnsToAnalyze = options?.maxTurnsToAnalyze ?? 50;
  }

  async available(): Promise<boolean> {
    return true;
  }

  async gather(input: AdapterInput): Promise<ContextLayer[]> {
    if (input.conversation.length === 0) return [];

    const recent = input.conversation.slice(-this.maxTurnsToAnalyze);
    const layers: ContextLayer[] = [];

    const decisions = this.extractDecisions(recent);
    if (decisions.length > 0) {
      layers.push({
        source: this.name,
        priority: this.priority,
        timestamp: Date.now(),
        data: { decisions },
        summary: `${decisions.length} prior decision(s) in conversation: ${decisions.map((d) => d.summary).join("; ")}`,
      });
    }

    const topics = this.extractTopicTrajectory(recent);
    if (topics.length > 0) {
      layers.push({
        source: this.name,
        priority: this.priority,
        timestamp: Date.now(),
        data: { topics },
        summary: `Topic trajectory: ${topics.join(" → ")}`,
      });
    }

    const terminology = this.extractTerminology(recent);
    if (terminology.size > 0) {
      layers.push({
        source: this.name,
        priority: this.priority,
        timestamp: Date.now(),
        data: { terminology: Object.fromEntries(terminology) },
        summary: `Established terms: ${[...terminology.keys()].join(", ")}`,
      });
    }

    return layers;
  }

  private extractDecisions(
    turns: AdapterInput["conversation"],
  ): Array<{ summary: string; turnIndex: number }> {
    const decisionPatterns = [
      /let'?s?\s+(go with|use|do|stick with|keep)\s+/i,
      /i('ll| will)\s+(go with|use|do)\s+/i,
      /decided?\s+(to|on)\s+/i,
      /we('re| are)\s+going\s+(with|to)\s+/i,
      /(?:yes|yeah|ok|correct|exactly|that'?s?\s+(?:right|it|correct))/i,
      /not\s+(?:that|this|the)\s+/i,
      /instead\s+of\s+/i,
      /scratch\s+that/i,
      /actually,?\s+/i,
    ];

    const decisions: Array<{ summary: string; turnIndex: number }> = [];

    turns.forEach((turn, idx) => {
      for (const pattern of decisionPatterns) {
        const match = turn.content.match(pattern);
        if (match) {
          const sentence = this.extractSentenceAround(
            turn.content,
            match.index ?? 0,
          );
          decisions.push({
            summary: sentence.slice(0, 200),
            turnIndex: idx,
          });
          break;
        }
      }
    });

    return decisions;
  }

  private extractTopicTrajectory(
    turns: AdapterInput["conversation"],
  ): string[] {
    const topics: string[] = [];
    let currentTopic = "";

    for (const turn of turns) {
      if (turn.role !== "user") continue;
      const words = turn.content.toLowerCase().split(/\s+/);
      const nouns = words.filter((w) => w.length > 4);
      const topicSignal = nouns.slice(0, 3).join(" ");
      if (topicSignal && topicSignal !== currentTopic) {
        currentTopic = topicSignal;
        topics.push(topicSignal);
      }
    }

    return topics.slice(-5);
  }

  private extractTerminology(
    turns: AdapterInput["conversation"],
  ): Map<string, number> {
    const termCounts = new Map<string, number>();
    const codeTermPattern = /`([^`]+)`|(?:the\s+)?(\w+(?:[-_]\w+)+)/g;

    for (const turn of turns) {
      let match: RegExpExecArray | null;
      while ((match = codeTermPattern.exec(turn.content)) !== null) {
        const term = (match[1] ?? match[2])!;
        if (term.length > 2 && term.length < 60) {
          termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
        }
      }
    }

    const repeated = new Map<string, number>();
    for (const [term, count] of termCounts) {
      if (count >= 2) {
        repeated.set(term, count);
      }
    }

    return repeated;
  }

  private extractSentenceAround(text: string, position: number): string {
    const before = text.lastIndexOf(".", position - 1);
    const after = text.indexOf(".", position);
    const start = before === -1 ? 0 : before + 1;
    const end = after === -1 ? text.length : after + 1;
    return text.slice(start, end).trim();
  }
}
