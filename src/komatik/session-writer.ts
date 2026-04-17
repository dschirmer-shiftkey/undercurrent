import type { SessionMemoryInput, SessionSnapshot, SessionWriter } from "../types.js";
import type { KomatikWriteClient } from "./client.js";

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

  constructor(client: KomatikWriteClient) {
    this.client = client;
  }

  async writeMemories(userId: string, memories: SessionMemoryInput[]): Promise<void> {
    if (memories.length === 0) return;

    const rows = memories.map((m) => ({
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
