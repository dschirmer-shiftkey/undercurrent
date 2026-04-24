import { randomUUID } from "node:crypto";
import type {
  FollowupCategory,
  FollowupSuggestion,
  ResponseSignals,
  SuggestionFeedback,
  SuggestionInput,
  SuggestionResult,
  SuggestionsConfig,
  EnrichmentStrategy,
} from "../types.js";
import { analyzeResponse } from "./response-signals.js";

const DEFAULT_MAX = 4;
const HARD_CAP = 5;

// ─── Heuristic generation ───────────────────────────────────────────────────

interface Candidate {
  category: FollowupCategory;
  prompt: string;
  label: string;
  rationale: string;
  confidence: number;
}

function generateHeuristic(
  _input: SuggestionInput,
  signals: ResponseSignals,
): Candidate[] {
  const candidates: Candidate[] = [];

  if (signals.containsOpenQuestion) {
    candidates.push({
      category: "continue",
      prompt: "Yes, go ahead with that.",
      label: "Yes, proceed",
      rationale: "Agent asked an open question; this confirms the proposed path.",
      confidence: 0.82,
    });
    candidates.push({
      category: "amend",
      prompt: "Not quite — take a different approach and explain before you start.",
      label: "Different approach",
      rationale: "Offers a pivot when the proposed path isn't right.",
      confidence: 0.62,
    });
    candidates.push({
      category: "stop",
      prompt: "Hold off — let me review before you continue.",
      label: "Pause for review",
      rationale: "Lets the user inspect before the agent acts on its question.",
      confidence: 0.55,
    });
  }

  if (signals.containsError) {
    candidates.push({
      category: "amend",
      prompt: "Revert the last change and try a smaller step.",
      label: "Revert and retry",
      rationale: "Agent reported an error; shrinking scope is the usual fix.",
      confidence: 0.7,
    });
    candidates.push({
      category: "stop",
      prompt: "Stop here — I'll debug this locally.",
      label: "Stop, I'll debug",
      rationale: "Gives the user an escape hatch when the agent is stuck.",
      confidence: 0.6,
    });
  }

  if (signals.containsCompletion) {
    candidates.push({
      category: "continue",
      prompt: "Run the tests and report the results.",
      label: "Run tests",
      rationale: "Natural validation step after a reported completion.",
      confidence: 0.78,
    });
    candidates.push({
      category: "continue",
      prompt: "Now update the changelog and bump the version.",
      label: "Update changelog",
      rationale: "Common follow-up after completing a change.",
      confidence: 0.55,
    });
    candidates.push({
      category: "stop",
      prompt: "Great — commit this and open a PR.",
      label: "Commit and PR",
      rationale: "Explicit handoff: agent is done, user wraps it up.",
      confidence: 0.72,
    });
  }

  if (signals.topicShift && !signals.containsError && !signals.containsOpenQuestion) {
    candidates.push({
      category: "amend",
      prompt: "Let's get back to the original task.",
      label: "Refocus",
      rationale: "Response drifted off-topic from the prior user turns.",
      confidence: 0.5,
    });
  }

  // Always include at least one low-risk continuation.
  if (!candidates.some((c) => c.category === "continue")) {
    candidates.push({
      category: "continue",
      prompt: "Keep going.",
      label: "Keep going",
      rationale: "Generic continuation when no specific signals fire.",
      confidence: 0.4,
    });
  }

  return candidates;
}

// ─── Terminology alignment ──────────────────────────────────────────────────
// Rewrites suggestion prompts so they use the user's canonical vocabulary
// instead of their common misspellings. Pulled from past enrichment
// outcomes (assumptions_corrected) where the "correction" entry stores the
// canonical term the user settled on. Pattern: "<wrong> -> <right>".

function buildTerminologyMap(
  corrections: string[] | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  if (!corrections) return map;
  for (const entry of corrections) {
    const match = entry.match(/^\s*(.+?)\s*(?:->|→|=>)\s*(.+?)\s*$/);
    if (!match) continue;
    const [, wrong, right] = match;
    if (wrong && right && wrong !== right) {
      map.set(wrong.toLowerCase(), right);
    }
  }
  return map;
}

function applyTerminology(text: string, map: Map<string, string>): string {
  if (map.size === 0) return text;
  let out = text;
  for (const [wrong, right] of map.entries()) {
    const pattern = new RegExp(`\\b${escapeRegex(wrong)}\\b`, "gi");
    out = out.replace(pattern, right);
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Ranking ────────────────────────────────────────────────────────────────

function rank(candidates: Candidate[], max: number): Candidate[] {
  const capped = Math.min(max, HARD_CAP);
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);

  // Take highest-confidence first, ensuring category balance: aim for at
  // least one continue + one amend before duplicating any category.
  const out: Candidate[] = [];
  const seen = new Set<FollowupCategory>();
  for (const c of sorted) {
    if (out.length >= capped) break;
    if (!seen.has(c.category)) {
      out.push(c);
      seen.add(c.category);
    }
  }
  // Fill remaining slots with best remaining candidates, avoiding duplicate prompts.
  for (const c of sorted) {
    if (out.length >= capped) break;
    if (out.includes(c)) continue;
    if (out.some((x) => x.prompt === c.prompt)) continue;
    out.push(c);
  }
  return out;
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

export interface SuggesterOptions {
  config?: SuggestionsConfig;
  strategy?: EnrichmentStrategy;
  correctionPatterns?: string[];
}

export class Suggester {
  private readonly config: SuggestionsConfig;
  private readonly strategy: EnrichmentStrategy | undefined;
  private readonly correctionPatterns: string[];

  constructor(options: SuggesterOptions = {}) {
    this.config = options.config ?? { enabled: false };
    this.strategy = options.strategy;
    this.correctionPatterns = options.correctionPatterns ?? [];
  }

  async suggest(input: SuggestionInput): Promise<SuggestionResult> {
    const startedAt = Date.now();

    if (!this.config.enabled) {
      return {
        suggestions: [],
        metadata: {
          processingTimeMs: 0,
          strategyUsed: "disabled",
          generatedAt: startedAt,
          responseSignals: {
            containsOpenQuestion: false,
            containsError: false,
            containsCompletion: false,
            topicShift: false,
            referencedTerms: [],
          },
        },
      };
    }

    const signals = analyzeResponse(input.agentResponse, input.conversation);

    let strategyUsed = "heuristic";
    let generated: FollowupSuggestion[] | null = null;

    if (this.strategy?.suggestFollowups) {
      try {
        generated = await this.strategy.suggestFollowups(input, signals);
        strategyUsed = `strategy:${this.strategy.name}`;
      } catch {
        generated = null;
      }
    }

    if ((!generated || generated.length === 0) && this.config.llmCall) {
      try {
        const llmResult = await this.generateWithLlm(input, signals);
        if (llmResult.length > 0) {
          generated = llmResult;
          strategyUsed = "llm";
        } else {
          generated = null;
          strategyUsed = "heuristic";
        }
      } catch {
        generated = null;
        strategyUsed = "heuristic";
      }
    }

    if (!generated || generated.length === 0) {
      strategyUsed = "heuristic";
      const candidates = generateHeuristic(input, signals);
      const ranked = rank(candidates, this.config.maxSuggestions ?? DEFAULT_MAX);
      generated = ranked.map(toSuggestion);
    } else {
      generated = generated.slice(
        0,
        Math.min(this.config.maxSuggestions ?? DEFAULT_MAX, HARD_CAP),
      );
    }

    const terminology = buildTerminologyMap(this.correctionPatterns);
    const aligned = generated.map((s) => ({
      ...s,
      prompt: applyTerminology(s.prompt, terminology),
      label: applyTerminology(s.label, terminology),
    }));

    return {
      suggestions: aligned,
      metadata: {
        processingTimeMs: Date.now() - startedAt,
        strategyUsed,
        generatedAt: startedAt,
        responseSignals: signals,
      },
    };
  }

  async recordFeedback(feedback: SuggestionFeedback): Promise<void> {
    if (!this.config.writer || !this.config.userId) return;

    const verdict =
      feedback.outcome === "accepted"
        ? "accepted"
        : feedback.outcome === "edited"
          ? "revised"
          : "ignored";

    const row = {
      user_id: this.config.userId,
      enrichment_id: null,
      original_message: feedback.suggestionId,
      enriched_message: feedback.editedPromptText ?? feedback.suggestionId,
      strategy_used: "followup-suggestion",
      enrichment_depth: "none",
      verdict,
      assumptions_accepted: [],
      assumptions_corrected: [],
      correction_details: {
        suggestionId: feedback.suggestionId,
        sessionId: feedback.sessionId ?? null,
        platform: feedback.platform ?? null,
      },
    };

    const { error } = await this.config.writer.from("enrichment_outcomes").insert(row);
    if (error) {
      throw new Error(`Suggester.recordFeedback failed: ${error.message}`);
    }
  }

  private async generateWithLlm(
    input: SuggestionInput,
    signals: ResponseSignals,
  ): Promise<FollowupSuggestion[]> {
    const llmCall = this.config.llmCall;
    if (!llmCall) return [];

    const prompt = buildLlmPrompt(input, signals);
    const raw = await llmCall(prompt);
    return parseLlmSuggestions(raw);
  }
}

function toSuggestion(c: Candidate): FollowupSuggestion {
  return {
    id: randomUUID(),
    category: c.category,
    prompt: c.prompt,
    label: c.label,
    rationale: c.rationale,
    confidence: c.confidence,
  };
}

function buildLlmPrompt(input: SuggestionInput, signals: ResponseSignals): string {
  return [
    "You are generating follow-up prompt suggestions for a chat UI.",
    "The user will see these as clickable chips under their text box.",
    "Each suggestion must be one of three categories:",
    "  - continue: the response is correct; take the natural next action",
    "  - amend: something needs adjustment",
    "  - stop: explicit halt or pivot",
    "",
    "Output a JSON array of 3-5 objects with keys:",
    '  {"category": "continue"|"amend"|"stop", "prompt": string, "label": string (<=40 chars), "rationale": string, "confidence": number 0..1}',
    "",
    `User's original message: ${input.originalMessage}`,
    "",
    `Agent's response:\n${input.agentResponse}`,
    "",
    `Detected signals: ${JSON.stringify(signals)}`,
    "",
    "Return only the JSON array, no prose.",
  ].join("\n");
}

function parseLlmSuggestions(raw: string): FollowupSuggestion[] {
  const trimmed = raw.trim();
  const jsonStart = trimmed.indexOf("[");
  const jsonEnd = trimmed.lastIndexOf("]");
  if (jsonStart === -1 || jsonEnd === -1) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: FollowupSuggestion[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const category = e.category;
    const prompt = e.prompt;
    const label = e.label;
    const rationale = e.rationale;
    const confidence = e.confidence;
    if (
      (category !== "continue" && category !== "amend" && category !== "stop") ||
      typeof prompt !== "string" ||
      typeof label !== "string" ||
      typeof rationale !== "string" ||
      typeof confidence !== "number"
    ) {
      continue;
    }
    out.push({
      id: randomUUID(),
      category,
      prompt,
      label,
      rationale,
      confidence: Math.max(0, Math.min(1, confidence)),
    });
  }
  return out;
}
