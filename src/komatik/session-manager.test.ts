import { describe, it, expect, vi } from "vitest";
import {
  SlipstreamSessionManager,
  TIER_WEIGHT_PRESETS,
  type SessionEvent,
} from "./session-manager.js";
import { createMockClient, createMockWriteClient } from "./testing.js";
import type { ModelCallerFn, ModelCallerOutput } from "../types.js";

const MODEL_ROSTER = [
  { provider: "anthropic", api_model_name: "claude-sonnet-4-6", status: "active", smoke_test_latency_ms: 220 },
  { provider: "openai", api_model_name: "gpt-5-mini", status: "active", smoke_test_latency_ms: 190 },
];

function makeCaller(): ModelCallerFn {
  return async ({ model, provider, enrichedSystemPrompt }): Promise<ModelCallerOutput> => ({
    content: `Simulated ${provider}/${model} response.`,
    model,
    provider,
    inputTokens: Math.ceil(enrichedSystemPrompt.length / 4),
    outputTokens: 32,
    latencyMs: 75,
  });
}

interface ManagerOptions {
  storedPrefs?: Record<string, unknown>[];
  managerOverrides?: Partial<Parameters<typeof SlipstreamSessionManager.prototype.constructor>[0]>;
}

function makeManager(opts: ManagerOptions = {}) {
  const client = createMockClient({
    model_availability: MODEL_ROSTER,
    llm_usage: [],
    enrichment_outcomes: [],
    user_preferences: opts.storedPrefs ?? [],
  });
  const { client: writeClient, writes } = createMockWriteClient({
    enrichment_outcomes: [],
    user_preferences: opts.storedPrefs ?? [],
  });
  return {
    manager: new SlipstreamSessionManager({
      client,
      writeClient,
      caller: makeCaller(),
      ...(opts.managerOverrides ?? {}),
    }),
    writes,
  };
}

describe("SlipstreamSessionManager", () => {
  describe("lifecycle", () => {
    it("starts and ends a session, returning a handle and ROI summary", async () => {
      const { manager } = makeManager();
      const handle = await manager.startSession({
        sessionId: "sess-1",
        scope: "project",
        user: { id: "user-1" },
      });

      expect(handle.sessionId).toBe("sess-1");
      expect(handle.scope).toBe("project");
      expect(handle.userId).toBe("user-1");
      expect(handle.tierBias).toBe("balanced");
      expect(manager.hasSession("sess-1")).toBe(true);

      const roi = await manager.endSession("sess-1");
      expect(roi.totalRequests).toBe(0);
      expect(manager.hasSession("sess-1")).toBe(false);
    });

    it("rejects starting the same session twice", async () => {
      const { manager } = makeManager();
      await manager.startSession({ sessionId: "sess-1", scope: "sandbox", user: { id: "u" } });
      await expect(
        manager.startSession({ sessionId: "sess-1", scope: "sandbox", user: { id: "u" } }),
      ).rejects.toThrow(/already started/);
    });

    it("throws when processing against an unknown session", async () => {
      const { manager } = makeManager();
      await expect(
        manager.process({ sessionId: "missing", message: "hi" }),
      ).rejects.toThrow(/no active session/);
    });
  });

  describe("tier bias → scoring weights", () => {
    it("uses the user's tierBias when provided", async () => {
      const { manager } = makeManager();
      const handle = await manager.startSession({
        sessionId: "sess-1",
        scope: "sandbox",
        user: { id: "u", tierBias: "premier" },
      });
      expect(handle.tierBias).toBe("premier");
    });

    it("falls back to defaultTierBias when user has none", async () => {
      const { manager } = makeManager({ managerOverrides: { defaultTierBias: "budget" } });
      const handle = await manager.startSession({
        sessionId: "sess-1",
        scope: "sandbox",
        user: { id: "u" },
      });
      expect(handle.tierBias).toBe("budget");
    });

    it("maps each tier to a distinct scoring weight preset", () => {
      expect(TIER_WEIGHT_PRESETS.budget.latency).toBeGreaterThan(TIER_WEIGHT_PRESETS.balanced.latency);
      expect(TIER_WEIGHT_PRESETS.premier.acceptanceRate).toBeGreaterThan(TIER_WEIGHT_PRESETS.balanced.acceptanceRate);
      expect(TIER_WEIGHT_PRESETS.budget.acceptanceRate).toBeLessThan(TIER_WEIGHT_PRESETS.balanced.acceptanceRate);
    });
  });

  describe("process()", () => {
    it("returns a request id, telemetry, drift gauge, and accumulates conversation", async () => {
      const { manager } = makeManager();
      await manager.startSession({ sessionId: "sess-1", scope: "project", user: { id: "u" } });

      const r1 = await manager.process({ sessionId: "sess-1", message: "fix the auth crash" });
      expect(r1.requestId).toBeTypeOf("string");
      expect(r1.modelResponse.provider).toBeTypeOf("string");
      expect(r1.telemetry.sourceApp).toBe("komatik-workbench");
      expect(r1.drift.totalEvents).toBe(0);

      // Manager tracks conversation internally — second call doesn't need it passed in.
      const r2 = await manager.process({ sessionId: "sess-1", message: "also add a regression test" });
      expect(r2.requestId).not.toBe(r1.requestId);
    });
  });

  describe("scope: project vs sandbox", () => {
    it("persists outcomes for project-scope sessions", async () => {
      const { manager, writes } = makeManager();
      await manager.startSession({ sessionId: "sess-1", scope: "project", user: { id: "u" } });
      const r = await manager.process({ sessionId: "sess-1", message: "ship the fix" });
      await manager.recordOutcome({
        sessionId: "sess-1",
        requestId: r.requestId,
        accepted: true,
      });

      expect(writes.enrichment_outcomes?.inserts).toHaveLength(1);
      expect(writes.enrichment_outcomes?.updates).toHaveLength(1);
    });

    it("does not persist outcomes for sandbox-scope sessions", async () => {
      const { manager, writes } = makeManager();
      await manager.startSession({ sessionId: "sess-1", scope: "sandbox", user: { id: "u" } });
      const r = await manager.process({ sessionId: "sess-1", message: "ship the fix" });
      await manager.recordOutcome({
        sessionId: "sess-1",
        requestId: r.requestId,
        accepted: true,
      });

      // Sandbox sessions skip the outcome writer entirely.
      expect(writes.enrichment_outcomes?.inserts ?? []).toHaveLength(0);
      expect(writes.enrichment_outcomes?.updates ?? []).toHaveLength(0);
    });
  });

  describe("observability events", () => {
    it("emits session-started, model-selected, outcome-recorded, session-ended", async () => {
      const events: SessionEvent[] = [];
      const { manager } = makeManager({ managerOverrides: { onSessionEvent: (e) => events.push(e) } });

      await manager.startSession({ sessionId: "sess-1", scope: "project", user: { id: "u" } });
      const r = await manager.process({ sessionId: "sess-1", message: "hello" });
      await manager.recordOutcome({ sessionId: "sess-1", requestId: r.requestId, accepted: true });
      await manager.endSession("sess-1");

      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain("session-started");
      expect(kinds).toContain("model-selected");
      expect(kinds).toContain("outcome-recorded");
      expect(kinds).toContain("session-ended");
    });

    it("emits drift-elevated when the drift gauge crosses threshold", async () => {
      const events: SessionEvent[] = [];
      const { manager } = makeManager({
        managerOverrides: {
          driftRefreshThreshold: 10,
          onSessionEvent: (e) => events.push(e),
        },
      });
      await manager.startSession({
        sessionId: "sess-1",
        scope: "sandbox",
        user: { id: "u" },
      });

      // First message seeds canonicals; subsequent messages drift via case variation
      // to push the drift gauge over the (low) threshold.
      await manager.process({ sessionId: "sess-1", message: "Slipstream pipeline is up." });
      await manager.process({ sessionId: "sess-1", message: "slipstream is misnamed here." });
      await manager.process({ sessionId: "sess-1", message: "slipstream stability check now." });

      const elevated = events.filter((e) => e.kind === "drift-elevated");
      expect(elevated.length).toBeGreaterThan(0);
    });
  });

  describe("stored tier_bias preference (piece 2)", () => {
    it("startSession uses the user's stored tier_bias when no override is passed", async () => {
      const { manager } = makeManager({
        storedPrefs: [
          { user_id: "u-1", undercurrent_settings: { tier_bias: "premier" } },
        ],
      });
      const handle = await manager.startSession({
        sessionId: "sess-1",
        scope: "project",
        user: { id: "u-1" },
      });
      expect(handle.tierBias).toBe("premier");
    });

    it("explicit override on startSession beats the stored preference", async () => {
      const { manager } = makeManager({
        storedPrefs: [
          { user_id: "u-1", undercurrent_settings: { tier_bias: "premier" } },
        ],
      });
      const handle = await manager.startSession({
        sessionId: "sess-1",
        scope: "project",
        user: { id: "u-1", tierBias: "budget" },
      });
      expect(handle.tierBias).toBe("budget");
    });

    it("falls back to defaultTierBias when neither override nor stored preference exists", async () => {
      const { manager } = makeManager({
        managerOverrides: { defaultTierBias: "premier" },
      });
      const handle = await manager.startSession({
        sessionId: "sess-1",
        scope: "sandbox",
        user: { id: "u-1" },
      });
      expect(handle.tierBias).toBe("premier");
    });

    it("setTierBias persists the choice and caches it for the next startSession", async () => {
      const { manager, writes } = makeManager();
      await manager.setTierBias("u-1", "budget");

      expect(writes.user_preferences?.upserts).toHaveLength(1);
      const upsert = writes.user_preferences!.upserts[0]!;
      expect(upsert.undercurrent_settings).toEqual({ tier_bias: "budget" });

      // Cache hit — next startSession reads the value without hitting the DB.
      const handle = await manager.startSession({
        sessionId: "sess-1",
        scope: "sandbox",
        user: { id: "u-1" },
      });
      expect(handle.tierBias).toBe("budget");
    });

    it("getStoredTierBias returns the cached value after setTierBias", async () => {
      const { manager } = makeManager();
      expect(await manager.getStoredTierBias("u-1")).toBeNull();
      await manager.setTierBias("u-1", "premier");
      expect(await manager.getStoredTierBias("u-1")).toBe("premier");
    });

    it("invalidateTierBiasCache forces the next read to hit the DB", async () => {
      const { manager } = makeManager({
        storedPrefs: [
          { user_id: "u-1", undercurrent_settings: { tier_bias: "premier" } },
        ],
      });
      await manager.getStoredTierBias("u-1");
      manager.invalidateTierBiasCache("u-1");
      // After invalidation, getStoredTierBias re-queries — value still resolves.
      expect(await manager.getStoredTierBias("u-1")).toBe("premier");
    });
  });

  describe("introspection", () => {
    it("getDriftGauge and getRoiSummary work on an active session", async () => {
      const { manager } = makeManager();
      await manager.startSession({ sessionId: "sess-1", scope: "sandbox", user: { id: "u" } });
      const r = await manager.process({ sessionId: "sess-1", message: "ok" });
      await manager.recordOutcome({ sessionId: "sess-1", requestId: r.requestId, accepted: true });

      const gauge = manager.getDriftGauge("sess-1");
      expect(gauge.level).toBeTypeOf("string");

      const roi = manager.getRoiSummary("sess-1");
      expect(roi.totalRequests).toBe(1);
      expect(roi.acceptanceRate).toBe(1);
    });
  });
});
