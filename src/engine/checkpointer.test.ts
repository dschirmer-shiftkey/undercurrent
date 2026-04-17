import { describe, it, expect, vi } from "vitest";
import { Checkpointer } from "./checkpointer.js";
import { Compactor } from "./compactor.js";
import { SessionMonitor } from "./session-monitor.js";
import type {
  ConversationTurn,
  ContextLayer,
  SessionMemoryInput,
  SessionSnapshot,
  SessionWriter,
} from "../types.js";

function createMockWriter(): SessionWriter & {
  writtenMemories: Array<{ userId: string; memories: SessionMemoryInput[] }>;
  writtenSnapshots: SessionSnapshot[];
  expiredKeys: Array<{ userId: string; keys: string[] }>;
  storedSnapshot: SessionSnapshot | null;
} {
  const mock = {
    writtenMemories: [] as Array<{ userId: string; memories: SessionMemoryInput[] }>,
    writtenSnapshots: [] as SessionSnapshot[],
    expiredKeys: [] as Array<{ userId: string; keys: string[] }>,
    storedSnapshot: null as SessionSnapshot | null,

    async writeMemories(userId: string, memories: SessionMemoryInput[]) {
      mock.writtenMemories.push({ userId, memories });
    },
    async writeSnapshot(snapshot: SessionSnapshot) {
      mock.writtenSnapshots.push(snapshot);
      mock.storedSnapshot = snapshot;
    },
    async expireMemories(userId: string, contextKeys: string[]) {
      mock.expiredKeys.push({ userId, keys: contextKeys });
    },
    async getLatestSnapshot(_userId: string): Promise<SessionSnapshot | null> {
      return mock.storedSnapshot;
    },
  };
  return mock;
}

function makeConversation(count: number): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (let i = 0; i < count; i++) {
    turns.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i} about building the authentication system`,
    });
  }
  return turns;
}

function makeContextLayers(): ContextLayer[] {
  return [
    {
      source: "test-adapter",
      priority: 1,
      timestamp: Date.now(),
      data: { branch: "feature/auth" },
      summary: "On feature/auth branch",
    },
  ];
}

describe("Checkpointer", () => {
  describe("checkpoint", () => {
    it("writes memories from session state", async () => {
      const writer = createMockWriter();
      const compactor = new Compactor();
      const checkpointer = new Checkpointer({
        writer,
        compactor,
        userId: "user-123",
      });

      const monitor = new SessionMonitor({ tokenBudget: 100_000 });
      monitor.setActiveWork(["implement login"]);
      monitor.addDecision("Use JWT tokens");
      monitor.addUnresolved("token refresh bug");
      monitor.track("test", [{ role: "user", content: "test" }]);

      await checkpointer.checkpoint(monitor, makeConversation(5));

      expect(writer.writtenMemories.length).toBe(1);
      const { userId, memories } = writer.writtenMemories[0]!;
      expect(userId).toBe("user-123");
      expect(memories.length).toBeGreaterThan(0);

      const types = memories.map((m) => m.memoryType);
      expect(types).toContain("active-work");
      expect(types).toContain("decision");
      expect(types).toContain("unresolved");
    });

    it("marks checkpoint on monitor after writing", async () => {
      const writer = createMockWriter();
      const compactor = new Compactor();
      const checkpointer = new Checkpointer({
        writer,
        compactor,
        userId: "user-123",
      });

      const monitor = new SessionMonitor({ checkpointInterval: 2 });
      monitor.setActiveWork(["task"]);
      monitor.track("one", [{ role: "user", content: "one" }]);
      monitor.track("two", [{ role: "user", content: "two" }]);
      expect(monitor.needsCheckpoint()).toBe(true);

      await checkpointer.checkpoint(monitor, []);
      expect(monitor.needsCheckpoint()).toBe(false);
    });

    it("does not write when state has no items", async () => {
      const writer = createMockWriter();
      const compactor = new Compactor();
      const checkpointer = new Checkpointer({
        writer,
        compactor,
        userId: "user-123",
      });

      const monitor = new SessionMonitor();

      await checkpointer.checkpoint(monitor, []);
      expect(writer.writtenMemories.length).toBe(0);
    });

    it("handles writer failure gracefully", async () => {
      const writer = createMockWriter();
      writer.writeMemories = vi.fn().mockRejectedValue(new Error("DB down"));
      const compactor = new Compactor();
      const checkpointer = new Checkpointer({
        writer,
        compactor,
        userId: "user-123",
      });

      const monitor = new SessionMonitor();
      monitor.setActiveWork(["task"]);
      monitor.track("test", [{ role: "user", content: "test" }]);

      await expect(checkpointer.checkpoint(monitor, [])).resolves.toBeUndefined();
    });
  });

  describe("compactAndCheckpoint", () => {
    it("produces compaction result and writes snapshot", async () => {
      const writer = createMockWriter();
      const compactor = new Compactor();
      const checkpointer = new Checkpointer({
        writer,
        compactor,
        userId: "user-123",
      });

      const monitor = new SessionMonitor({ tokenBudget: 100_000 });
      monitor.setActiveWork(["build API"]);
      monitor.addDecision("Use REST");
      for (let i = 0; i < 5; i++) {
        monitor.track(`message ${i}`, [{ role: "user", content: `msg ${i}` }]);
      }

      const result = await checkpointer.compactAndCheckpoint(
        monitor,
        makeConversation(20),
        makeContextLayers(),
      );

      expect(result.summary).toBeTruthy();
      expect(result.decisions.length).toBeGreaterThan(0);
      expect(writer.writtenSnapshots.length).toBe(1);
      expect(writer.writtenMemories.length).toBeGreaterThan(0);
    });
  });

  describe("produceHandoff", () => {
    it("creates a HandoffArtifact with all session data", async () => {
      const writer = createMockWriter();
      const compactor = new Compactor();
      const checkpointer = new Checkpointer({
        writer,
        compactor,
        userId: "user-123",
      });

      const monitor = new SessionMonitor();
      monitor.setActiveWork(["finish auth"]);
      monitor.addDecision("Use bcrypt for passwords");
      monitor.addUnresolved("rate limiting strategy");
      monitor.track("test", [{ role: "user", content: "test" }]);

      const handoff = await checkpointer.produceHandoff(
        monitor,
        makeConversation(10),
        makeContextLayers(),
      );

      expect(handoff.sessionId).toBe(monitor.getSessionId());
      expect(handoff.activeWork.length).toBeGreaterThan(0);
      expect(handoff.decisions.length).toBeGreaterThan(0);
      expect(handoff.unresolvedItems.length).toBeGreaterThan(0);
      expect(handoff.contextLayers.length).toBe(1);
      expect(handoff.summary).toBeTruthy();
    });

    it("writes both snapshot and memories", async () => {
      const writer = createMockWriter();
      const compactor = new Compactor();
      const checkpointer = new Checkpointer({
        writer,
        compactor,
        userId: "user-123",
      });

      const monitor = new SessionMonitor();
      monitor.setActiveWork(["task"]);
      monitor.track("test", [{ role: "user", content: "test" }]);

      await checkpointer.produceHandoff(monitor, makeConversation(5), makeContextLayers());

      expect(writer.writtenSnapshots.length).toBe(1);
      expect(writer.writtenSnapshots[0]!.handoff).not.toBeNull();
      expect(writer.writtenMemories.length).toBeGreaterThan(0);
    });
  });

  describe("restoreFromSnapshot", () => {
    it("returns empty when no snapshot exists", async () => {
      const writer = createMockWriter();
      const compactor = new Compactor();
      const checkpointer = new Checkpointer({
        writer,
        compactor,
        userId: "user-123",
      });

      const layers = await checkpointer.restoreFromSnapshot();
      expect(layers).toEqual([]);
    });

    it("restores context layers from a stored handoff", async () => {
      const writer = createMockWriter();
      const compactor = new Compactor();
      const checkpointer = new Checkpointer({
        writer,
        compactor,
        userId: "user-123",
      });

      const monitor = new SessionMonitor();
      monitor.setActiveWork(["finish API"]);
      monitor.addDecision("Use REST");
      monitor.addUnresolved("pagination");
      monitor.track("test", [{ role: "user", content: "test" }]);

      await checkpointer.produceHandoff(monitor, makeConversation(5), makeContextLayers());

      const layers = await checkpointer.restoreFromSnapshot();
      expect(layers.length).toBe(1);
      expect(layers[0]!.source).toBe("session-handoff");
      expect(layers[0]!.summary).toContain("Active work");
    });

    it("handles writer failure during restore gracefully", async () => {
      const writer = createMockWriter();
      writer.getLatestSnapshot = vi.fn().mockRejectedValue(new Error("DB down"));
      const compactor = new Compactor();
      const checkpointer = new Checkpointer({
        writer,
        compactor,
        userId: "user-123",
      });

      const layers = await checkpointer.restoreFromSnapshot();
      expect(layers).toEqual([]);
    });
  });
});
