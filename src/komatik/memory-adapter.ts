import type { AdapterInput, ContextAdapter, ContextLayer } from "../types.js";
import type { KomatikAdapterOptions, KomatikDataClient } from "./client.js";
import type { SessionMemory, MemoryType } from "./types.js";

/**
 * Queries session_memories for the authenticated user's persistent
 * cross-session context — decisions made, unresolved items, active work,
 * learned preferences, and past corrections.
 *
 * Unlike conversation history (which dies with the session), memories
 * persist and travel with the user. This is the "last session you were
 * working on X" capability.
 *
 * Priority 0 — foundational context alongside identity and preferences.
 */
export class KomatikMemoryAdapter implements ContextAdapter {
  readonly name = "komatik-memory";
  readonly priority = 0;

  private readonly client: KomatikDataClient;
  private readonly userId: string;
  private readonly maxMemories: number;

  constructor(options: KomatikAdapterOptions & { maxMemories?: number }) {
    this.client = options.client;
    this.userId = options.userId;
    this.maxMemories = options.maxMemories ?? 30;
  }

  async available(): Promise<boolean> {
    return Boolean(this.userId);
  }

  async gather(_input: AdapterInput): Promise<ContextLayer[]> {
    const { data, error } = await this.client
      .from("session_memories")
      .select("*")
      .eq("user_id", this.userId)
      .order("relevance_score", { ascending: false })
      .limit(this.maxMemories);

    if (error || !data || data.length === 0) {
      return [];
    }

    const memories = data as unknown as SessionMemory[];

    const now = Date.now();
    const active = memories.filter((m) => !m.expires_at || new Date(m.expires_at).getTime() > now);

    if (active.length === 0) {
      return [];
    }

    const byType = new Map<MemoryType, SessionMemory[]>();
    for (const m of active) {
      const list = byType.get(m.memory_type) ?? [];
      list.push(m);
      byType.set(m.memory_type, list);
    }

    const parts: string[] = [];

    const activeWork = byType.get("active-work");
    if (activeWork && activeWork.length > 0) {
      parts.push(`Active work: ${activeWork.map((m) => m.content).join("; ")}`);
    }

    const decisions = byType.get("decision");
    if (decisions && decisions.length > 0) {
      const topDecisions = decisions.slice(0, 3);
      parts.push(`Recent decisions: ${topDecisions.map((m) => m.content).join("; ")}`);
    }

    const unresolved = byType.get("unresolved");
    if (unresolved && unresolved.length > 0) {
      parts.push(`Unresolved: ${unresolved.map((m) => m.content).join("; ")}`);
    }

    const corrections = byType.get("correction");
    if (corrections && corrections.length > 0) {
      parts.push(`Past corrections: ${corrections.map((m) => m.content).join("; ")}`);
    }

    const learned = byType.get("preference-learned");
    if (learned && learned.length > 0) {
      parts.push(`Learned: ${learned.map((m) => m.content).join("; ")}`);
    }

    const summary =
      parts.length > 0
        ? `Session memory (${active.length} items): ${parts.join(". ")}`
        : `Session memory: ${active.length} items stored`;

    return [
      {
        source: this.name,
        priority: this.priority,
        timestamp: Date.now(),
        data: {
          memories: active,
          countByType: Object.fromEntries([...byType.entries()].map(([k, v]) => [k, v.length])),
        },
        summary,
      },
    ];
  }
}
