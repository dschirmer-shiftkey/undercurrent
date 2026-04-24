import type { ConversationTurn, ResponseSignals } from "../types.js";

// Regex fragments kept intentionally loose — these are triage signals, not
// parsers. False positives are cheap (a spurious suggestion chip); false
// negatives are expensive (the user gets no help on a turn that needed it).

const OPEN_QUESTION_PATTERNS: RegExp[] = [
  /\bwould you like (me )?to\b/i,
  /\bshould i\b/i,
  /\bshall i\b/i,
  /\bdo you want (me )?to\b/i,
  /\bwant me to\b/i,
  /\blet me know if\b/i,
  /\bnext step\??\s*$/i,
  /\?\s*$/,
];

const ERROR_PATTERNS: RegExp[] = [
  /\bfailed\b/i,
  /\berror(s|ed)?\b/i,
  /\bcould ?n[o']t\b/i,
  /\bunable to\b/i,
  /\bexception\b/i,
  /\btraceback\b/i,
  /\brejected\b/i,
  /\bblock(ed|er)\b/i,
];

const COMPLETION_PATTERNS: RegExp[] = [
  /\bdone\b/i,
  /\bcomplet(e|ed|ion)\b/i,
  /\bfinished\b/i,
  /\bmerged\b/i,
  /\b(all )?tests? pass(ed|ing)?\b/i,
  /\bgreen\b/i,
  /✓|✔|☑/,
];

// Strip Markdown code fences, inline code, and URLs before extracting terms
// so we don't scoop up language keywords or URL fragments as "referenced terms".
function stripNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
}

const IDENTIFIER_PATTERN = /\b([A-Z][a-z]+(?:[A-Z][a-zA-Z]*)*|[a-z]+(?:[A-Z][a-zA-Z]*)+|[A-Z]{2,}[A-Za-z]*)\b/g;

function extractReferencedTerms(response: string, limit = 12): string[] {
  const cleaned = stripNoise(response);
  const seen = new Map<string, number>();
  const matches = cleaned.matchAll(IDENTIFIER_PATTERN);
  for (const match of matches) {
    const term = match[1];
    if (!term || term.length < 3) continue;
    seen.set(term, (seen.get(term) ?? 0) + 1);
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term]) => term);
}

const STOPWORDS = new Set([
  "the","a","an","and","or","but","of","to","in","on","for","with","by","at",
  "is","it","this","that","those","these","be","been","are","was","were","have",
  "has","had","do","does","did","i","you","we","they","them","our","your",
]);

function topicTokens(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function detectTopicShift(response: string, conversation: ConversationTurn[]): boolean {
  const priorUserTurns = conversation.filter((t) => t.role === "user").slice(-2);
  if (priorUserTurns.length === 0) return false;
  const priorTokens = topicTokens(priorUserTurns.map((t) => t.content).join(" "));
  const responseTokens = topicTokens(response);
  if (priorTokens.size < 3 || responseTokens.size < 3) return false;
  return jaccard(priorTokens, responseTokens) < 0.08;
}

function anyMatch(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

export function analyzeResponse(
  response: string,
  conversation: ConversationTurn[] = [],
): ResponseSignals {
  return {
    containsOpenQuestion: anyMatch(response, OPEN_QUESTION_PATTERNS),
    containsError: anyMatch(response, ERROR_PATTERNS),
    containsCompletion: anyMatch(response, COMPLETION_PATTERNS),
    topicShift: detectTopicShift(response, conversation),
    referencedTerms: extractReferencedTerms(response),
  };
}
