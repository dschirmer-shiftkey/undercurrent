import { describe, it, expect } from "vitest";
import { KomatikMemoryAdapter } from "./memory-adapter.js";
import { createMockClient } from "./testing.js";
import type { AdapterInput, IntentSignal } from "../types.js";

const stubIntent: IntentSignal = {
  action: "explore",
  specificity: "low",
  scope: "local",
  emotionalLoad: "neutral",
  confidence: 0.5,
  rawFragments: [],
  domainHints: [],
};

const stubInput: AdapterInput = {
  message: "continue working",
  intent: stubIntent,
  conversation: [],
  existingContext: [],
};

const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const pastDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

describe("KomatikMemoryAdapter", () => {
  it("returns grouped memories for a user with session history", async () => {
    const client = createMockClient({
      session_memories: [
        {
          id: "mem-1",
          user_id: "user-1",
          memory_type: "active-work",
          content: "Refactoring auth middleware in Komatik monorepo",
          context_key: "komatik/auth",
          relevance_score: 0.95,
          expires_at: futureDate,
          created_at: "2026-04-15T10:00:00Z",
          updated_at: "2026-04-15T10:00:00Z",
        },
        {
          id: "mem-2",
          user_id: "user-1",
          memory_type: "decision",
          content: "Chose JWT over sessions for stateless auth",
          context_key: "komatik/auth",
          relevance_score: 0.85,
          expires_at: null,
          created_at: "2026-04-14T18:00:00Z",
          updated_at: "2026-04-14T18:00:00Z",
        },
        {
          id: "mem-3",
          user_id: "user-1",
          memory_type: "unresolved",
          content: "Token refresh flow not yet implemented",
          context_key: "komatik/auth",
          relevance_score: 0.80,
          expires_at: futureDate,
          created_at: "2026-04-14T20:00:00Z",
          updated_at: "2026-04-14T20:00:00Z",
        },
        {
          id: "mem-4",
          user_id: "user-1",
          memory_type: "correction",
          content: "User prefers async/await over .then() chains",
          context_key: null,
          relevance_score: 0.70,
          expires_at: null,
          created_at: "2026-04-13T10:00:00Z",
          updated_at: "2026-04-13T10:00:00Z",
        },
        {
          id: "mem-5",
          user_id: "user-1",
          memory_type: "preference-learned",
          content: "Likes terse responses with code examples first",
          context_key: null,
          relevance_score: 0.65,
          expires_at: null,
          created_at: "2026-04-12T10:00:00Z",
          updated_at: "2026-04-12T10:00:00Z",
        },
      ],
    });

    const adapter = new KomatikMemoryAdapter({ client, userId: "user-1" });
    expect(await adapter.available()).toBe(true);

    const layers = await adapter.gather(stubInput);
    expect(layers).toHaveLength(1);

    const layer = layers[0]!;
    expect(layer.source).toBe("komatik-memory");
    expect(layer.summary).toContain("5 items");
    expect(layer.summary).toContain("Refactoring auth middleware");
    expect(layer.summary).toContain("Chose JWT over sessions");
    expect(layer.summary).toContain("Token refresh flow not yet implemented");
    expect(layer.summary).toContain("async/await over .then()");
    expect(layer.summary).toContain("terse responses");

    const countByType = (layer.data as { countByType: Record<string, number> }).countByType;
    expect(countByType["active-work"]).toBe(1);
    expect(countByType["decision"]).toBe(1);
    expect(countByType["unresolved"]).toBe(1);
    expect(countByType["correction"]).toBe(1);
    expect(countByType["preference-learned"]).toBe(1);
  });

  it("filters out expired memories", async () => {
    const client = createMockClient({
      session_memories: [
        {
          id: "mem-1",
          user_id: "user-2",
          memory_type: "active-work",
          content: "Working on dashboard",
          context_key: null,
          relevance_score: 0.9,
          expires_at: futureDate,
          created_at: "2026-04-15T10:00:00Z",
          updated_at: "2026-04-15T10:00:00Z",
        },
        {
          id: "mem-2",
          user_id: "user-2",
          memory_type: "active-work",
          content: "Old expired task",
          context_key: null,
          relevance_score: 0.8,
          expires_at: pastDate,
          created_at: "2026-04-01T10:00:00Z",
          updated_at: "2026-04-01T10:00:00Z",
        },
      ],
    });

    const adapter = new KomatikMemoryAdapter({ client, userId: "user-2" });
    const layers = await adapter.gather(stubInput);

    expect(layers).toHaveLength(1);
    expect(layers[0]!.summary).toContain("1 items");
    expect(layers[0]!.summary).toContain("Working on dashboard");
    expect(layers[0]!.summary).not.toContain("Old expired task");
  });

  it("returns empty layers when no memories exist", async () => {
    const client = createMockClient({ session_memories: [] });
    const adapter = new KomatikMemoryAdapter({
      client,
      userId: "fresh-user",
    });

    const layers = await adapter.gather(stubInput);
    expect(layers).toHaveLength(0);
  });

  it("returns empty when all memories are expired", async () => {
    const client = createMockClient({
      session_memories: [
        {
          id: "mem-1",
          user_id: "user-3",
          memory_type: "decision",
          content: "Old decision",
          context_key: null,
          relevance_score: 0.9,
          expires_at: pastDate,
          created_at: "2026-04-01T10:00:00Z",
          updated_at: "2026-04-01T10:00:00Z",
        },
      ],
    });

    const adapter = new KomatikMemoryAdapter({ client, userId: "user-3" });
    const layers = await adapter.gather(stubInput);
    expect(layers).toHaveLength(0);
  });

  it("reports unavailable when userId is empty", async () => {
    const client = createMockClient({});
    const adapter = new KomatikMemoryAdapter({ client, userId: "" });
    expect(await adapter.available()).toBe(false);
  });
});
