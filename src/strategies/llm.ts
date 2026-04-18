import { randomUUID } from "node:crypto";
import { DefaultStrategy } from "./default.js";
import type {
  Action,
  Assumption,
  ContextLayer,
  ConversationTurn,
  EnrichmentStrategy,
  Gap,
  GapResolution,
  IntentSignal,
  Scope,
  Specificity,
  EmotionalLoad,
} from "../types.js";

export interface LlmStrategyOptions {
  llmCall: (prompt: string) => Promise<string>;
  /** Max conversation turns to include in prompts (default: 10) */
  maxConversationTurns?: number;
  /** Skip LLM for classifyIntent when heuristic confidence exceeds this (default: 0.8) */
  heuristicConfidenceThreshold?: number;
}

const VALID_ACTIONS: Action[] = ["build", "fix", "explore", "design", "discuss", "decide", "vent", "unknown"];
const VALID_SPECIFICITIES: Specificity[] = ["high", "medium", "low"];
const VALID_SCOPES: Scope[] = ["atomic", "local", "cross-system", "product", "meta", "unknown"];
const VALID_EMOTIONS: EmotionalLoad[] = ["neutral", "frustrated", "excited", "uncertain"];

/**
 * LLM-assisted enrichment strategy. Delegates intent classification, gap
 * analysis, gap resolution, and composition to an LLM via a pluggable
 * callback — zero SDK dependencies. Falls back to DefaultStrategy
 * heuristics when the LLM is unavailable or returns unparseable output.
 *
 * The heuristic pre-filter skips the LLM entirely for high-confidence,
 * high-specificity messages where regex classification is sufficient.
 */
export class LlmStrategy implements EnrichmentStrategy {
  readonly name = "llm";

  private readonly llmCall: (prompt: string) => Promise<string>;
  private readonly fallback: DefaultStrategy;
  private readonly maxTurns: number;
  private readonly heuristicThreshold: number;

  constructor(options: LlmStrategyOptions) {
    this.llmCall = options.llmCall;
    this.fallback = new DefaultStrategy();
    this.maxTurns = options.maxConversationTurns ?? 10;
    this.heuristicThreshold = options.heuristicConfidenceThreshold ?? 0.8;
  }

  async classifyIntent(message: string, conversation: ConversationTurn[]): Promise<IntentSignal> {
    const heuristic = await this.fallback.classifyIntent(message, conversation);

    if (heuristic.confidence >= this.heuristicThreshold && heuristic.specificity === "high") {
      return heuristic;
    }

    try {
      const recentTurns = conversation.slice(-this.maxTurns);
      const conversationBlock = recentTurns.length > 0
        ? `\nRecent conversation:\n${recentTurns.map((t) => `${t.role}: ${t.content}`).join("\n")}`
        : "";

      const prompt = `Classify the intent of this user message. Return ONLY valid JSON, no markdown.

Message: "${message}"${conversationBlock}

Return JSON with these exact fields:
{
  "action": one of ${JSON.stringify(VALID_ACTIONS)},
  "specificity": one of ${JSON.stringify(VALID_SPECIFICITIES)},
  "scope": one of ${JSON.stringify(VALID_SCOPES)},
  "emotionalLoad": one of ${JSON.stringify(VALID_EMOTIONS)},
  "confidence": number 0-1,
  "rawFragments": string[] of key phrases from the message,
  "domainHints": string[] of detected domains (e.g. "auth", "database", "ui")
}`;

      const raw = await this.llmCall(prompt);
      const parsed = this.parseJson<Record<string, unknown>>(raw);
      if (parsed && this.validateIntent(parsed)) {
        return parsed as unknown as IntentSignal;
      }
      return heuristic;
    } catch {
      return heuristic;
    }
  }

  async analyzeGaps(
    intent: IntentSignal,
    context: ContextLayer[],
    message: string,
  ): Promise<Gap[]> {
    try {
      const contextSummary = context.length > 0
        ? `\nAvailable context:\n${context.map((c) => `- [${c.source}]: ${c.summary}`).join("\n")}`
        : "\nNo context available.";

      const prompt = `Identify information gaps in this user request. A gap is something the AI needs to know but the user didn't provide. Return ONLY valid JSON, no markdown.

Message: "${message}"
Intent: ${intent.action} (${intent.specificity} specificity, ${intent.scope} scope)${contextSummary}

Return a JSON array of gaps. Each gap:
{
  "description": "what information is missing",
  "critical": true/false (true = blocks progress, false = nice to have)
}

If no gaps exist, return []. Be conservative — only flag genuine ambiguities, not things inferable from context.`;

      const raw = await this.llmCall(prompt);
      const parsed = this.parseJson<Array<{ description: string; critical: boolean }>>(raw);
      if (parsed && Array.isArray(parsed)) {
        return parsed
          .filter((g) => typeof g.description === "string" && typeof g.critical === "boolean")
          .map((g) => ({
            id: randomUUID(),
            description: g.description,
            critical: g.critical,
            resolution: null,
          }));
      }
      return this.fallback.analyzeGaps(intent, context, message);
    } catch {
      return this.fallback.analyzeGaps(intent, context, message);
    }
  }

  async resolveGap(
    gap: Gap,
    context: ContextLayer[],
    confidenceThreshold: number,
  ): Promise<GapResolution> {
    try {
      const contextSummary = context.length > 0
        ? `\nAvailable context:\n${context.map((c) => `- [${c.source}]: ${c.summary}`).join("\n")}`
        : "\nNo context available.";

      const prompt = `Resolve this information gap using the available context. Return ONLY valid JSON, no markdown.

Gap: "${gap.description}"
Critical: ${gap.critical}${contextSummary}

If context provides a clear answer, return:
{ "type": "filled", "value": "the answer", "source": "which context source" }

If you can make a reasonable inference (but aren't certain), return:
{ "type": "assumed", "claim": "what you're assuming", "basis": "why", "confidence": number 0-1 }

If neither works and this is critical, return:
{ "type": "needs-clarification", "question": "a clear question answerable in under 3 seconds" }

Prefer filling or assuming over asking. Only ask when truly stuck on a critical gap.`;

      const raw = await this.llmCall(prompt);
      const parsed = this.parseJson<Record<string, unknown>>(raw);

      if (parsed && typeof parsed.type === "string") {
        if (parsed.type === "filled" && typeof parsed.value === "string" && typeof parsed.source === "string") {
          return { type: "filled", value: parsed.value, source: parsed.source };
        }

        if (parsed.type === "assumed" && typeof parsed.claim === "string") {
          return {
            type: "assumed",
            assumption: {
              id: randomUUID(),
              claim: parsed.claim as string,
              basis: typeof parsed.basis === "string" ? parsed.basis : "LLM inference",
              confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.6,
              source: "llm-strategy",
              correctable: true,
            },
          };
        }

        if (parsed.type === "needs-clarification" && typeof parsed.question === "string") {
          return {
            type: "needs-clarification",
            clarification: {
              id: randomUUID(),
              question: parsed.question as string,
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
      }

      return this.fallback.resolveGap(gap, context, confidenceThreshold);
    } catch {
      return this.fallback.resolveGap(gap, context, confidenceThreshold);
    }
  }

  async compose(
    message: string,
    intent: IntentSignal,
    context: ContextLayer[],
    assumptions: Assumption[],
    resolvedGaps: Gap[],
  ): Promise<string> {
    try {
      const contextBlock = context.length > 0
        ? `\nContext:\n${context.map((c) => `- [${c.source}]: ${c.summary}`).join("\n")}`
        : "";

      const assumptionBlock = assumptions.length > 0
        ? `\nAssumptions made:\n${assumptions.map((a) => `- ${a.claim} (${(a.confidence * 100).toFixed(0)}% confidence)`).join("\n")}`
        : "";

      const filledGaps = resolvedGaps.filter(
        (g): g is Gap & { resolution: { type: "filled"; value: string; source: string } } =>
          g.resolution?.type === "filled",
      );
      const gapBlock = filledGaps.length > 0
        ? `\nAuto-resolved gaps:\n${filledGaps.map((g) => `- ${g.description} → ${g.resolution.value} (from ${g.resolution.source})`).join("\n")}`
        : "";

      const prompt = `You are an invisible prompt enrichment layer. Compose an enriched version of the user's message that gives the downstream AI everything it needs to respond well. Be concise but thorough. Do not ask questions — just present the enriched context.

Original message: "${message}"
Intent: ${intent.action} (${intent.specificity} specificity, ${intent.scope} scope)
Domains: ${intent.domainHints.length > 0 ? intent.domainHints.join(", ") : "none detected"}${contextBlock}${assumptionBlock}${gapBlock}

Write the enriched prompt directly. Include:
1. The original request
2. Relevant context that helps the AI understand what the user actually needs
3. Any assumptions made (so the AI can correct them if wrong)
4. Domain and scope information

Keep it natural and direct — this will be injected as a system-level context block.`;

      const composed = await this.llmCall(prompt);
      if (composed && composed.trim().length > 0) {
        return composed.trim();
      }
      return this.fallback.compose(message, intent, context, assumptions, resolvedGaps);
    } catch {
      return this.fallback.compose(message, intent, context, assumptions, resolvedGaps);
    }
  }

  private parseJson<T>(raw: string): T | null {
    try {
      return JSON.parse(raw) as T;
    } catch {
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch?.[1]) {
        try {
          return JSON.parse(jsonMatch[1].trim()) as T;
        } catch {
          return null;
        }
      }

      const braceMatch = raw.match(/[\[{][\s\S]*[\]}]/);
      if (braceMatch) {
        try {
          return JSON.parse(braceMatch[0]) as T;
        } catch {
          return null;
        }
      }

      return null;
    }
  }

  private validateIntent(parsed: Record<string, unknown>): boolean {
    return (
      VALID_ACTIONS.includes(parsed.action as Action) &&
      VALID_SPECIFICITIES.includes(parsed.specificity as Specificity) &&
      VALID_SCOPES.includes(parsed.scope as Scope) &&
      VALID_EMOTIONS.includes(parsed.emotionalLoad as EmotionalLoad) &&
      typeof parsed.confidence === "number" &&
      Array.isArray(parsed.rawFragments) &&
      Array.isArray(parsed.domainHints)
    );
  }
}
