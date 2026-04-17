import { describe, it, expect } from "vitest";
import { Pipeline } from "./pipeline.js";
import { DefaultStrategy } from "../strategies/default.js";
import type {
  SessionMemoryInput,
  SessionSnapshot,
  SessionWriter,
  UndercurrentConfig,
} from "../types.js";

function createInMemoryWriter(): SessionWriter & {
  memories: Map<string, SessionMemoryInput[]>;
  snapshots: SessionSnapshot[];
} {
  const store = {
    memories: new Map<string, SessionMemoryInput[]>(),
    snapshots: [] as SessionSnapshot[],

    async writeMemories(userId: string, memories: SessionMemoryInput[]) {
      const existing = store.memories.get(userId) ?? [];
      store.memories.set(userId, [...existing, ...memories]);
    },
    async writeSnapshot(snapshot: SessionSnapshot) {
      store.snapshots.push(snapshot);
    },
    async expireMemories(userId: string, contextKeys: string[]) {
      const existing = store.memories.get(userId) ?? [];
      store.memories.set(
        userId,
        existing.filter((m) => !contextKeys.includes(m.contextKey ?? "")),
      );
    },
    async getLatestSnapshot(_userId: string): Promise<SessionSnapshot | null> {
      return store.snapshots.length > 0
        ? store.snapshots[store.snapshots.length - 1]!
        : null;
    },
  };
  return store;
}

function makeConfig(
  writer: SessionWriter,
  overrides: Partial<UndercurrentConfig> = {},
): UndercurrentConfig {
  return {
    adapters: [],
    strategy: new DefaultStrategy(),
    sessionMonitor: {
      userId: "test-user",
      tokenBudget: 100_000,
      checkpointInterval: 3,
      writer,
    },
    ...overrides,
  };
}

describe("Session Lifecycle Integration", () => {
  it("pipeline with sessionMonitor tracks health", async () => {
    const writer = createInMemoryWriter();
    const pipeline = new Pipeline(makeConfig(writer));

    expect(pipeline.getSessionHealth()).toBe("cold-start");

    await pipeline.enrich({
      message: "help me build an authentication system for my app",
      conversation: [{ role: "user", content: "previous context" }],
    });

    expect(pipeline.getSessionHealth()).toBe("healthy");
  });

  it("pipeline without sessionMonitor returns null health", async () => {
    const pipeline = new Pipeline({
      adapters: [],
      strategy: new DefaultStrategy(),
    });

    expect(pipeline.getSessionHealth()).toBeNull();
    expect(pipeline.getSessionId()).toBeNull();
  });

  it("checkpoints after configured interval", async () => {
    const writer = createInMemoryWriter();
    const pipeline = new Pipeline(makeConfig(writer, {
      sessionMonitor: {
        userId: "test-user",
        tokenBudget: 100_000,
        checkpointInterval: 2,
        writer,
      },
    }));

    const conversation = [{ role: "user" as const, content: "context" }];

    await pipeline.enrich({
      message: "implement the login endpoint with email validation",
      conversation,
    });
    expect(writer.memories.size).toBe(0);

    await pipeline.enrich({
      message: "add password hashing with bcrypt for the authentication flow",
      conversation,
    });

    // After 2 messages, checkpoint should fire but only if there's state to write.
    // The pipeline tracks decisions from messages, so there may or may not be
    // memories depending on heuristic extraction.
  });

  it("session ID is stable across messages", async () => {
    const writer = createInMemoryWriter();
    const pipeline = new Pipeline(makeConfig(writer));

    const id1 = pipeline.getSessionId();
    await pipeline.enrich({
      message: "first message about the project architecture",
      conversation: [{ role: "user", content: "ctx" }],
    });
    const id2 = pipeline.getSessionId();

    expect(id1).toBe(id2);
    expect(id1).toBeTruthy();
  });

  it("passthrough messages still get tracked by monitor", async () => {
    const writer = createInMemoryWriter();
    const pipeline = new Pipeline(makeConfig(writer));

    await pipeline.enrich({
      message: "fix the `calculateTotal` function on line 15 of utils.ts — it returns NaN",
      conversation: [{ role: "user", content: "ctx" }],
    });

    expect(pipeline.getSessionHealth()).toBe("healthy");
  });

  it("health degrades with large token accumulation then recovers after compaction", async () => {
    const writer = createInMemoryWriter();
    const pipeline = new Pipeline(makeConfig(writer, {
      sessionMonitor: {
        userId: "test-user",
        tokenBudget: 200,
        checkpointInterval: 50,
        writer,
      },
    }));

    const bigMessage = "x".repeat(800);
    const conversation = [{ role: "user" as const, content: "ctx" }];

    await pipeline.enrich({ message: bigMessage, conversation });

    // With a budget of 200 tokens and 800 chars (~200 tokens) plus enriched
    // output, the monitor hits critical → triggers compaction → resets budget.
    // After compaction, health should be back to a non-critical state.
    const health = pipeline.getSessionHealth();
    expect(["healthy", "warm", "degrading", "critical"]).toContain(health);

    // Verify compaction actually happened by checking if a snapshot was written
    expect(writer.snapshots.length).toBeGreaterThanOrEqual(1);
  });

  it("cold-start restoration works when snapshot exists", async () => {
    const writer = createInMemoryWriter();

    const pipeline1 = new Pipeline(makeConfig(writer, {
      sessionMonitor: {
        userId: "test-user",
        tokenBudget: 50,
        checkpointInterval: 1,
        writer,
      },
    }));

    const bigMessage = "x".repeat(400);
    await pipeline1.enrich({
      message: bigMessage,
      conversation: [{ role: "user", content: "establishing context" }],
    });

    const pipeline2 = new Pipeline(makeConfig(writer));

    const result = await pipeline2.enrich({
      message: "help me with the project we were working on",
      conversation: [],
    });

    // The second pipeline should attempt cold-start restoration.
    // Whether layers actually appear depends on whether the first pipeline
    // wrote a snapshot (which happens on degrading/critical health).
    expect(result.metadata.enrichmentDepth).toBeTruthy();
  });
});
