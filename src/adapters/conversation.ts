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

    const repeatedReads = this.detectRepeatedReads(recent);
    if (repeatedReads.length > 0) {
      layers.push({
        source: this.name,
        priority: this.priority,
        timestamp: Date.now(),
        data: { repeatedReads },
        summary: `Repeated context fetches: ${repeatedReads.map((r) => `${r.target} (${r.count}x)`).join(", ")}`,
      });
    }

    const abandonment = this.detectAbandonment(recent);
    if (abandonment.length > 0) {
      layers.push({
        source: this.name,
        priority: this.priority,
        timestamp: Date.now(),
        data: { abandoned: abandonment },
        summary: `Pivot detected — ${abandonment.length} prior approach(es) abandoned: ${abandonment
          .map((a) => a.signal)
          .join("; ")}`,
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
          const sentence = this.extractSentenceAround(turn.content, match.index ?? 0);
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

  private extractTopicTrajectory(turns: AdapterInput["conversation"]): string[] {
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

  private extractTerminology(turns: AdapterInput["conversation"]): Map<string, number> {
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

  /**
   * Flags context targets (file paths, grep queries) that show up in
   * assistant turns 2+ times across the recent window. These are signals
   * that the agent may be re-fetching information already in context — a
   * direct contributor to the "tool result bloat" token waste category.
   */
  private detectRepeatedReads(
    turns: AdapterInput["conversation"],
  ): Array<{ target: string; count: number; kind: "file" | "grep" }> {
    const filePathPattern = /(?:`|"|')?((?:[a-zA-Z]:[\\/]|\.{1,2}[\\/]|[\w-]+\/)[\w./\\-]+\.[a-zA-Z]{1,6})(?:`|"|')?/g;
    const grepPattern = /(?:grep|search(?:ed)?|rg|ripgrep)\s+(?:for\s+)?["'`]([^"'`]{3,80})["'`]/gi;

    const counts = new Map<string, { count: number; kind: "file" | "grep" }>();

    for (const turn of turns) {
      if (turn.role !== "assistant") continue;

      let match: RegExpExecArray | null;
      filePathPattern.lastIndex = 0;
      const seenInTurn = new Set<string>();
      while ((match = filePathPattern.exec(turn.content)) !== null) {
        const path = match[1]!;
        if (seenInTurn.has(path)) continue;
        seenInTurn.add(path);
        const prev = counts.get(path);
        counts.set(path, { count: (prev?.count ?? 0) + 1, kind: "file" });
      }

      grepPattern.lastIndex = 0;
      const seenGrep = new Set<string>();
      while ((match = grepPattern.exec(turn.content)) !== null) {
        const query = match[1]!.toLowerCase();
        if (seenGrep.has(query)) continue;
        seenGrep.add(query);
        const prev = counts.get(`grep:${query}`);
        counts.set(`grep:${query}`, { count: (prev?.count ?? 0) + 1, kind: "grep" });
      }
    }

    return [...counts.entries()]
      .filter(([, v]) => v.count >= 2)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([target, v]) => ({
        target: target.startsWith("grep:") ? target.slice(5) : target,
        count: v.count,
        kind: v.kind,
      }));
  }

  /**
   * Detects when the user pivots away from a current approach. Marks
   * preceding tool work as superseded so downstream stages (compaction,
   * memory writes) can prefer to discard rather than preserve it.
   */
  private detectAbandonment(
    turns: AdapterInput["conversation"],
  ): Array<{ signal: string; turnIndex: number; supersededTurns: number[] }> {
    const pivotPatterns = [
      /scratch\s+that/i,
      /forget\s+(?:that|it|what\s+i\s+said)/i,
      /never\s*mind/i,
      /let'?s?\s+(?:try|do|go\s+with)\s+(?:a\s+)?(?:different|another|new)/i,
      /(?:^|\b)instead\s*,?\s+(?:let'?s?|i\s+want|we\s+should|do)/i,
      /actually,?\s+(?:let'?s?|i\s+want|we\s+should|forget|no)/i,
      /(?:back\s+up|backup|undo|revert|roll\s+back)/i,
      /(?:wrong|that'?s?\s+not\s+(?:right|what|it)|not\s+what\s+i\s+(?:meant|wanted))/i,
      /different\s+approach/i,
      /change\s+of\s+plan/i,
    ];

    const found: Array<{ signal: string; turnIndex: number; supersededTurns: number[] }> = [];

    turns.forEach((turn, idx) => {
      if (turn.role !== "user") return;
      for (const pattern of pivotPatterns) {
        const match = turn.content.match(pattern);
        if (!match) continue;
        const supersededTurns: number[] = [];
        for (let back = idx - 1; back >= Math.max(0, idx - 4); back--) {
          supersededTurns.push(back);
        }
        const signal = this.extractSentenceAround(turn.content, match.index ?? 0).slice(0, 120);
        found.push({ signal, turnIndex: idx, supersededTurns });
        break;
      }
    });

    return found.slice(-5);
  }

  private extractSentenceAround(text: string, position: number): string {
    const before = text.lastIndexOf(".", position - 1);
    const after = text.indexOf(".", position);
    const start = before === -1 ? 0 : before + 1;
    const end = after === -1 ? text.length : after + 1;
    return text.slice(start, end).trim();
  }
}
