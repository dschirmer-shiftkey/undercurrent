import { describe, it, expect, vi } from "vitest";
import { KomatikSessionWriter } from "./session-writer.js";
import type { KomatikWriteClient } from "./client.js";
import type { SessionMemoryInput, SessionSnapshot, SessionState } from "../types.js";

function createMockWriteClient(
  overrides: {
    upsertError?: { message: string };
    updateError?: { message: string };
    selectData?: unknown[];
    selectError?: { message: string };
  } = {},
): KomatikWriteClient {
  const chainable = {
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    select: vi.fn().mockImplementation(() => ({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue({
              data: overrides.selectData ?? [],
              error: overrides.selectError ?? null,
            }),
          }),
        }),
      }),
    })),
    upsert: vi.fn().mockResolvedValue({
      error: overrides.upsertError ?? null,
    }),
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        in: vi.fn().mockResolvedValue({
          error: overrides.updateError ?? null,
        }),
      }),
    }),
  };

  return {
    from: vi.fn().mockReturnValue(chainable),
  } as unknown as KomatikWriteClient;
}

function makeMemoryInput(overrides: Partial<SessionMemoryInput> = {}): SessionMemoryInput {
  return {
    memoryType: "decision",
    content: "Chose PostgreSQL over MySQL",
    contextKey: "db-choice",
    relevanceScore: 0.9,
    expiresAt: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

function makeSnapshot(): SessionSnapshot {
  return {
    sessionId: "session-123",
    timestamp: Date.now(),
    state: {
      sessionId: "user-1",
      messageCount: 10,
      estimatedTokens: 5000,
      startedAt: Date.now() - 3600000,
      lastMessageAt: Date.now(),
      health: "healthy",
      topicDriftScore: 0.2,
    } as SessionState,
    compactionResult: null,
  };
}

describe("KomatikSessionWriter", () => {
  describe("writeMemories", () => {
    it("is a no-op for empty memories array", async () => {
      const client = createMockWriteClient();
      const writer = new KomatikSessionWriter(client);

      await writer.writeMemories("user-1", []);
      expect(client.from).not.toHaveBeenCalled();
    });

    it("upserts correct row shape", async () => {
      const client = createMockWriteClient();
      const writer = new KomatikSessionWriter(client);
      const memory = makeMemoryInput();

      await writer.writeMemories("user-1", [memory]);

      expect(client.from).toHaveBeenCalledWith("session_memories");
      const fromResult = (client.from as ReturnType<typeof vi.fn>).mock.results[0]!.value;
      expect(fromResult.upsert).toHaveBeenCalledWith([
        {
          user_id: "user-1",
          memory_type: "decision",
          content: "Chose PostgreSQL over MySQL",
          context_key: "db-choice",
          relevance_score: 0.9,
          expires_at: "2026-05-01T00:00:00Z",
        },
      ]);
    });

    it("throws on client error", async () => {
      const client = createMockWriteClient({
        upsertError: { message: "connection failed" },
      });
      const writer = new KomatikSessionWriter(client);

      await expect(writer.writeMemories("user-1", [makeMemoryInput()])).rejects.toThrow(
        "KomatikSessionWriter.writeMemories failed: connection failed",
      );
    });

    it("writes multiple memories in a single upsert", async () => {
      const client = createMockWriteClient();
      const writer = new KomatikSessionWriter(client);

      await writer.writeMemories("user-1", [
        makeMemoryInput({ contextKey: "key-1" }),
        makeMemoryInput({ contextKey: "key-2", memoryType: "active-work" }),
      ]);

      const fromResult = (client.from as ReturnType<typeof vi.fn>).mock.results[0]!.value;
      const upsertArg = fromResult.upsert.mock.calls[0]![0] as unknown[];
      expect(upsertArg).toHaveLength(2);
    });
  });

  describe("writeSnapshot", () => {
    it("serializes snapshot to JSON with correct metadata", async () => {
      const client = createMockWriteClient();
      const writer = new KomatikSessionWriter(client);
      const snapshot = makeSnapshot();

      await writer.writeSnapshot(snapshot);

      expect(client.from).toHaveBeenCalledWith("session_memories");
      const fromResult = (client.from as ReturnType<typeof vi.fn>).mock.results[0]!.value;
      const row = fromResult.upsert.mock.calls[0]![0][0] as {
        user_id: string;
        memory_type: string;
        content: string;
        context_key: string;
        relevance_score: number;
        expires_at: string;
      };

      expect(row.memory_type).toBe("active-work");
      expect(row.context_key).toBe("snapshot:session-123");
      expect(row.relevance_score).toBe(1.0);
      expect(JSON.parse(row.content)).toEqual(snapshot);

      const expiresAt = new Date(row.expires_at);
      const hoursDiff = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);
      expect(hoursDiff).toBeGreaterThan(46);
      expect(hoursDiff).toBeLessThan(50);
    });

    it("throws on client error", async () => {
      const client = createMockWriteClient({
        upsertError: { message: "write failed" },
      });
      const writer = new KomatikSessionWriter(client);

      await expect(writer.writeSnapshot(makeSnapshot())).rejects.toThrow(
        "KomatikSessionWriter.writeSnapshot failed: write failed",
      );
    });
  });

  describe("expireMemories", () => {
    it("is a no-op for empty context keys", async () => {
      const client = createMockWriteClient();
      const writer = new KomatikSessionWriter(client);

      await writer.expireMemories("user-1", []);
      expect(client.from).not.toHaveBeenCalled();
    });

    it("sets expires_at to now for given keys", async () => {
      const client = createMockWriteClient();
      const writer = new KomatikSessionWriter(client);

      const before = Date.now();
      await writer.expireMemories("user-1", ["key-1", "key-2"]);
      const after = Date.now();

      expect(client.from).toHaveBeenCalledWith("session_memories");
      const fromResult = (client.from as ReturnType<typeof vi.fn>).mock.results[0]!.value;
      const updateArg = fromResult.update.mock.calls[0]![0] as { expires_at: string };
      const expiresAt = new Date(updateArg.expires_at).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before);
      expect(expiresAt).toBeLessThanOrEqual(after);
    });

    it("throws on client error", async () => {
      const client = createMockWriteClient({
        updateError: { message: "expire failed" },
      });
      const writer = new KomatikSessionWriter(client);

      await expect(writer.expireMemories("user-1", ["key-1"])).rejects.toThrow(
        "KomatikSessionWriter.expireMemories failed: expire failed",
      );
    });
  });

  describe("getLatestSnapshot", () => {
    it("returns null when no data", async () => {
      const client = createMockWriteClient({ selectData: [] });
      const writer = new KomatikSessionWriter(client);

      const result = await writer.getLatestSnapshot("user-1");
      expect(result).toBeNull();
    });

    it("returns null on query error", async () => {
      const client = createMockWriteClient({
        selectError: { message: "query failed" },
      });
      const writer = new KomatikSessionWriter(client);

      const result = await writer.getLatestSnapshot("user-1");
      expect(result).toBeNull();
    });

    it("returns parsed snapshot from valid row", async () => {
      const snapshot = makeSnapshot();
      const client = createMockWriteClient({
        selectData: [
          {
            content: JSON.stringify(snapshot),
            context_key: "snapshot:session-123",
            expires_at: new Date(Date.now() + 86400000).toISOString(),
          },
        ],
      });
      const writer = new KomatikSessionWriter(client);

      const result = await writer.getLatestSnapshot("user-1");
      expect(result).toEqual(snapshot);
    });

    it("skips expired snapshots", async () => {
      const snapshot = makeSnapshot();
      const client = createMockWriteClient({
        selectData: [
          {
            content: JSON.stringify(snapshot),
            context_key: "snapshot:session-123",
            expires_at: new Date(Date.now() - 86400000).toISOString(),
          },
        ],
      });
      const writer = new KomatikSessionWriter(client);

      const result = await writer.getLatestSnapshot("user-1");
      expect(result).toBeNull();
    });

    it("skips rows without snapshot: prefix", async () => {
      const client = createMockWriteClient({
        selectData: [
          {
            content: "not a snapshot",
            context_key: "decision:some-key",
            expires_at: null,
          },
        ],
      });
      const writer = new KomatikSessionWriter(client);

      const result = await writer.getLatestSnapshot("user-1");
      expect(result).toBeNull();
    });

    it("skips rows with invalid JSON and tries next", async () => {
      const snapshot = makeSnapshot();
      const client = createMockWriteClient({
        selectData: [
          {
            content: "not valid json {{{",
            context_key: "snapshot:bad",
            expires_at: null,
          },
          {
            content: JSON.stringify(snapshot),
            context_key: "snapshot:good",
            expires_at: null,
          },
        ],
      });
      const writer = new KomatikSessionWriter(client);

      const result = await writer.getLatestSnapshot("user-1");
      expect(result).toEqual(snapshot);
    });
  });
});
