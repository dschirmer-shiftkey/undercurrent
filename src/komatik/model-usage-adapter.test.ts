import { describe, it, expect } from "vitest";
import { KomatikModelUsageAdapter } from "./model-usage-adapter.js";
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
  message: "test message",
  intent: stubIntent,
  conversation: [],
  existingContext: [],
};

describe("KomatikModelUsageAdapter", () => {
  it("has correct name and priority", () => {
    const client = createMockClient({});
    const adapter = new KomatikModelUsageAdapter({
      client,
      userId: "user-1",
    });
    expect(adapter.name).toBe("komatik-model-usage");
    expect(adapter.priority).toBe(5);
  });

  it("always reports available", async () => {
    const client = createMockClient({});
    const adapter = new KomatikModelUsageAdapter({
      client,
      userId: "user-1",
    });
    expect(await adapter.available()).toBe(true);
  });

  it("returns empty layers when no models available", async () => {
    const client = createMockClient({
      model_availability: [],
    });
    const adapter = new KomatikModelUsageAdapter({
      client,
      userId: "user-1",
    });
    const layers = await adapter.gather(stubInput);
    expect(layers).toEqual([]);
  });

  it("returns context layer with scoring data", async () => {
    const client = createMockClient({
      model_availability: [
        {
          provider: "anthropic",
          api_model_name: "claude-sonnet-4-20250514",
          status: "active",
          smoke_test_latency_ms: 450,
        },
        {
          provider: "openai",
          api_model_name: "gpt-4o",
          status: "active",
          smoke_test_latency_ms: 300,
        },
      ],
    });
    const adapter = new KomatikModelUsageAdapter({
      client,
      userId: "user-1",
    });
    const layers = await adapter.gather(stubInput);

    expect(layers).toHaveLength(1);
    expect(layers[0]!.source).toBe("komatik-model-usage");
    expect(layers[0]!.summary).toContain("2 active models");
  });

  describe("loadAvailableModels", () => {
    it("filters by active status and maps fields correctly", async () => {
      const client = createMockClient({
        model_availability: [
          {
            provider: "anthropic",
            api_model_name: "claude-sonnet-4-20250514",
            status: "active",
            smoke_test_latency_ms: 450,
          },
          {
            provider: "openai",
            api_model_name: "gpt-4o",
            status: "active",
            smoke_test_latency_ms: null,
          },
        ],
      });
      const adapter = new KomatikModelUsageAdapter({
        client,
        userId: "user-1",
      });
      const models = await adapter.loadAvailableModels();

      expect(models).toHaveLength(2);
      expect(models[0]!.provider).toBe("anthropic");
      expect(models[0]!.model).toBe("claude-sonnet-4-20250514");
      expect(models[0]!.smokeTestLatencyMs).toBe(450);
      expect(models[1]!.smokeTestLatencyMs).toBeNull();
    });

    it("returns empty array on error", async () => {
      const client = createMockClient({});
      const adapter = new KomatikModelUsageAdapter({
        client,
        userId: "user-1",
      });
      const models = await adapter.loadAvailableModels();
      expect(models).toEqual([]);
    });
  });

  describe("loadUsageStats", () => {
    it("aggregates success rate and latency per model", async () => {
      const client = createMockClient({
        llm_usage: [
          {
            model: "claude-sonnet-4-20250514",
            provider: "anthropic",
            success: true,
            latency_ms: 400,
            user_id: "user-1",
            created_at: "2026-04-17T10:00:00Z",
          },
          {
            model: "claude-sonnet-4-20250514",
            provider: "anthropic",
            success: true,
            latency_ms: 600,
            user_id: "user-1",
            created_at: "2026-04-17T09:00:00Z",
          },
          {
            model: "claude-sonnet-4-20250514",
            provider: "anthropic",
            success: false,
            latency_ms: 200,
            user_id: "user-1",
            created_at: "2026-04-17T08:00:00Z",
          },
          {
            model: "gpt-4o",
            provider: "openai",
            success: true,
            latency_ms: 300,
            user_id: "user-1",
            created_at: "2026-04-17T07:00:00Z",
          },
        ],
      });
      const adapter = new KomatikModelUsageAdapter({
        client,
        userId: "user-1",
      });
      const stats = await adapter.loadUsageStats();

      expect(stats.size).toBe(2);

      const claudeStats = stats.get("claude-sonnet-4-20250514")!;
      expect(claudeStats.provider).toBe("anthropic");
      expect(claudeStats.successRate).toBeCloseTo(2 / 3);
      expect(claudeStats.avgLatencyMs).toBeCloseTo(400);
      expect(claudeStats.dataPoints).toBe(3);

      const gptStats = stats.get("gpt-4o")!;
      expect(gptStats.successRate).toBe(1);
      expect(gptStats.avgLatencyMs).toBe(300);
      expect(gptStats.dataPoints).toBe(1);
    });

    it("returns empty map on error", async () => {
      const client = createMockClient({});
      const adapter = new KomatikModelUsageAdapter({
        client,
        userId: "user-1",
      });
      const stats = await adapter.loadUsageStats();
      expect(stats.size).toBe(0);
    });
  });

  describe("loadOutcomeStats", () => {
    it("aggregates acceptance and correction rates per platform", async () => {
      const client = createMockClient({
        enrichment_outcomes: [
          {
            platform: "cursor",
            verdict: "accepted",
            user_id: "user-1",
            created_at: "2026-04-17T10:00:00Z",
          },
          {
            platform: "cursor",
            verdict: "accepted",
            user_id: "user-1",
            created_at: "2026-04-17T09:00:00Z",
          },
          {
            platform: "cursor",
            verdict: "revised",
            user_id: "user-1",
            created_at: "2026-04-17T08:00:00Z",
          },
          {
            platform: "cursor",
            verdict: "rejected",
            user_id: "user-1",
            created_at: "2026-04-17T07:00:00Z",
          },
          {
            platform: "claude",
            verdict: "accepted",
            user_id: "user-1",
            created_at: "2026-04-17T06:00:00Z",
          },
        ],
      });
      const adapter = new KomatikModelUsageAdapter({
        client,
        userId: "user-1",
      });
      const outcomes = await adapter.loadOutcomeStats();

      expect(outcomes.size).toBe(2);

      const cursorStats = outcomes.get("cursor")!;
      expect(cursorStats.acceptanceRate).toBeCloseTo(0.5);
      expect(cursorStats.correctionRate).toBeCloseTo(0.25);
      expect(cursorStats.dataPoints).toBe(4);

      const claudeStats = outcomes.get("claude")!;
      expect(claudeStats.acceptanceRate).toBe(1);
      expect(claudeStats.dataPoints).toBe(1);
    });

    it("returns empty map on error", async () => {
      const client = createMockClient({});
      const adapter = new KomatikModelUsageAdapter({
        client,
        userId: "user-1",
      });
      const outcomes = await adapter.loadOutcomeStats();
      expect(outcomes.size).toBe(0);
    });
  });

  describe("loadScoringData", () => {
    it("combines all three data sources", async () => {
      const client = createMockClient({
        model_availability: [
          {
            provider: "anthropic",
            api_model_name: "claude-sonnet-4-20250514",
            status: "active",
            smoke_test_latency_ms: 450,
          },
        ],
        llm_usage: [
          {
            model: "claude-sonnet-4-20250514",
            provider: "anthropic",
            success: true,
            latency_ms: 400,
            user_id: "user-1",
            created_at: "2026-04-17T10:00:00Z",
          },
        ],
        enrichment_outcomes: [
          {
            platform: "cursor",
            verdict: "accepted",
            user_id: "user-1",
            created_at: "2026-04-17T10:00:00Z",
          },
        ],
      });
      const adapter = new KomatikModelUsageAdapter({
        client,
        userId: "user-1",
      });
      const data = await adapter.loadScoringData();

      expect(data.availableModels).toHaveLength(1);
      expect(data.usageByModel.size).toBe(1);
      expect(data.outcomesByPlatform.size).toBe(1);
    });
  });

  describe("provider normalization", () => {
    it("normalizes google/gemini to google", async () => {
      const client = createMockClient({
        model_availability: [
          {
            provider: "gemini",
            api_model_name: "gemini-2.5-pro",
            status: "active",
            smoke_test_latency_ms: 500,
          },
          {
            provider: "Google",
            api_model_name: "gemini-2.5-flash",
            status: "active",
            smoke_test_latency_ms: 300,
          },
        ],
      });
      const adapter = new KomatikModelUsageAdapter({
        client,
        userId: "user-1",
      });
      const models = await adapter.loadAvailableModels();

      expect(models[0]!.provider).toBe("google");
      expect(models[1]!.provider).toBe("google");
    });

    it("normalizes meta/llama to meta", async () => {
      const client = createMockClient({
        model_availability: [
          {
            provider: "llama",
            api_model_name: "llama-3.1",
            status: "active",
            smoke_test_latency_ms: 200,
          },
          {
            provider: "Meta",
            api_model_name: "llama-3.2",
            status: "active",
            smoke_test_latency_ms: 250,
          },
        ],
      });
      const adapter = new KomatikModelUsageAdapter({
        client,
        userId: "user-1",
      });
      const models = await adapter.loadAvailableModels();

      expect(models[0]!.provider).toBe("meta");
      expect(models[1]!.provider).toBe("meta");
    });

    it("falls back to custom for unknown providers", async () => {
      const client = createMockClient({
        model_availability: [
          {
            provider: "together",
            api_model_name: "mixtral",
            status: "active",
            smoke_test_latency_ms: 150,
          },
        ],
      });
      const adapter = new KomatikModelUsageAdapter({
        client,
        userId: "user-1",
      });
      const models = await adapter.loadAvailableModels();

      expect(models[0]!.provider).toBe("custom");
    });
  });
});
