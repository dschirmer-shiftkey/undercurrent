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
      action: this.classifyAction(lower, words),
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

    if (intent.specificity !== "high") {
      if (intent.action === "build" || intent.action === "fix") {
        const hasFileRef = /(?:\w+\.\w{1,5}|\/\w+|line\s+\d+)/i.test(message);
        if (!hasFileRef) {
          gaps.push({
            id: randomUUID(),
            description: "No specific file or location referenced",
            critical: intent.action === "fix",
            resolution: null,
          });
        }
      }

      if (intent.scope === "unknown" || intent.scope === "cross-system") {
        gaps.push({
          id: randomUUID(),
          description: "Scope boundaries unclear — which systems/components are in play",
          critical: true,
          resolution: null,
        });
      }

      const pronouns = (message.match(/\b(it|this|that|those|these|the thing)\b/gi) ?? []).length;
      if (pronouns >= 2 && context.length === 0) {
        gaps.push({
          id: randomUUID(),
          description: "Multiple ambiguous references (pronouns without clear antecedents)",
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

  private classifyAction(lower: string, words: string[]): Action {
    const actionSignals: Record<Action, RegExp[]> = {
      build: [/\b(build|create|make|add|implement|set up|scaffold|generate|write)\b/],
      fix: [/\b(fix|bug|broken|error|issue|wrong|doesn'?t work|failing|crash)\b/],
      explore: [/\b(how|what|where|why|explain|show|understand|look at|check)\b/],
      design: [/\b(design|architect|plan|structure|approach|strategy|layout)\b/],
      discuss: [/\b(think|idea|opinion|thoughts?|consider|what if|should we)\b/],
      decide: [/\b(decide|choose|pick|which|or|vs|better|option|trade-?off)\b/],
      vent: [/\b(frustrated|annoying|hate|ugh|terrible|awful|ridiculous|stupid)\b/],
      unknown: [],
    };

    for (const [action, patterns] of Object.entries(actionSignals) as [Action, RegExp[]][]) {
      for (const pattern of patterns) {
        if (pattern.test(lower)) return action;
      }
    }

    if (words.length < 5) return "explore";
    return "unknown";
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
    };

    for (const [domain, pattern] of Object.entries(domainTerms)) {
      if (pattern.test(message)) hints.push(domain);
    }

    return hints;
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
