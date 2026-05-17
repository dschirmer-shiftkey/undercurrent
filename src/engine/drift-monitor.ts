import type { ConversationTurn } from "../types.js";

/**
 * Syntactic drift monitor — tracks the canonical surface form for each entity
 * (proper nouns, identifiers, paths, ticket refs) seen in a session and emits
 * drift events when later mentions diverge from the canonical.
 *
 * No embeddings, no LLM. Pure character-level analysis. Catches:
 *   - case drift   (Komatik → komatik / KOMATIK)
 *   - suffix drift (Komatik → KomatikAI, Slipstream → Slipstreams)
 *   - typo drift   (Slipstream → Slipsteam, edit distance ≤ 2)
 *   - path drift   (~/.supabase vs /home/foo/.supabase, \ vs /)
 *
 * Designed to complement preflight's typo correction (which uses session
 * vocabulary frequency); this layer focuses on *entity identity stability*
 * across long sessions where vocabulary subtly mutates.
 */

export type DriftKind = "case" | "suffix" | "typo" | "path";

export type DriftAction = "rewrite" | "flag";

export interface DriftEvent {
  /** Surface form as it appeared in this turn. */
  observed: string;
  /** Canonical surface form previously seen. */
  canonical: string;
  /** What kind of drift this is. */
  kind: DriftKind;
  /** Whether the monitor's policy would auto-rewrite or just surface a warning. */
  action: DriftAction;
  /** First-seen turn index of the canonical (helps trace where drift started). */
  canonicalFirstSeenTurn: number;
  /** Turn index where this drift was observed. */
  observedTurn: number;
  /** Human-readable reasoning. */
  reasoning: string;
}

export interface DriftMonitorOptions {
  /** Entities the monitor should always treat as canonical (skipped from registry overwrite). */
  pinnedCanonicals?: string[];
  /** Disable specific drift kinds. Defaults: all enabled. */
  disable?: DriftKind[];
  /** Rolling window (number of turns) used by the gauge to weight recent drift. Default 5. */
  gaugeWindowTurns?: number;
  /** Score threshold above which `refreshRecommended` flips true. Default 40 (moderate). */
  refreshThreshold?: number;
}

export type DriftLevel = "stable" | "minor" | "moderate" | "elevated" | "critical";

export interface DriftGauge {
  /** Total drift events observed since session start. */
  totalEvents: number;
  /** Events whose `observedTurn` falls within the rolling window. */
  recentEvents: number;
  /** Most recent turn index observed (drives the rolling window). */
  asOfTurn: number;
  /** Weighted score 0-100. Higher = more drift pressure. */
  score: number;
  /** Bucket derived from `score`. */
  level: DriftLevel;
  /** True when score ≥ `refreshThreshold` — caller should consider refreshing context. */
  refreshRecommended: boolean;
  /** Plain-English explanation of the current reading. */
  reasoning: string;
  /** Cumulative count by drift kind (all events ever observed). */
  byKind: Record<DriftKind, number>;
  /** Direction over the last 3 gauge readings. */
  trend: "stable" | "increasing" | "decreasing";
}

export interface DriftReport {
  events: DriftEvent[];
  registry: Map<string, RegistryEntry>;
  byKind: Record<DriftKind, number>;
  rewrites: number;
  flags: number;
  gauge: DriftGauge;
}

interface RegistryEntry {
  canonical: string;
  firstSeenTurn: number;
  occurrences: number;
}

const PINNED_DEFAULTS = ["Slipstream", "Komatik", "@komatik/slipstream"];

const ENTITY_PATTERNS: { name: string; pattern: RegExp }[] = [
  // Scoped npm packages: @komatik/slipstream
  { name: "scoped-package", pattern: /@[a-z][\w-]*\/[a-z][\w-]*/g },
  // snake_case identifiers (multi-segment): xbom_slots, undercurrent_settings
  { name: "snake_case", pattern: /\b[a-z][a-z0-9]+(?:_[a-z0-9]+)+\b/g },
  // kebab-case identifiers (multi-segment): engine-station-types, slipstream-mcp
  { name: "kebab-case", pattern: /\b[a-z][a-z0-9]+(?:-[a-z0-9]+)+\b/g },
  // PascalCase / CamelCase / TitleCase proper nouns: Komatik, KomatikAI, MyClass
  { name: "pascal-or-title", pattern: /\b[A-Z][a-zA-Z0-9]{2,}\b/g },
  // POSIX file paths (require a slash + name char): /home/foo/x, ./src/foo
  { name: "posix-path", pattern: /(?:\/[\w.-]+){2,}/g },
  // Windows-style paths with backslashes
  { name: "windows-path", pattern: /(?:[\w.-]+\\[\w.-]+)+/g },
  // Tilde-relative paths
  { name: "tilde-path", pattern: /~[/\\][\w.-]+(?:[/\\][\w.-]+)*/g },
];

const STOP_PASCAL = new Set([
  // All-caps acronyms
  "TODO", "FIXME", "XXX", "HTTP", "HTTPS", "JSON", "URL", "API", "SDK",
  "MCP", "CRS", "CI", "AI", "ID", "OK", "PR", "CLI", "UI", "DB", "SQL",
  "JWT", "OAuth", "REST", "GET", "POST", "PUT", "DELETE", "PATCH",
  // Common sentence-start words (proper nouns wouldn't be drift candidates anyway)
  "The", "This", "That", "These", "Those", "Then", "There", "Their",
  "Also", "Any", "All", "And", "Are", "As", "At",
  "But", "Be", "Been", "Being", "Both", "By",
  "Can", "Could", "Check", "Checking",
  "Did", "Do", "Does", "Done", "Doing", "Deleting", "Deleted",
  "For", "From", "First",
  "Got", "Going",
  "Have", "Has", "Had", "Here", "How",
  "If", "In", "Is", "It", "Its",
  "Just",
  "Keep",
  "Let", "Last", "Like",
  "Make", "Made", "Move", "Moved", "Moving", "May", "Might", "Must",
  "Need", "Not", "Now", "Next", "Note", "Noted",
  "Of", "On", "Once", "Only", "Or", "Our", "Out", "Over", "Open",
  "Please", "Pull", "Pass", "Passed", "Put",
  "Re", "Run", "Running", "Ready", "Right", "Re-run",
  "See", "So", "Some", "Should", "Standing", "Sure", "Set",
  "Take", "Test", "That", "Then", "Thanks", "Try",
  "Up", "Use", "Used", "Update", "Updated",
  "Verify", "Verified", "Verifying",
  "Was", "Will", "Would", "Want", "We", "What", "When", "Where", "Which", "While", "With",
  "Yes", "You",
  // Common short capitalized words found mid-sentence
  "Edge", "Wait", "Hold", "Acknowledged", "Reviewing", "Started", "Finished",
]);

const ENGLISH_VERB_INFLECTION_SUFFIXES = ["s", "ed", "ing", "es", "er"];

const KIND_WEIGHT: Record<DriftKind, number> = {
  case: 1,
  path: 1,
  suffix: 2,
  typo: 3,
};

export class DriftMonitor {
  private readonly registry = new Map<string, RegistryEntry>();
  private readonly disabled: Set<DriftKind>;
  private readonly pinned: Set<string>;
  private readonly allEvents: DriftEvent[] = [];
  private readonly scoreHistory: number[] = [];
  private readonly gaugeWindow: number;
  private readonly refreshThreshold: number;
  private latestTurn = -1;

  constructor(options: DriftMonitorOptions = {}) {
    this.disabled = new Set(options.disable ?? []);
    this.pinned = new Set([...(options.pinnedCanonicals ?? []), ...PINNED_DEFAULTS]);
    this.gaugeWindow = options.gaugeWindowTurns ?? 5;
    this.refreshThreshold = options.refreshThreshold ?? 40;
    for (const canonical of this.pinned) {
      this.registry.set(normalizeKey(canonical), {
        canonical,
        firstSeenTurn: -1,
        occurrences: 0,
      });
    }
  }

  /** Process a single message and return drift events surfaced this turn. */
  observe(message: string, turnIndex: number): DriftEvent[] {
    this.latestTurn = Math.max(this.latestTurn, turnIndex);
    const candidates = extractEntities(message);
    // Also pull lowercase single-word tokens that match a known canonical's key —
    // catches "slipstream" when canonical is "Slipstream".
    for (const token of extractLowercaseWords(message)) {
      if (this.registry.has(token) && !candidates.includes(token)) {
        candidates.push(token);
      }
    }
    const events: DriftEvent[] = [];

    for (const candidate of candidates) {
      if (STOP_PASCAL.has(candidate)) continue;
      if (candidate.length < 3) continue;

      const key = normalizeKey(candidate);
      const existing = this.registry.get(key);

      if (!existing) {
        // First time seeing this exact (normalized) entity — check fuzzy match
        // against existing canonicals to catch typo / suffix drift.
        const fuzzy = this.findFuzzyMatch(candidate);
        if (fuzzy) {
          events.push(fuzzy.event(turnIndex, candidate));
        } else {
          this.registry.set(key, {
            canonical: candidate,
            firstSeenTurn: turnIndex,
            occurrences: 1,
          });
        }
        continue;
      }

      existing.occurrences++;

      // Same normalized key but different surface form → case drift.
      if (existing.canonical !== candidate && !this.disabled.has("case")) {
        events.push({
          observed: candidate,
          canonical: existing.canonical,
          kind: "case",
          action: "rewrite",
          canonicalFirstSeenTurn: existing.firstSeenTurn,
          observedTurn: turnIndex,
          reasoning: `Surface form differs by case/punctuation; canonical seen first at turn ${existing.firstSeenTurn}.`,
        });
      }
    }

    if (events.length > 0) {
      this.allEvents.push(...events);
    }
    this.recordScoreSnapshot();
    return events;
  }

  /**
   * Current drift gauge. Informational — surfaces a single score + level
   * (and an optional `refreshRecommended` flag) that an integrator can use
   * to decide whether to refresh canonical context, prompt the user, or
   * trigger compaction. The monitor does not act on the gauge itself.
   */
  gauge(): DriftGauge {
    const byKind: Record<DriftKind, number> = { case: 0, suffix: 0, typo: 0, path: 0 };
    let recentEvents = 0;
    let weightedRecent = 0;
    const windowStart = Math.max(0, this.latestTurn - this.gaugeWindow + 1);

    for (const event of this.allEvents) {
      byKind[event.kind]++;
      if (event.observedTurn >= windowStart) {
        recentEvents++;
        weightedRecent += KIND_WEIGHT[event.kind];
        // Flag-class events surface ambiguity — slightly higher weight than
        // rewrite-class (rewrite is unambiguously the same entity).
        if (event.action === "flag") weightedRecent += 0.5;
      }
    }

    const score = Math.min(100, Math.round(weightedRecent * 8));
    const level = scoreToLevel(score);
    const refreshRecommended = score >= this.refreshThreshold;
    const trend = computeTrend(this.scoreHistory);
    const reasoning = buildReasoning(score, level, recentEvents, byKind, trend, refreshRecommended);

    return {
      totalEvents: this.allEvents.length,
      recentEvents,
      asOfTurn: this.latestTurn,
      score,
      level,
      refreshRecommended,
      reasoning,
      byKind,
      trend,
    };
  }

  private recordScoreSnapshot(): void {
    const snapshot = this.gauge().score;
    this.scoreHistory.push(snapshot);
    if (this.scoreHistory.length > 4) this.scoreHistory.shift();
  }

  /** Replay a full conversation and return an aggregated report. */
  analyze(conversation: ConversationTurn[]): DriftReport {
    const events: DriftEvent[] = [];
    for (let i = 0; i < conversation.length; i++) {
      const turn = conversation[i]!;
      if (turn.role !== "user" && turn.role !== "assistant") continue;
      events.push(...this.observe(turn.content, i));
    }
    return this.summarize(events);
  }

  /** Return current canonical registry (for inspection/export). */
  getRegistry(): Map<string, RegistryEntry> {
    return new Map(this.registry);
  }

  /**
   * Seed the registry with previously-canonical entities (e.g., restored
   * from a session snapshot). Existing entries are NOT overwritten — the
   * current session's first-seen rule still wins for any entity already
   * tracked. Entries seeded this way have firstSeenTurn=-1 (carried over).
   */
  seedCanonicals(canonicals: string[]): void {
    for (const canonical of canonicals) {
      if (canonical.length < 3) continue;
      const key = normalizeKey(canonical);
      if (this.registry.has(key)) continue;
      this.registry.set(key, {
        canonical,
        firstSeenTurn: -1,
        occurrences: 0,
      });
    }
  }

  /** Apply auto-rewrite-class drift events to a message and return the rewritten form. */
  rewrite(message: string, events: DriftEvent[]): string {
    let out = message;
    for (const event of events) {
      if (event.action !== "rewrite") continue;
      // Word-boundary replace, case-sensitive to avoid clobbering unrelated tokens.
      const escaped = event.observed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`\\b${escaped}\\b`, "g"), event.canonical);
    }
    return out;
  }

  private summarize(events: DriftEvent[]): DriftReport {
    const byKind: Record<DriftKind, number> = { case: 0, suffix: 0, typo: 0, path: 0 };
    let rewrites = 0;
    let flags = 0;
    for (const event of events) {
      byKind[event.kind]++;
      if (event.action === "rewrite") rewrites++;
      else flags++;
    }
    return { events, registry: new Map(this.registry), byKind, rewrites, flags, gauge: this.gauge() };
  }

  private findFuzzyMatch(candidate: string): FuzzyMatchResult | null {
    // Path-shape drift: backslash vs forward-slash, ~ vs absolute.
    if (looksLikePath(candidate) && !this.disabled.has("path")) {
      const normalized = normalizePath(candidate);
      for (const entry of this.registry.values()) {
        if (!looksLikePath(entry.canonical)) continue;
        if (normalizePath(entry.canonical) === normalized && entry.canonical !== candidate) {
          return {
            event: (turn, observed) => ({
              observed,
              canonical: entry.canonical,
              kind: "path",
              action: "rewrite",
              canonicalFirstSeenTurn: entry.firstSeenTurn,
              observedTurn: turn,
              reasoning: `Path with different separator/prefix; normalized forms match.`,
            }),
          };
        }
      }
    }

    // Suffix drift: candidate is canonical + 1-4 trailing letters (or vice versa).
    // Both sides must be ≥5 chars to avoid firing on English verb inflection
    // ("Move" → "Moved", "Run" → "Running").
    if (!this.disabled.has("suffix") && candidate.length >= 5) {
      for (const entry of this.registry.values()) {
        if (entry.canonical.length < 5) continue;
        const a = candidate.toLowerCase();
        const b = entry.canonical.toLowerCase();
        if (a === b) continue;
        if (Math.abs(a.length - b.length) > 4) continue;
        const longer = a.length > b.length ? a : b;
        const shorter = a.length > b.length ? b : a;
        if (!longer.startsWith(shorter)) continue;
        const suffix = longer.slice(shorter.length);
        // Skip if the suffix is a common English inflection (plural / past / gerund).
        if (ENGLISH_VERB_INFLECTION_SUFFIXES.includes(suffix)) continue;
        // Only flag (don't rewrite): suffix-extended forms are often intentional
        // (Komatik → KomatikAI may be a real distinction).
        return {
          event: (turn, observed) => ({
            observed,
            canonical: entry.canonical,
            kind: "suffix",
            action: "flag",
            canonicalFirstSeenTurn: entry.firstSeenTurn,
            observedTurn: turn,
            reasoning: `Differs from "${entry.canonical}" by ${longer.length - shorter.length} trailing characters ("${suffix}"); possibly intentional.`,
          }),
        };
      }
    }

    // Typo drift: edit distance ≤ 2 against an existing canonical of similar length.
    if (!this.disabled.has("typo")) {
      const candidateKey = candidate.toLowerCase();
      let bestMatch: { entry: RegistryEntry; distance: number } | null = null;
      for (const entry of this.registry.values()) {
        const entryKey = entry.canonical.toLowerCase();
        if (Math.abs(entryKey.length - candidateKey.length) > 2) continue;
        if (candidateKey === entryKey) continue;
        const distance = damerauLevenshtein(candidateKey, entryKey, 2);
        if (distance > 2) continue;
        // Require occurrences ≥ 2 on canonical to avoid false positives on
        // first-seen entities that look similar by coincidence.
        if (entry.occurrences < 2) continue;
        if (!bestMatch || distance < bestMatch.distance) {
          bestMatch = { entry, distance };
        }
      }
      if (bestMatch) {
        return {
          event: (turn, observed) => ({
            observed,
            canonical: bestMatch!.entry.canonical,
            kind: "typo",
            action: "flag",
            canonicalFirstSeenTurn: bestMatch!.entry.firstSeenTurn,
            observedTurn: turn,
            reasoning: `Edit distance ${bestMatch!.distance} from "${bestMatch!.entry.canonical}" (${bestMatch!.entry.occurrences} prior occurrences).`,
          }),
        };
      }
    }

    return null;
  }
}

interface FuzzyMatchResult {
  event: (turnIndex: number, observed: string) => DriftEvent;
}

function extractEntities(message: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { pattern } of ENTITY_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(message)) !== null) {
      const token = match[0];
      if (!seen.has(token)) {
        seen.add(token);
        out.push(token);
      }
    }
  }
  return out;
}

function scoreToLevel(score: number): DriftLevel {
  if (score === 0) return "stable";
  if (score <= 15) return "minor";
  if (score <= 40) return "moderate";
  if (score <= 70) return "elevated";
  return "critical";
}

function computeTrend(history: number[]): "stable" | "increasing" | "decreasing" {
  if (history.length < 2) return "stable";
  const last = history[history.length - 1]!;
  const prev = history[history.length - 2]!;
  if (last > prev + 5) return "increasing";
  if (last < prev - 5) return "decreasing";
  return "stable";
}

function buildReasoning(
  score: number,
  level: DriftLevel,
  recentEvents: number,
  byKind: Record<DriftKind, number>,
  trend: "stable" | "increasing" | "decreasing",
  refreshRecommended: boolean,
): string {
  if (level === "stable") {
    return "No drift in recent turns. Canonical vocabulary stable.";
  }
  const kinds = (Object.entries(byKind) as [DriftKind, number][])
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(", ");
  const trendNote =
    trend === "increasing" ? " — trending up" : trend === "decreasing" ? " — trending down" : "";
  const refreshNote = refreshRecommended
    ? " Consider refreshing canonical context (re-seed entities, prompt user to confirm key terms)."
    : "";
  return `${capitalize(level)} drift pressure (score ${score}, ${recentEvents} recent event${recentEvents === 1 ? "" : "s"}; total by kind: ${kinds})${trendNote}.${refreshNote}`;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

const LOWERCASE_WORD_PATTERN = /\b[a-z][a-z0-9]{2,}\b/g;

function extractLowercaseWords(message: string): string[] {
  const out: string[] = [];
  LOWERCASE_WORD_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LOWERCASE_WORD_PATTERN.exec(message)) !== null) {
    out.push(match[0]);
  }
  return out;
}

function normalizeKey(s: string): string {
  return s.toLowerCase();
}

function looksLikePath(s: string): boolean {
  return s.includes("/") || s.includes("\\");
}

function normalizePath(p: string): string {
  let n = p.replace(/\\/g, "/");
  // Strip ~ or home prefix so ~/.supabase and /home/foo/.supabase compare equal.
  n = n.replace(/^~\//, "");
  n = n.replace(/^\/home\/[^/]+\//, "");
  return n.toLowerCase();
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
