import type { SessionMemoryInput, SessionSnapshot, SessionWriter } from "../types.js";
import type { KomatikWriteClient } from "./client.js";

type MemoryType = SessionMemoryInput["memoryType"];

/**
 * Writes session lifecycle state to Supabase via the Komatik data layer.
 * Implements SessionWriter against the session_memories table (for memories)
 * and a session_snapshots JSON column pattern (stored as a memory with
 * type "active-work" and a snapshot context key).
 *
 * This is the production write-back path that makes memories created in
 * this session available to the next session via KomatikMemoryAdapter.
 */
export class KomatikSessionWriter implements SessionWriter {
  private readonly client: KomatikWriteClient;
  private readonly dedupLookback: number;

  constructor(client: KomatikWriteClient, options: { dedupLookback?: number } = {}) {
    this.client = client;
    this.dedupLookback = options.dedupLookback ?? 100;
  }

  async writeMemories(userId: string, memories: SessionMemoryInput[]): Promise<void> {
    if (memories.length === 0) return;

    const deduped = await this.dedupe(userId, memories);
    if (deduped.length === 0) return;

    const rows = deduped.map((m) => ({
      user_id: userId,
      memory_type: m.memoryType,
      content: m.content,
      context_key: m.contextKey,
      relevance_score: m.relevanceScore,
      expires_at: m.expiresAt,
    }));

    const { error } = await this.client.from("session_memories").upsert(rows);

    if (error) {
      throw new Error(`KomatikSessionWriter.writeMemories failed: ${error.message}`);
    }
  }

  private async dedupe(
    userId: string,
    memories: SessionMemoryInput[],
  ): Promise<SessionMemoryInput[]> {
    const seen = new Set<string>();
    const withinBatch: SessionMemoryInput[] = [];
    for (const m of memories) {
      const key = `${m.memoryType}::${normalize(m.content)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      withinBatch.push(m);
    }

    const types = new Set<MemoryType>(withinBatch.map((m) => m.memoryType));
    for (const type of types) {
      const existing = await this.fetchExistingNormalized(userId, type);
      if (!existing) continue;
      for (let i = withinBatch.length - 1; i >= 0; i--) {
        const m = withinBatch[i]!;
        if (m.memoryType !== type) continue;
        if (existing.has(normalize(m.content))) {
          withinBatch.splice(i, 1);
        }
      }
    }

    return withinBatch;
  }

  private async fetchExistingNormalized(
    userId: string,
    memoryType: MemoryType,
  ): Promise<Set<string> | null> {
    try {
      const { data, error } = await this.client
        .from("session_memories")
        .select("content")
        .eq("user_id", userId)
        .eq("memory_type", memoryType)
        .order("created_at", { ascending: false })
        .limit(this.dedupLookback);

      if (error || !data) return null;
      const rows = data as unknown as Array<{ content: string }>;
      return new Set(rows.map((r) => normalize(r.content)));
    } catch {
      return null;
    }
  }

  async writeSnapshot(snapshot: SessionSnapshot): Promise<void> {
    const row = {
      user_id: snapshot.state.sessionId,
      memory_type: "active-work" as const,
      content: JSON.stringify(snapshot),
      context_key: `snapshot:${snapshot.sessionId}`,
      relevance_score: 1.0,
      expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    };

    const { error } = await this.client.from("session_memories").upsert([row]);

    if (error) {
      throw new Error(`KomatikSessionWriter.writeSnapshot failed: ${error.message}`);
    }
  }

  async expireMemories(userId: string, contextKeys: string[]): Promise<void> {
    if (contextKeys.length === 0) return;

    const { error } = await this.client
      .from("session_memories")
      .update({ expires_at: new Date().toISOString() })
      .eq("user_id", userId)
      .in("context_key", contextKeys);

    if (error) {
      throw new Error(`KomatikSessionWriter.expireMemories failed: ${error.message}`);
    }
  }

  async getLatestSnapshot(userId: string): Promise<SessionSnapshot | null> {
    const { data, error } = await this.client
      .from("session_memories")
      .select("*")
      .eq("user_id", userId)
      .eq("memory_type", "active-work")
      .order("created_at", { ascending: false })
      .limit(20);

    if (error || !data) return null;

    const rows = data as unknown as Array<{
      content: string;
      context_key: string | null;
      expires_at: string | null;
    }>;

    for (const row of rows) {
      if (!row.context_key?.startsWith("snapshot:")) continue;
      if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) continue;

      try {
        return JSON.parse(row.content) as SessionSnapshot;
      } catch {
        continue;
      }
    }

    return null;
  }
}

function normalize(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}
