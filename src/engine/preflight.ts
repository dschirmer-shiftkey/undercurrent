import type { ConversationTurn, PreflightPolicy, PreflightResult } from "../types.js";

interface PreflightInput {
  message: string;
  conversation: ConversationTurn[];
  recentDecisions: string[];
  policy: PreflightPolicy;
}

const CONTINUATION_PHRASES = [
  "please",
  "pls",
  "plz",
  "continue",
  "next step",
  "next",
  "go ahead",
  "do it",
  "looks good",
  "merge when green",
  "ship it",
];

const DESTRUCTIVE_VERBS = [
  "merge",
  "delete",
  "drop",
  "deploy",
  "revert",
  "remove",
  "truncate",
  "force",
  "promote",
];

const AMBIGUOUS_REFERENCES = [
  "it",
  "this",
  "that",
  "these",
  "those",
  "them",
  "thing",
  "stuff",
];

const NEGATION_TOKENS = new Set(["dont", "don't", "not", "never", "no", "cannot", "cant", "can't", "shouldnt", "shouldn't", "wont", "won't"]);
const MIN_CONTRADICTION_CONTENT_WORDS = 3;
const MIN_CONTRADICTION_OVERLAP_WORDS = 2;

export function runPreflight(input: PreflightInput): PreflightResult {
  const normalized = normalizeWhitespace(input.message);
  let correctedMessage = normalized;
  const corrections: PreflightResult["corrections"] = [];

  if (input.policy.silentCorrectionsEnabled) {
    const typoFix = detectTypos(correctedMessage, input.conversation, input.policy.maxCorrectionsPerMessage);
    correctedMessage = typoFix.correctedMessage;
    corrections.push(...typoFix.corrections);

    const continuationFix = detectContinuation(correctedMessage);
    if (continuationFix) {
      corrections.push(continuationFix.correction);
      correctedMessage = continuationFix.correctedMessage;
    }
  }

  const cascadeRisk = scoreCascadeRisk(correctedMessage);
  const contradictions = detectContradictions(correctedMessage, input.recentDecisions);
  const highRisk = cascadeRisk.level === "high";
  const blockingClarificationNeeded =
    input.policy.blockOnCascadeRisk === "high" && (highRisk || contradictions.length > 0);

  return {
    correctedMessage,
    corrections,
    cascadeRisk,
    contradictions,
    blockingClarificationNeeded,
  };
}

function detectTypos(
  message: string,
  conversation: ConversationTurn[],
  maxCorrections: number,
): Pick<PreflightResult, "correctedMessage" | "corrections"> {
  const vocabulary = buildVocabulary(conversation);
  if (vocabulary.size === 0) {
    return { correctedMessage: message, corrections: [] };
  }

  const originalTokens = splitOnWhitespace(message);
  const correctedTokens = [...originalTokens];
  const corrections: PreflightResult["corrections"] = [];

  for (let i = 0; i < originalTokens.length; i++) {
    if (corrections.length >= maxCorrections) break;
    const token = originalTokens[i]!;
    const core = cleanWord(token);
    if (core.length < 3) continue;
    if (vocabulary.has(core)) continue;

    const best = nearestVocabularyMatch(core, vocabulary);
    if (!best) continue;

    const corrected = replaceWordCore(token, best.word);
    if (corrected === token) continue;
    correctedTokens[i] = corrected;
    corrections.push({
      type: "typo",
      original: token,
      corrected,
      basis: `Matched frequent session term "${best.word}"`,
      confidence: best.distance === 1 ? 0.85 : 0.7,
    });
  }

  return {
    correctedMessage: correctedTokens.join(" "),
    corrections,
  };
}

function detectContinuation(
  message: string,
): { correctedMessage: string; correction: PreflightResult["corrections"][number] } | null {
  const lower = normalizeWhitespace(message.toLowerCase());
  if (!CONTINUATION_PHRASES.includes(lower)) return null;

  return {
    correctedMessage: "acknowledge and continue with the current task",
    correction: {
      type: "continuation",
      original: message,
      corrected: "acknowledge and continue with the current task",
      basis: "Matched continuation shorthand",
      confidence: 0.95,
    },
  };
}

function scoreCascadeRisk(message: string): PreflightResult["cascadeRisk"] {
  const lower = message.toLowerCase();
  const words = splitOnWhitespace(lower);
  const signals: string[] = [];
  let score = 0;

  const ambiguousCount = words.filter((w) => AMBIGUOUS_REFERENCES.includes(cleanWord(w))).length;
  if (ambiguousCount >= 1) {
    score += ambiguousCount >= 2 ? 2 : 1;
    signals.push(`ambiguous-reference:${ambiguousCount}`);
  }

  const destructiveCount = words.filter((w) => DESTRUCTIVE_VERBS.includes(cleanWord(w))).length;
  if (destructiveCount > 0) {
    score += 2;
    signals.push(`high-consequence-verb:${destructiveCount}`);
  }

  if (words.length <= 3) {
    score += 1;
    signals.push("very-short-message");
  }

  if (score >= 4) {
    return { level: "high", signals, reasoning: "High-risk ambiguity with consequential action terms." };
  }
  if (score >= 2) {
    return { level: "medium", signals, reasoning: "Some ambiguity or brevity that may degrade resolution quality." };
  }
  return { level: "low", signals, reasoning: "Low ambiguity and no high-consequence signals." };
}

function detectContradictions(message: string, recentDecisions: string[]): string[] {
  if (recentDecisions.length === 0) return [];
  const lower = normalizeWhitespace(message.toLowerCase());
  const contradictions: string[] = [];
  if (!hasNegationToken(lower)) return contradictions;

  const contentWords = extractContentWords(lower);
  if (contentWords.size < MIN_CONTRADICTION_CONTENT_WORDS) return contradictions;

  for (const decision of recentDecisions.slice(-5)) {
    const decisionLower = normalizeWhitespace(decision.toLowerCase());
    const decisionWords = extractContentWords(decisionLower);
    if (decisionWords.size < MIN_CONTRADICTION_CONTENT_WORDS) continue;
    const sharedCount = sharedWordCount(contentWords, decisionWords);
    if (sharedCount < MIN_CONTRADICTION_OVERLAP_WORDS) continue;
    const overlap = sharedCount / Math.min(contentWords.size, decisionWords.size);
    if (overlap >= 0.4) {
      contradictions.push(`Potential contradiction with recent decision: "${truncate(decision, 80)}"`);
    }
  }

  return contradictions;
}

function hasNegationToken(lower: string): boolean {
  const tokens = splitOnWhitespace(lower).map((t) => cleanWord(t));
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (NEGATION_TOKENS.has(token)) return true;
    if (token === "do" && i + 1 < tokens.length && tokens[i + 1] === "not") return true;
  }
  return false;
}

function sharedWordCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) {
    if (b.has(token)) count++;
  }
  return count;
}

function buildVocabulary(conversation: ConversationTurn[]): Set<string> {
  const counts = new Map<string, number>();
  for (const turn of conversation) {
    for (const token of splitOnWhitespace(turn.content)) {
      const word = cleanWord(token);
      if (word.length < 4) continue;
      if (!isAlphaWord(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }

  const vocabulary = new Set<string>();
  for (const [word, count] of counts.entries()) {
    if (count >= 2) vocabulary.add(word);
  }
  return vocabulary;
}

function nearestVocabularyMatch(
  word: string,
  vocabulary: Set<string>,
): { word: string; distance: number } | null {
  let bestWord = "";
  let bestDistance = 3;
  for (const candidate of vocabulary) {
    const lenDiff = Math.abs(candidate.length - word.length);
    if (lenDiff > 2) continue;
    const distance = damerauLevenshtein(word, candidate, 2);
    if (distance > 2) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestWord = candidate;
    }
  }
  return bestWord ? { word: bestWord, distance: bestDistance } : null;
}

function damerauLevenshtein(a: string, b: string, maxDistance: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));

  for (let i = 0; i < rows; i++) dp[i]![0] = i;
  for (let j = 0; j < cols; j++) dp[0]![j] = j;

  for (let i = 1; i < rows; i++) {
    let rowMin = Number.MAX_SAFE_INTEGER;
    for (let j = 1; j < cols; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      let value = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
      if (
        i > 1 &&
        j > 1 &&
        a.charAt(i - 1) === b.charAt(j - 2) &&
        a.charAt(i - 2) === b.charAt(j - 1)
      ) {
        value = Math.min(value, dp[i - 2]![j - 2]! + 1);
      }
      dp[i]![j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
  }

  return dp[a.length]![b.length]!;
}

function extractContentWords(text: string): Set<string> {
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "to",
    "of",
    "and",
    "for",
    "on",
    "in",
    "with",
    "is",
    "are",
    "be",
    "this",
    "that",
    "it",
    "please",
  ]);
  const words = splitOnWhitespace(text)
    .map((token) => cleanWord(token))
    .filter((word) => word.length >= 3 && !stopWords.has(word));
  return new Set(words);
}

function replaceWordCore(token: string, replacement: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && !isAlphaNumeric(token.charAt(start))) start++;
  while (end > start && !isAlphaNumeric(token.charAt(end - 1))) end--;
  const leading = token.slice(0, start);
  const trailing = token.slice(end);
  return `${leading}${replacement}${trailing}`;
}

function cleanWord(token: string): string {
  const lower = token.toLowerCase();
  let start = 0;
  let end = lower.length;
  while (start < end && !isLowerAlphaNumeric(lower.charAt(start))) start++;
  while (end > start && !isLowerAlphaNumeric(lower.charAt(end - 1))) end--;
  return lower.slice(start, end);
}

function isAlphaWord(token: string): boolean {
  if (token.length === 0) return false;
  for (let i = 0; i < token.length; i++) {
    const ch = token.charAt(i);
    if (!(ch >= "a" && ch <= "z")) return false;
  }
  return true;
}

function normalizeWhitespace(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  let out = "";
  let prevSpace = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed.charAt(i);
    const isSpace = isWhitespace(ch);
    if (isSpace) {
      if (!prevSpace) out += " ";
      prevSpace = true;
    } else {
      out += ch;
      prevSpace = false;
    }
  }
  return out;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function splitOnWhitespace(value: string): string[] {
  const normalized = normalizeWhitespace(value);
  if (normalized.length === 0) return [];
  return normalized.split(" ");
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function isAlphaNumeric(ch: string): boolean {
  return (
    (ch >= "A" && ch <= "Z") ||
    (ch >= "a" && ch <= "z") ||
    (ch >= "0" && ch <= "9")
  );
}

function isLowerAlphaNumeric(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
}
