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

    for (const turn of turns) {
      for (const term of this.extractBacktickTerms(turn.content)) {
        if (term.length > 2 && term.length < 60) {
          termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
        }
      }
      for (const term of this.extractJoinedIdentifierTerms(turn.content)) {
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
    const grepPattern = /(?:grep|search(?:ed)?|rg|ripgrep)\s+(?:for\s+)?["'`]([^"'`]{3,80})["'`]/gi;

    const counts = new Map<string, { count: number; kind: "file" | "grep" }>();

    for (const turn of turns) {
      if (turn.role !== "assistant") continue;

      const seenInTurn = new Set<string>();
      for (const path of this.extractLikelyFilePaths(turn.content)) {
        if (seenInTurn.has(path)) continue;
        seenInTurn.add(path);
        const prev = counts.get(path);
        counts.set(path, { count: (prev?.count ?? 0) + 1, kind: "file" });
      }

      let match: RegExpExecArray | null;
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
    const pivotPhrases = [
      "scratch that",
      "forget that",
      "forget it",
      "forget what i said",
      "never mind",
      "let's try a different",
      "lets try a different",
      "let's do a different",
      "lets do a different",
      "let's go with a different",
      "lets go with a different",
      "instead, let's",
      "instead lets",
      "actually, let's",
      "actually lets",
      "back up",
      "backup",
      "undo",
      "revert",
      "roll back",
      "different approach",
      "change of plan",
      "not what i meant",
      "not what i wanted",
    ];

    const found: Array<{ signal: string; turnIndex: number; supersededTurns: number[] }> = [];

    turns.forEach((turn, idx) => {
      if (turn.role !== "user") return;
      const lower = turn.content.toLowerCase();
      for (const phrase of pivotPhrases) {
        const at = lower.indexOf(phrase);
        if (at === -1) continue;
        const supersededTurns: number[] = [];
        for (let back = idx - 1; back >= Math.max(0, idx - 4); back--) {
          supersededTurns.push(back);
        }
        const signal = this.extractSentenceAround(turn.content, at).slice(0, 120);
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

  private extractBacktickTerms(text: string): string[] {
    const terms: string[] = [];
    let idx = 0;
    while (idx < text.length) {
      const start = text.indexOf("`", idx);
      if (start === -1) break;
      const end = text.indexOf("`", start + 1);
      if (end === -1) break;
      const term = text.slice(start + 1, end).trim();
      if (term.length > 0) terms.push(term);
      idx = end + 1;
    }
    return terms;
  }

  private extractJoinedIdentifierTerms(text: string): string[] {
    const tokens = text
      .replace(/[<>{}()[\],.!?;:"']/g, " ")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const terms: string[] = [];
    for (const token of tokens) {
      const normalized = token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
      if (!normalized.includes("-") && !normalized.includes("_")) continue;
      const parts = normalized.split(/[-_]/).filter((p) => p.length > 0);
      if (parts.length < 2) continue;
      if (!parts.every((p) => /^[A-Za-z0-9]+$/.test(p))) continue;
      terms.push(normalized);
    }
    return terms;
  }

  private extractLikelyFilePaths(text: string): string[] {
    const tokens = text.split(/\s+/).map((t) => t.trim());
    const paths: string[] = [];
    for (const token of tokens) {
      const candidate = token.replace(/^[`"'([<{]+|[`"')\]>.,;:!?]+$/g, "");
      if (!candidate) continue;
      if (this.isLikelyFilePath(candidate)) {
        paths.push(candidate);
      }
    }
    return paths;
  }

  private isLikelyFilePath(candidate: string): boolean {
    if (candidate.length < 4 || candidate.length > 260) return false;
    const hasSeparator = candidate.includes("/") || candidate.includes("\\");
    if (!hasSeparator) return false;
    const normalized = candidate.replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    const base = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
    const dot = base.lastIndexOf(".");
    if (dot <= 0 || dot === base.length - 1) return false;
    const ext = base.slice(dot + 1);
    if (ext.length < 1 || ext.length > 6) return false;
    return /^[A-Za-z0-9]+$/.test(ext);
  }
}
