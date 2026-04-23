import { randomUUID } from "node:crypto";
import type {
  Action,
  Assumption,
  ContextLayer,
  ConversationTurn,
  EmotionalLoad,
  EnrichmentStrategy,
  Gap,
  GapResolution,
  IntentSignal,
  Scope,
  Specificity,
} from "../types.js";

/**
 * The default enrichment strategy. Uses heuristic analysis (no LLM calls)
 * to classify intent, find gaps, and compose enriched messages.
 *
 * This is the reference implementation — intentionally transparent and
 * deterministic. For LLM-powered enrichment, implement a custom strategy
 * that delegates classification/composition to your model of choice.
 */
export class DefaultStrategy implements EnrichmentStrategy {
  readonly name = "default";

  async classifyIntent(message: string, conversation: ConversationTurn[]): Promise<IntentSignal> {
    const lower = message.toLowerCase();
    const words = lower.split(/\s+/);

    return {
      action: this.classifyAction(lower, words, message),
      specificity: this.classifySpecificity(lower, words, conversation),
      scope: this.classifyScope(lower, words),
      emotionalLoad: this.classifyEmotion(lower),
      confidence: this.estimateConfidence(words),
      rawFragments: this.extractKeyFragments(message),
      domainHints: this.extractDomainHints(message),
    };
  }

  async analyzeGaps(
    intent: IntentSignal,
    context: ContextLayer[],
    message: string,
  ): Promise<Gap[]> {
    const gaps: Gap[] = [];
    const lower = message.toLowerCase();
    const words = lower.split(/\s+/);
    const hasMemoryContext = context.some(
      (c) => c.source === "komatik-memory" || c.source === "conversation",
    );
    const hasConversationContext = context.some((c) => c.source === "conversation");
    const fileRefsInContext = this.contextContainsFileReferences(context);
    const scopeEstablishedInContext = this.contextEstablishesScope(context);
    const isSelection = this.isSelectionReference(message);

    // ── Selection reference without resolvable context ──────────────────
    // When the user is answering a prior options prompt ("option a", "A+B",
    // "both", "items 1-5") but conversation/memory context isn't available
    // to resolve what was being chosen. Surfaces as critical so downstream
    // AI knows it cannot act without reconstructing the choice set.
    if (isSelection && !hasMemoryContext) {
      gaps.push({
        id: randomUUID(),
        description:
          "Selection references prior options — resolution requires conversation context",
        critical: true,
        resolution: null,
      });
    }

    // ── Temporal/memory reference detection ────────────────────────────
    const temporalPattern =
      /\b(last time|same (approach|way|thing|method|pattern)|as before|like before|previous(ly)?|again the same|as we discussed|what we discussed|what we talked about|mentioned (earlier|before|previously)|as usual|remember when|like we did|like last|we agreed|you (said|suggested|recommended))\b/i;
    if (temporalPattern.test(message) && !hasMemoryContext) {
      gaps.push({
        id: randomUUID(),
        description:
          "Temporal reference without resolvable context — refers to prior interaction or decision",
        critical: true,
        resolution: null,
      });
    }

    if (intent.specificity !== "high" && !isSelection) {
      // ── Missing file/location reference ──────────────────────────────
      if (
        intent.action === "build" ||
        intent.action === "fix" ||
        intent.action === "design" ||
        intent.action === "unknown"
      ) {
        const hasFileRef = /(?:\w+\.\w{1,5}|\/\w+|line\s+\d+)/i.test(message);
        if (!hasFileRef && !fileRefsInContext) {
          gaps.push({
            id: randomUUID(),
            description: "No specific file or location referenced",
            critical: intent.action === "fix",
            resolution: null,
          });
        }
      }

      // ── Scope ambiguity ──────────────────────────────────────────────
      // Suppress for "unknown" scope when conversation already established
      // what's in play. Still fire for true cross-system scope (even with
      // conversation context) because those need explicit bounding.
      if (intent.scope === "cross-system") {
        gaps.push({
          id: randomUUID(),
          description: "Scope boundaries unclear — which systems/components are in play",
          critical: true,
          resolution: null,
        });
      } else if (intent.scope === "unknown" && !scopeEstablishedInContext && !isSelection) {
        gaps.push({
          id: randomUUID(),
          description: "Scope boundaries unclear — which systems/components are in play",
          critical: true,
          resolution: null,
        });
      }

      // ── Vague/ambiguous references ───────────────────────────────────
      const vagueRefs = (
        message.match(
          /\b(it|this|that|those|these|the thing|the stuff|that thing|the other|that other)\b/gi,
        ) ?? []
      ).length;
      const vagueThreshold = hasConversationContext ? 3 : context.length > 0 ? 2 : 1;
      if (vagueRefs >= vagueThreshold) {
        gaps.push({
          id: randomUUID(),
          description:
            vagueRefs >= 2
              ? "Multiple ambiguous references (pronouns without clear antecedents)"
              : "Ambiguous reference without supporting context to resolve it",
          critical: false,
          resolution: null,
        });
      }

      // ── Ultra-terse message ──────────────────────────────────────────
      if (words.length < 5) {
        gaps.push({
          id: randomUUID(),
          description: "Message is extremely terse — action target unclear",
          critical: false,
          resolution: null,
        });
      }
    }

    if (intent.action === "decide") {
      const hasOptions = /\bor\b|vs\.?|versus|between|choice|option/i.test(message);
      if (!hasOptions) {
        gaps.push({
          id: randomUUID(),
          description: "Decision requested but options/criteria not stated",
          critical: true,
          resolution: null,
        });
      }
    }

    return gaps;
  }

  async resolveGap(
    gap: Gap,
    context: ContextLayer[],
    confidenceThreshold: number,
  ): Promise<GapResolution> {
    for (const layer of context) {
      const match = this.searchContextForGap(gap, layer);
      if (match) {
        return {
          type: "filled",
          value: match,
          source: layer.source,
        };
      }
    }

    const inferredConfidence = context.length > 0 ? 0.5 + context.length * 0.05 : 0.3;

    if (inferredConfidence >= confidenceThreshold || !gap.critical) {
      return {
        type: "assumed",
        assumption: {
          id: randomUUID(),
          claim: `Inferred resolution for: ${gap.description}`,
          basis:
            context.length > 0
              ? `Based on ${context.length} context layer(s) from ${[...new Set(context.map((c) => c.source))].join(", ")}`
              : "No supporting context — using best guess",
          confidence: inferredConfidence,
          source: "default-strategy",
          correctable: true,
        },
      };
    }

    return {
      type: "needs-clarification",
      clarification: {
        id: randomUUID(),
        question: this.gapToQuestion(gap),
        options: [
          { id: "opt-1", label: "The most recent thing I was working on", isDefault: true },
          { id: "opt-2", label: "Something else — I'll specify", isDefault: false },
        ],
        allowMultiple: false,
        defaultOptionId: "opt-1",
        reason: gap.description,
      },
    };
  }

  async compose(
    message: string,
    intent: IntentSignal,
    context: ContextLayer[],
    assumptions: Assumption[],
    resolvedGaps: Gap[],
  ): Promise<string> {
    const parts: string[] = [];

    parts.push(`[Original]: ${message}`);

    parts.push(
      `[Intent]: ${intent.action} (${intent.specificity} specificity, ${intent.scope} scope)`,
    );

    if (intent.domainHints.length > 0) {
      parts.push(`[Domain]: ${intent.domainHints.join(", ")}`);
    }

    if (context.length > 0) {
      parts.push("[Context]:");
      for (const layer of context) {
        parts.push(`  - ${layer.source}: ${layer.summary}`);
      }
    }

    if (assumptions.length > 0) {
      parts.push("[Assumptions]:");
      for (const assumption of assumptions) {
        parts.push(
          `  - ${assumption.claim} (confidence: ${(assumption.confidence * 100).toFixed(0)}%, basis: ${assumption.basis})`,
        );
      }
    }

    const filled = resolvedGaps.filter((g) => g.resolution?.type === "filled");
    if (filled.length > 0) {
      parts.push("[Auto-resolved]:");
      for (const gap of filled) {
        const resolution = gap.resolution as { type: "filled"; value: string; source: string };
        parts.push(`  - ${gap.description} → ${resolution.value} (from ${resolution.source})`);
      }
    }

    return parts.join("\n");
  }

  // ── Intent Classification Heuristics ───────────────────────────────────

  private classifyAction(lower: string, words: string[], original?: string): Action {
    if (original && this.isStatusPaste(original)) return "report";
    if (this.isAcknowledgment(lower, words)) return "acknowledge";

    const actionSignals: Record<Exclude<Action, "acknowledge" | "report">, RegExp[]> = {
      build: [
        /\b(build|create|make|add|implement|set up|scaffold|generate|write)\b/,
        /\b(refactor|update|change|modify|rename|move|replace|swap|convert|migrate)\b/,
        /\b(optimize|improve|clean ?up|remove|delete|extract|split|merge|rewrite)\b/,
        /\b(deploy|ship|publish|release|install|configure|enable|disable|wire|connect)\b/,
      ],
      fix: [/\b(fix|bug|broken|error|issue|wrong|doesn'?t work|failing|crash|not working)\b/],
      explore: [/\b(how|what|where|why|explain|show me|understand|look at|check|describe|tell me)\b/],
      design: [/\b(design|architect|plan|structure|approach|strategy|layout|propose|draft)\b/],
      discuss: [/\b(think|idea|opinion|thoughts?|consider|what if|should we|weigh|compare)\b/],
      decide: [/\b(decide|choose|pick|which|better|option|trade-?off)\b/],
      vent: [/\b(frustrated|annoying|hate|ugh|terrible|awful|ridiculous|stupid)\b/],
      unknown: [],
    };

    for (const [action, patterns] of Object.entries(actionSignals) as [Action, RegExp[]][]) {
      for (const pattern of patterns) {
        if (pattern.test(lower)) return action;
      }
    }

    const fuzzy = this.fuzzyMatchAction(words);
    if (fuzzy) return fuzzy;

    if (words.length < 5) return "explore";
    return "unknown";
  }

  /**
   * Typo-tolerant action classifier — runs after exact regex patterns miss.
   * Uses Damerau-Levenshtein against a small vocabulary of action verbs to
   * catch real-world misspellings (udpate, imlement, destoryed, fx, refactr).
   *
   * Word-length-aware distance threshold: 1 edit for 4-6 char words, 2 for
   * longer words. Words under 4 chars are skipped to avoid collisions with
   * common short tokens.
   */
  private fuzzyMatchAction(words: string[]): Action | null {
    const vocabulary: Record<Exclude<Action, "acknowledge" | "report" | "unknown">, string[]> = {
      build: [
        "build", "create", "make", "implement", "scaffold", "generate", "refactor",
        "update", "change", "modify", "rename", "replace", "convert", "migrate",
        "optimize", "improve", "cleanup", "extract", "merge", "rebase", "rewrite",
        "deploy", "publish", "release", "install", "configure", "enable", "disable",
        "promote", "verify",
      ],
      fix: ["broken", "error", "issue", "failing", "crash", "destroyed", "corrupt", "corrupted"],
      explore: ["explain", "understand", "describe", "investigate", "inspect"],
      design: ["design", "architect", "structure", "approach", "strategy", "layout", "propose", "draft"],
      discuss: ["opinion", "thoughts", "consider", "compare"],
      decide: ["decide", "choose", "option", "tradeoff"],
      vent: ["frustrated", "annoying", "terrible", "awful", "ridiculous"],
    };

    let bestAction: Action | null = null;
    let bestDist = Infinity;

    for (const raw of words) {
      const word = raw.replace(/[^a-z]/g, "");
      if (word.length < 4) continue;
      const maxDist = word.length <= 6 ? 1 : 2;

      for (const [action, vocab] of Object.entries(vocabulary) as [Action, string[]][]) {
        for (const canonical of vocab) {
          if (Math.abs(canonical.length - word.length) > maxDist) continue;
          if (word === canonical) continue; // exact matches should have been caught by patterns
          const d = this.damerauLevenshtein(word, canonical, maxDist);
          if (d <= maxDist && d < bestDist) {
            bestDist = d;
            bestAction = action;
          }
        }
      }
    }
    return bestAction;
  }

  /**
   * Restricted Damerau-Levenshtein with adjacent-transposition support and
   * an early-abort threshold. Returns `maxDist + 1` when distance exceeds
   * the threshold so callers can cheaply reject.
   */
  private damerauLevenshtein(a: string, b: string, maxDist: number): number {
    if (a === b) return 0;
    const la = a.length;
    const lb = b.length;
    if (Math.abs(la - lb) > maxDist) return maxDist + 1;

    const dp: number[][] = Array.from({ length: la + 1 }, () => new Array(lb + 1).fill(0));
    for (let i = 0; i <= la; i++) dp[i]![0] = i;
    for (let j = 0; j <= lb; j++) dp[0]![j] = j;

    for (let i = 1; i <= la; i++) {
      let rowMin = Infinity;
      for (let j = 1; j <= lb; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(
          dp[i - 1]![j]! + 1,
          dp[i]![j - 1]! + 1,
          dp[i - 1]![j - 1]! + cost,
        );
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          v = Math.min(v, dp[i - 2]![j - 2]! + 1);
        }
        dp[i]![j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > maxDist) return maxDist + 1;
    }
    return dp[la]![lb]!;
  }

  /**
   * Detects pure conversational acknowledgments — thanks, praise, filler
   * confirmations — that carry no new request. Distinct from `vent` (negative
   * emotional load) and `discuss` (opinion-seeking). These should bypass
   * enrichment entirely.
   *
   * Strategy: strip known ack phrases, then check if what remains is empty
   * or consists only of filler. A message with any substantive content
   * after stripping is NOT an acknowledgment.
   */
  private isAcknowledgment(lower: string, words: string[]): boolean {
    if (words.length > 8) return false;

    const ACK_PHRASES = [
      /\b(thank you|thanks|thank ya|thx|ty|ty!|thanks!)\b/g,
      /\b(looks|sounds|seems|feels) (great|good|nice|fine|perfect|right|solid)\b/g,
      /\b(got it|makes sense|sounds good|all good|that works|works for me|no worries)\b/g,
      /\b(well done|nice work|good job|great work)\b/g,
    ];

    const ACK_SOLO_TOKENS = new Set([
      "ok", "okay", "k", "kk", "kk!", "ok!", "okay!",
      "please", "pls", "plz",
      "yes", "yep", "yeah", "yup", "sure", "fine", "right",
      "nice", "perfect", "awesome", "cool", "great", "amazing", "lovely", "beautiful",
      "done", "gotcha",
    ]);

    let stripped = lower;
    for (const pattern of ACK_PHRASES) {
      stripped = stripped.replace(pattern, " ");
    }
    stripped = stripped.replace(/[.!?,;:]/g, " ").trim();

    if (stripped.length === 0) return true;

    const remainder = stripped.split(/\s+/).filter((w) => w.length > 0);
    if (remainder.length === 0) return true;

    const filler = new Set(["a", "an", "the", "this", "that", "it", "i", "you", "!", "?", "."]);
    const substantive = remainder.filter(
      (w) => !filler.has(w) && !ACK_SOLO_TOKENS.has(w),
    );

    return substantive.length === 0;
  }

  /**
   * Detects multi-line "status paste" messages where the user is dropping
   * CI output, test reports, build logs, or a structured status update —
   * not asking for new work. Distinguished from real requests by the last
   * non-empty line: if it ends with "?" or contains request verbs, the
   * user has pasted context AND is asking for help, so we do NOT short-circuit.
   *
   * Signals (≥3 required): verdict opener ("All green", "Failed"), multiple
   * pass/fail tokens, timing markers, PR/issue refs, stack-trace lines,
   * log-level prefixes.
   */
  private isStatusPaste(message: string): boolean {
    const lines = message.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 3) return false;

    const lastLine = lines[lines.length - 1]!.trim();
    if (lastLine.endsWith("?")) return false;
    if (
      /\b(can you|could you|please|should we|should i|help me|how (?:do|can|should)|why (?:is|does|can'?t)|what (?:is|do|should)|where (?:is|do|can))\b/i.test(
        lastLine,
      )
    ) {
      return false;
    }

    let signals = 0;

    const firstLine = lines[0]!.trim();
    if (
      /^(all green|all passing|all (?:tests )?pass(?:ed|ing)?|passed all|passed|failed|success|succeeded|complete[d]?|done)\b/i.test(
        firstLine,
      )
    ) {
      signals += 2;
    }

    const lower = message.toLowerCase();
    const passFailCount = (lower.match(/\b(pass(?:ed|ing)?|fail(?:ed|ing)?|skipped?)\b/g) ?? [])
      .length;
    if (passFailCount >= 2) signals += 2;

    if (/\(\d+m\d+s\)|\b\d+m\d+s\b|\b\d+\.\d+s\b|\b\d+ms\b/.test(message)) signals += 1;

    const prRefs = (message.match(/#\d+/g) ?? []).length;
    if (prRefs >= 1) signals += 1;

    if (/^\s+at\s+\w/m.test(message) || /\b(Error|Exception|Traceback|Stack ?trace)\b:/.test(message)) {
      signals += 3;
    }

    if (/\[(?:INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\]/.test(message)) signals += 1;

    const fileLineRefs = (message.match(/\b[\w/\\.-]+\.\w{1,5}:\d+(?::\d+)?\b/g) ?? []).length;
    if (fileLineRefs >= 2) signals += 2;

    return signals >= 3;
  }

  /**
   * Detects messages that answer a prior options prompt — "option a", "A+B",
   * "all of the above", "both", "items 1-5", "the first one". These messages
   * depend critically on prior-turn context to be intelligible. When the
   * signal fires, gap analysis suppresses file/scope noise (those were
   * established in the options prompt itself) and adds a critical gap if
   * no conversation/memory layer is available to resolve the selection.
   *
   * Scoped to leading/anchored positions plus short messages to minimize
   * false positives on phrases like "the first time" or "both sides" buried
   * mid-message.
   */
  private isSelectionReference(message: string): boolean {
    const trimmed = message.trim();
    const words = trimmed.split(/\s+/);

    const anchored = [
      /^option\s+[a-z0-9]+\b/i,
      /^[A-D]\s*[+&]\s*[A-D]\b/,
      /^(all of the above|all three|all four|all five|both|neither)\b/i,
      /^items?\s+\d+(\s*[-–]\s*\d+)?/i,
      /^(the\s+)?(first|second|third|fourth|last|former|latter)\s+(one|option|choice|item)\b/i,
      /^(okay|ok|yes|yeah|sure|alright)[,.!\s]+(option|all|both|let'?s\s+go\s+with|the first|the second|items?\s+\d|[A-D]\s*[+&]\s*[A-D])/i,
      /^(let'?s\s+)?(go\s+with|bundle|pick|choose)\s+(option\s+[a-z0-9]|[A-D]\s*[+&]\s*[A-D]|all|both|items?\s+\d)/i,
    ];
    if (anchored.some((p) => p.test(trimmed))) return true;

    // Short messages where a selection keyword carries the whole meaning
    if (words.length <= 6) {
      if (/\b[A-D]\s*[+&]\s*[A-D]\b/.test(trimmed)) return true;
      if (/^option\s+[a-z0-9]+/i.test(trimmed)) return true;
      if (/^(both|neither|all three|all four)\b/i.test(trimmed)) return true;
    }

    return false;
  }

  private classifySpecificity(
    lower: string,
    words: string[],
    _conversation: ConversationTurn[],
  ): Specificity {
    let score = 0;

    if (/\w+\.\w{1,5}/.test(lower)) score += 2;
    if (/line\s+\d+/i.test(lower)) score += 3;
    if (/function\s+\w+|class\s+\w+|const\s+\w+/i.test(lower)) score += 2;
    if (/`[^`]+`/.test(lower)) score += 1;
    if (words.length > 20) score += 1;
    if (words.length < 8) score -= 2;
    if (/\b(idea|thing|stuff|something|somehow|whatever)\b/.test(lower)) score -= 2;
    if (/\b(i think|maybe|kind of|sort of|like)\b/.test(lower)) score -= 1;

    const namedComponents =
      /\b(the\s+)?(auth(entication|orization)?|user|admin|api|database|payment|checkout|settings|profile|dashboard|navigation|notification|sidebar|header|footer|modal|form|table|list|editor|router|middleware|controller|service|handler|adapter|provider|context|store|reducer|hook|component|module|schema|model|migration|plugin|worker|queue|cache|proxy|gateway|pipeline|engine|registration|login|signup|subscription|verification|deployment|configuration)\s+(module|component|service|function|class|hook|page|route|panel|layer|adapter|system|handler|manager|provider|controller|store|table|middleware|query|schema|form|modal|worker|pipeline|engine)\b/i;
    if (namedComponents.test(lower)) score += 2;

    const componentTypeAlone =
      /\b(the\s+(\w+\s+){0,3})(middleware|service|module|component|handler|controller|provider|adapter|pipeline|gateway|proxy|reducer|store|schema|migration|endpoint|route|webhook|worker|queue)\b/i;
    if (componentTypeAlone.test(lower)) score += 1;

    const transformSignal =
      /\b(instead of|rather than|replace .+ with|from .+ to|convert .+ to|switch .+ to|migrate .+ to)\b/i;
    if (transformSignal.test(lower)) score += 1;

    const featureEnumeration = lower.match(/,\s*(and\s+)?/g);
    if (featureEnumeration && featureEnumeration.length >= 2) score += 1;

    if (score >= 4) return "high";
    if (score >= 1) return "medium";
    return "low";
  }

  private classifyScope(lower: string, words: string[]): Scope {
    if (/\b(system|architecture|infrastructure|platform|everything)\b/.test(lower)) {
      return "cross-system";
    }
    if (/\b(product|project|app|application|tool|service)\b/.test(lower)) {
      return "product";
    }
    if (/\b(process|workflow|how we|meta|tool(ing|s)?)\b/.test(lower)) {
      return "meta";
    }
    if (/\w+\.\w{1,5}|line\s+\d+/i.test(lower)) {
      return "atomic";
    }
    if (words.length < 15) return "local";
    return "unknown";
  }

  private classifyEmotion(lower: string): EmotionalLoad {
    if (/[!]{2,}|\bfrustrat|\bhate|\bugh|\bannoy|\bterrible/.test(lower)) return "frustrated";
    if (/\bexcit|\bawesom|\bcool|\bgreat\b|\blov/.test(lower)) return "excited";
    if (/\bmaybe|\bnot sure|\bi think|\bperhaps|\bmight|\bcould\b/.test(lower)) return "uncertain";
    return "neutral";
  }

  private estimateConfidence(words: string[]): number {
    const base = 0.5;
    const lengthBonus = Math.min(words.length * 0.02, 0.3);
    return Math.min(base + lengthBonus, 0.95);
  }

  private extractKeyFragments(message: string): string[] {
    const fragments: string[] = [];
    const codeRefs = message.match(/`[^`]+`/g);
    if (codeRefs) fragments.push(...codeRefs.map((r) => r.slice(1, -1)));

    const quoted = message.match(/"[^"]+"/g);
    if (quoted) fragments.push(...quoted.map((q) => q.slice(1, -1)));

    const filePaths = message.match(/\b[\w./\\-]+\.\w{1,5}\b/g);
    if (filePaths) fragments.push(...filePaths);

    const temporalRefs = message.match(
      /\b(last time|same (?:approach|way|thing|method|pattern)|as before|like before|previously|as we discussed|what we discussed|what we talked about|mentioned (?:earlier|before|previously)|as usual|remember when|like we did|like last|we agreed|you (?:said|suggested|recommended))\b/gi,
    );
    if (temporalRefs) fragments.push(...temporalRefs.map((r) => r.toLowerCase()));

    const selectionRefs = message.match(
      /\b(option\s+[a-z0-9]+|[A-D]\s*[+&]\s*[A-D]|all of the above|all three|all four|both|neither|items?\s+\d+(?:\s*[-–]\s*\d+)?|(?:the\s+)?(?:first|second|third|last|former|latter)\s+(?:one|option|choice|item))\b/gi,
    );
    if (selectionRefs) fragments.push(...selectionRefs.map((r) => r.toLowerCase()));

    return [...new Set(fragments)];
  }

  private extractDomainHints(message: string): string[] {
    const hints: string[] = [];
    const domainTerms: Record<string, RegExp> = {
      auth: /\b(auth|login|session|jwt|token|password|credential|oauth)\b/i,
      database: /\b(database|db|sql|migration|schema|table|query|postgres|supabase)\b/i,
      api: /\b(api|endpoint|route|rest|graphql|rpc|webhook)\b/i,
      ui: /\b(ui|component|button|page|layout|style|css|tailwind|react|frontend)\b/i,
      deploy: /\b(deploy|ci|cd|pipeline|vercel|docker|build|release)\b/i,
      testing: /\b(test|spec|assert|mock|fixture|e2e|unit|integration)\b/i,
      security: /\b(security|rls|permission|role|encrypt|vulnerability|xss|csrf)\b/i,
      payment: /\b(payment|stripe|billing|subscription|invoice|checkout)\b/i,
      memory: /\b(last time|same (?:approach|way|thing|method|pattern)|as before|like before|previous(?:ly)?|as we discussed|what we discussed|what we talked about|mentioned (?:earlier|before|previously)|as usual|remember when|like we did|like last|we agreed|you (?:said|suggested|recommended))\b/i,
    };

    for (const [domain, pattern] of Object.entries(domainTerms)) {
      if (pattern.test(message)) hints.push(domain);
    }

    return hints;
  }

  // ── Context Inspection Helpers ─────────────────────────────────────────

  /**
   * Scans context layers for file-path references so the gap analyzer can
   * suppress "no file referenced" noise when the conversation or git context
   * already names specific files. Checks summaries and shallow data values.
   */
  private contextContainsFileReferences(context: ContextLayer[]): boolean {
    const filePattern = /\b[\w./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|sql|py|go|rs|java|rb|sh|toml|lock|css|scss|html)\b/i;
    const pathPattern = /(?:^|[\s"'`(])(?:\.{0,2}\/)?(?:[\w-]+\/){1,}[\w.-]+/;

    for (const layer of context) {
      if (filePattern.test(layer.summary) || pathPattern.test(layer.summary)) {
        return true;
      }
      for (const value of Object.values(layer.data)) {
        if (typeof value === "string") {
          if (filePattern.test(value) || pathPattern.test(value)) return true;
        } else if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === "string" && (filePattern.test(item) || pathPattern.test(item))) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  /**
   * Returns true when prior context has already bounded the problem space —
   * i.e. a conversation adapter captured decisions/topics/terminology, or a
   * memory adapter surfaced cross-session state. These signals mean the user
   * isn't starting from zero, so "scope boundaries unclear" gap is noise.
   */
  private contextEstablishesScope(context: ContextLayer[]): boolean {
    for (const layer of context) {
      if (layer.source === "komatik-memory") return true;
      if (layer.source === "conversation") {
        const hasDecisions =
          Array.isArray(layer.data.decisions) && layer.data.decisions.length > 0;
        const hasTopics =
          typeof layer.data.topics === "string" && layer.data.topics.length > 0;
        const hasTerminology =
          layer.data.terminology &&
          typeof layer.data.terminology === "object" &&
          Object.keys(layer.data.terminology as Record<string, unknown>).length > 0;
        if (hasDecisions || hasTopics || hasTerminology) return true;
      }
    }
    return false;
  }

  // ── Gap Resolution Helpers ─────────────────────────────────────────────

  private searchContextForGap(gap: Gap, layer: ContextLayer): string | null {
    const keywords = gap.description
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);
    const summaryLower = layer.summary.toLowerCase();

    const matchCount = keywords.filter((k) => summaryLower.includes(k)).length;
    if (matchCount >= 2) {
      return layer.summary;
    }

    return null;
  }

  private gapToQuestion(gap: Gap): string {
    const desc = gap.description.toLowerCase();

    if (desc.includes("file") || desc.includes("location")) {
      return "Which file or area are you referring to?";
    }
    if (desc.includes("scope") || desc.includes("system")) {
      return "Which part of the system does this touch?";
    }
    if (desc.includes("decision") || desc.includes("option")) {
      return "What are the options you're weighing?";
    }

    return `Could you clarify: ${gap.description}?`;
  }
}
