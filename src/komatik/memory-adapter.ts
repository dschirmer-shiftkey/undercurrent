import type { AdapterInput, ContextAdapter, ContextLayer } from "../types.js";
import { estimateTokens } from "../engine/session-monitor.js";
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
  private readonly maxRestoreTokens: number;
  private readonly model: string | undefined;

  constructor(
    options: KomatikAdapterOptions & {
      maxMemories?: number;
      /** Total token cap on the restored summary across all memory types. Default 800. */
      maxRestoreTokens?: number;
      /** Model identifier — passed through to estimateTokens for accurate budgeting. */
      model?: string;
    },
  ) {
    this.client = options.client;
    this.userId = options.userId;
    this.maxMemories = options.maxMemories ?? 30;
    this.maxRestoreTokens = options.maxRestoreTokens ?? 800;
    this.model = options.model;
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

    const sections: Array<{ label: string; items: SessionMemory[]; cap: number }> = [
      { label: "Active work", items: byType.get("active-work") ?? [], cap: 5 },
      { label: "Recent decisions", items: byType.get("decision") ?? [], cap: 3 },
      { label: "Unresolved", items: byType.get("unresolved") ?? [], cap: 5 },
      { label: "Past corrections", items: byType.get("correction") ?? [], cap: 3 },
      { label: "Learned", items: byType.get("preference-learned") ?? [], cap: 3 },
    ];

    const parts: string[] = [];
    let tokensUsed = 0;
    let truncated = false;
    for (const { label, items, cap } of sections) {
      if (items.length === 0) continue;
      // Items arrived ordered by relevance_score desc; cap and budget here.
      const included: string[] = [];
      for (const m of items.slice(0, cap)) {
        const candidate = m.content;
        const tokens = estimateTokens(`; ${candidate}`, this.model);
        if (tokensUsed + tokens > this.maxRestoreTokens) {
          truncated = true;
          break;
        }
        included.push(candidate);
        tokensUsed += tokens;
      }
      if (included.length > 0) {
        parts.push(`${label}: ${included.join("; ")}`);
      }
      if (truncated) break;
    }

    const summary =
      parts.length > 0
        ? `Session memory (${active.length} items): ${parts.join(". ")}${truncated ? " [truncated]" : ""}`
        : `Session memory: ${active.length} items stored`;

    return [
      {
        source: this.name,
        priority: this.priority,
        timestamp: Date.now(),
        data: {
          memories: active,
          countByType: Object.fromEntries([...byType.entries()].map(([k, v]) => [k, v.length])),
          estimatedTokens: tokensUsed,
          truncated,
        },
        summary,
      },
    ];
  }
}
