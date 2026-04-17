import { describe, it, expect, vi } from "vitest";
import { Undercurrent } from "../index.js";
import { DefaultStrategy } from "../strategies/default.js";
import { createMockClient } from "../komatik/testing.js";
import type {
  ModelCallerFn,
  ModelCallerInput,
  ModelCallerOutput,
  ModelRecommendation,
  UndercurrentConfig,
} from "../types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockCaller(): ModelCallerFn {
  return vi.fn(
    async (input: ModelCallerInput): Promise<ModelCallerOutput> => ({
      content: `Response from ${input.model} to: ${input.enrichedSystemPrompt.slice(0, 50)}...`,
      model: input.model,
      provider: input.provider,
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 200,
    }),
  );
}

function makeConfig(overrides: Partial<UndercurrentConfig> = {}): UndercurrentConfig {
  const client = createMockClient({
    model_availability: [
      {
        id: "m1",
        model_id: "claude-4",
        provider: "anthropic",
        api_model_name: "claude-4-sonnet-20260401",
        display_name: "Claude 4 Sonnet",
        model_family: "claude-4",
        status: "active",
        discovered_at: "2026-04-01T00:00:00Z",
        last_checked_at: "2026-04-17T00:00:00Z",
        smoke_test_passed: true,
        smoke_test_latency_ms: 380,
        metadata: {},
      },
      {
        id: "m2",
        model_id: "gpt-5",
        provider: "openai",
        api_model_name: "gpt-5-0401",
        display_name: "GPT-5",
        model_family: "gpt-5",
        status: "active",
        discovered_at: "2026-04-01T00:00:00Z",
        last_checked_at: "2026-04-17T00:00:00Z",
        smoke_test_passed: true,
        smoke_test_latency_ms: 420,
        metadata: {},
      },
      {
        id: "m3",
        model_id: "gemini-2.5",
        provider: "google",
        api_model_name: "gemini-2.5-pro",
        display_name: "Gemini 2.5 Pro",
        model_family: "gemini-2.5",
        status: "active",
        discovered_at: "2026-04-01T00:00:00Z",
        last_checked_at: "2026-04-17T00:00:00Z",
        smoke_test_passed: true,
        smoke_test_latency_ms: 500,
        metadata: {},
      },
      {
        id: "m4",
        model_id: "old-model",
        provider: "anthropic",
        api_model_name: "claude-3.5-sonnet",
        display_name: "Claude 3.5",
        model_family: "claude-3.5",
        status: "deprecated",
        discovered_at: "2025-06-01T00:00:00Z",
        last_checked_at: "2026-04-17T00:00:00Z",
        smoke_test_passed: true,
        smoke_test_latency_ms: 300,
        metadata: {},
      },
    ],
    llm_usage: [
      {
        id: "u1",
        provider: "anthropic",
        model: "claude-4-sonnet-20260401",
        task_type: "coding",
        product: "forge",
        input_tokens: 500,
        output_tokens: 200,
        cost_cents: 5,
        latency_ms: 350,
        cascade_depth: 0,
        success: true,
        error_message: null,
        user_id: "user-1",
        created_at: "2026-04-16T10:00:00Z",
      },
      {
        id: "u2",
        provider: "anthropic",
        model: "claude-4-sonnet-20260401",
        task_type: "coding",
        product: "forge",
        input_tokens: 600,
        output_tokens: 250,
        cost_cents: 6,
        latency_ms: 400,
        cascade_depth: 0,
        success: true,
        error_message: null,
        user_id: "user-1",
        created_at: "2026-04-16T11:00:00Z",
      },
      {
        id: "u3",
        provider: "openai",
        model: "gpt-5-0401",
        task_type: "coding",
        product: "forge",
        input_tokens: 500,
        output_tokens: 200,
        cost_cents: 8,
        latency_ms: 500,
        cascade_depth: 0,
        success: false,
        error_message: "timeout",
        user_id: "user-1",
        created_at: "2026-04-16T12:00:00Z",
      },
    ],
    enrichment_outcomes: [
      {
        id: "o1",
        user_id: "user-1",
        enrichment_id: "e1",
        original_message: "fix auth",
        enriched_message: "...",
        strategy_used: "default",
        enrichment_depth: "standard",
        verdict: "accepted",
        assumptions_accepted: [],
        assumptions_corrected: [],
        correction_details: {},
        platform: "anthropic",
        session_id: null,
        created_at: "2026-04-16T10:00:00Z",
      },
      {
        id: "o2",
        user_id: "user-1",
        enrichment_id: "e2",
        original_message: "build page",
        enriched_message: "...",
        strategy_used: "default",
        enrichment_depth: "standard",
        verdict: "accepted",
        assumptions_accepted: [],
        assumptions_corrected: [],
        correction_details: {},
        platform: "anthropic",
        session_id: null,
        created_at: "2026-04-16T11:00:00Z",
      },
      {
        id: "o3",
        user_id: "user-1",
        enrichment_id: "e3",
        original_message: "write copy",
        enriched_message: "...",
        strategy_used: "default",
        enrichment_depth: "standard",
        verdict: "revised",
        assumptions_accepted: [],
        assumptions_corrected: ["wrong tone"],
        correction_details: {},
        platform: "openai",
        session_id: null,
        created_at: "2026-04-16T12:00:00Z",
      },
    ],
  });

  const caller = mockCaller();

  return {
    adapters: [],
    strategy: new DefaultStrategy(),
    modelRouter: {
      enabled: true,
      caller,
      userId: "user-1",
      client,
    },
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("process() integration", () => {
  it("enriches, routes, and calls the model in one flow", async () => {
    const config = makeConfig();
    const uc = new Undercurrent(config);

    const result = await uc.process({
      message: "refactor the authentication module to use JWT tokens",
      conversation: [
        { role: "user", content: "I need to update our auth system" },
        { role: "assistant", content: "Sure, what changes do you need?" },
      ],
    });

    expect(result.enrichedPrompt).toBeDefined();
    expect(result.enrichedPrompt.originalMessage).toBe(
      "refactor the authentication module to use JWT tokens",
    );
    expect(result.modelRecommendation).toBeDefined();
    expect(result.modelRecommendation.domain).toBeDefined();
    expect(result.modelResponse).toBeDefined();
    expect(result.modelResponse.content).toContain("Response from");
    expect(result.modelResponse.inputTokens).toBe(100);

    // The caller should have been invoked exactly once
    const caller = config.modelRouter!.caller as ReturnType<typeof vi.fn>;
    expect(caller).toHaveBeenCalledTimes(1);
  });

  it("only returns active models (excludes deprecated)", async () => {
    const config = makeConfig();
    const uc = new Undercurrent(config);

    const result = await uc.process({
      message: "build a new React component for the dashboard",
    });

    const allModels = [
      result.modelRecommendation.recommended,
      ...result.modelRecommendation.alternatives,
    ];

    const modelNames = allModels.map((m) => m.model);
    expect(modelNames).not.toContain("claude-3.5-sonnet");
    expect(modelNames.length).toBe(3);
  });

  it("attaches modelRecommendation to enrichment metadata", async () => {
    const config = makeConfig();
    const uc = new Undercurrent(config);

    const result = await uc.process({
      message: "write a blog post about context engineering",
    });

    expect(result.enrichedPrompt.metadata.modelRecommendation).toBeDefined();
    expect(result.enrichedPrompt.metadata.modelRecommendation).toBe(result.modelRecommendation);
  });

  it("calls onModelSelected callback", async () => {
    const onModelSelected = vi.fn();
    const config = makeConfig();
    config.modelRouter!.onModelSelected = onModelSelected;

    const uc = new Undercurrent(config);
    await uc.process({ message: "fix the null pointer bug in the API handler" });

    expect(onModelSelected).toHaveBeenCalledTimes(1);
    const rec: ModelRecommendation = onModelSelected.mock.calls[0]![0];
    expect(rec.domain).toBeDefined();
    expect(rec.recommended).toBeDefined();
  });

  it("throws when process() is called without modelRouter config", async () => {
    const uc = new Undercurrent({
      adapters: [],
      strategy: new DefaultStrategy(),
    });

    await expect(uc.process({ message: "hello" })).rejects.toThrow("modelRouter");
  });

  it("enrich() still works independently without modelRouter", async () => {
    const uc = new Undercurrent({
      adapters: [],
      strategy: new DefaultStrategy(),
    });

    const result = await uc.enrich({ message: "hello world" });
    expect(result.enrichedMessage).toBeDefined();
    expect(result.metadata.modelRecommendation).toBeUndefined();
  });

  it("passes conversation history to the model caller", async () => {
    const config = makeConfig();
    const uc = new Undercurrent(config);

    const conversation = [
      { role: "user" as const, content: "I need help with the API" },
      { role: "assistant" as const, content: "What specifically?" },
    ];

    await uc.process({
      message: "fix the rate limiting middleware",
      conversation,
    });

    const caller = config.modelRouter!.caller as ReturnType<typeof vi.fn>;
    const callerInput: ModelCallerInput = caller.mock.calls[0]![0];
    expect(callerInput.messages).toEqual(conversation);
    expect(callerInput.enrichedSystemPrompt).toBeDefined();
    expect(callerInput.provider).toBeDefined();
    expect(callerInput.model).toBeDefined();
  });

  it("uses historical data to influence model selection", async () => {
    const client = createMockClient({
      model_availability: [
        {
          id: "m1",
          model_id: "claude-4",
          provider: "anthropic",
          api_model_name: "claude-4-sonnet",
          display_name: "Claude 4",
          model_family: "claude-4",
          status: "active",
          discovered_at: "2026-04-01T00:00:00Z",
          last_checked_at: "2026-04-17T00:00:00Z",
          smoke_test_passed: true,
          smoke_test_latency_ms: 400,
          metadata: {},
        },
        {
          id: "m2",
          model_id: "gemini-2.5",
          provider: "google",
          api_model_name: "gemini-2.5-pro",
          display_name: "Gemini 2.5",
          model_family: "gemini-2.5",
          status: "active",
          discovered_at: "2026-04-01T00:00:00Z",
          last_checked_at: "2026-04-17T00:00:00Z",
          smoke_test_passed: true,
          smoke_test_latency_ms: 500,
          metadata: {},
        },
      ],
      llm_usage: Array.from({ length: 40 }, (_, i) => ({
        id: `u${i}`,
        provider: "google",
        model: "gemini-2.5-pro",
        task_type: "creative",
        product: "basecamp",
        input_tokens: 300,
        output_tokens: 150,
        cost_cents: 3,
        latency_ms: 300,
        cascade_depth: 0,
        success: true,
        error_message: null,
        user_id: "user-2",
        created_at: `2026-04-${String(10 + (i % 7)).padStart(2, "0")}T10:00:00Z`,
      })),
      enrichment_outcomes: Array.from({ length: 30 }, (_, i) => ({
        id: `o${i}`,
        user_id: "user-2",
        enrichment_id: `e${i}`,
        original_message: "write copy",
        enriched_message: "...",
        strategy_used: "default",
        enrichment_depth: "standard",
        verdict: "accepted",
        assumptions_accepted: [],
        assumptions_corrected: [],
        correction_details: {},
        platform: "google",
        session_id: null,
        created_at: `2026-04-${String(10 + (i % 7)).padStart(2, "0")}T10:00:00Z`,
      })),
    });

    const config = makeConfig({
      modelRouter: {
        enabled: true,
        caller: mockCaller(),
        userId: "user-2",
        client,
      },
    });

    const uc = new Undercurrent(config);
    const result = await uc.process({
      message: "write a creative marketing headline for our new product launch",
    });

    // With 40 successful usages and 30 accepted outcomes for Google,
    // combined with creative domain affinity, gemini should win
    expect(result.modelRecommendation.recommended.provider).toBe("google");
    expect(result.modelRecommendation.basedOnDataPoints).toBeGreaterThan(0);
  });
});
