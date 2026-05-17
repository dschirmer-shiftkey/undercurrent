import { describe, it, expect, vi } from "vitest";
import { KomatikOutcomeWriter } from "./outcome-writer.js";
import { KomatikPilotProcessor } from "./pilot.js";
import { createMockWriteClient } from "./testing.js";
import type { EnrichedPrompt } from "../types.js";
import type { ProcessInvoker } from "./pilot.js";

function createEnrichedPrompt(overrides?: Partial<EnrichedPrompt>): EnrichedPrompt {
  return {
    originalMessage: "fix the auth bug",
    enrichedMessage: "Fix the authentication bug in middleware.ts",
    intent: {
      action: "fix",
      specificity: "medium",
      scope: "local",
      emotionalLoad: "neutral",
      confidence: 0.85,
      rawFragments: ["auth", "bug"],
      domainHints: ["auth"],
    },
    context: [{ source: "git", priority: 1, timestamp: Date.now(), data: {}, summary: "On branch dev" }],
    gaps: [],
    assumptions: [
      {
        id: "a1",
        claim: "Refers to auth/middleware.ts",
        basis: "Recent git changes",
        confidence: 0.8,
        source: "git",
        correctable: true,
      },
    ],
    clarifications: [],
    metadata: {
      enrichmentId: "enrich-001",
      pipelineVersion: "0.2.0",
      enrichmentDepth: "standard",
      processingTimeMs: 42,
      adapterTimings: { git: 12, conversation: 5 },
      strategyUsed: "default",
      targetPlatform: "generic",
      tokens: {
        originalMessage: 10,
        enrichedMessage: 25,
        context: 8,
        contextByAdapter: { git: 8 },
        overhead: 15,
      },
    },
    ...overrides,
  };
}

describe("KomatikOutcomeWriter", () => {
  it("writes an enrichment record with correct fields", async () => {
    const { client, writes } = createMockWriteClient({ enrichment_outcomes: [] });
    const writer = new KomatikOutcomeWriter(client, "user-42");

    const enriched = createEnrichedPrompt();
    await writer.writeEnrichmentRecord("enrich-001", enriched, {
      platform: "cursor",
      sessionId: "sess-abc",
      modelUsed: "claude-sonnet",
    });

    const inserts = writes["enrichment_outcomes"]!.inserts;
    expect(inserts).toHaveLength(1);

    const row = inserts[0]!;
    expect(row["id"]).toBe("enrich-001");
    expect(row["user_id"]).toBe("user-42");
    expect(row["original_message"]).toBe("fix the auth bug");
    expect(row["enriched_message"]).toBe("Fix the authentication bug in middleware.ts");
    expect(row["strategy_used"]).toBe("default");
    expect(row["enrichment_depth"]).toBe("standard");
    expect(row["verdict"]).toBeNull();
    expect(row["platform"]).toBe("cursor");
    expect(row["session_id"]).toBe("sess-abc");
    expect(row["model_used"]).toBe("claude-sonnet");
    expect(row["context_layer_count"]).toBe(1);
    expect(row["assumption_count"]).toBe(1);
    expect(row["gap_count"]).toBe(0);
    expect(row["processing_time_ms"]).toBe(42);
  });

  it("falls back to targetPlatform when platform is not specified", async () => {
    const { client, writes } = createMockWriteClient({ enrichment_outcomes: [] });
    const writer = new KomatikOutcomeWriter(client, "user-42");

    await writer.writeEnrichmentRecord("enrich-002", createEnrichedPrompt());

    const row = writes["enrichment_outcomes"]!.inserts[0]!;
    expect(row["platform"]).toBe("generic");
  });

  it("records a verdict with accepted assumptions", async () => {
    const { client, writes } = createMockWriteClient({ enrichment_outcomes: [] });
    const writer = new KomatikOutcomeWriter(client, "user-42");

    await writer.recordVerdict({
      enrichmentId: "enrich-001",
      verdict: "accepted",
      assumptionsAccepted: ["Refers to auth/middleware.ts"],
    });

    const updates = writes["enrichment_outcomes"]!.updates;
    expect(updates).toHaveLength(1);
    expect(updates[0]!.data["verdict"]).toBe("accepted");
    expect(updates[0]!.data["assumptions_accepted"]).toEqual(["Refers to auth/middleware.ts"]);
    expect(updates[0]!.filters["id"]).toBe("enrich-001");
    expect(updates[0]!.filters["user_id"]).toBe("user-42");
  });

  it("records a revised verdict and marks had_mutations", async () => {
    const { client, writes } = createMockWriteClient({ enrichment_outcomes: [] });
    const writer = new KomatikOutcomeWriter(client, "user-42");

    await writer.recordVerdict({
      enrichmentId: "enrich-003",
      verdict: "revised",
      assumptionsCorrected: ["Wrong file"],
      correctionDetails: { corrected_to: "auth/login.ts" },
    });

    const update = writes["enrichment_outcomes"]!.updates[0]!;
    expect(update.data["verdict"]).toBe("revised");
    expect(update.data["had_mutations"]).toBe(true);
    expect(update.data["assumptions_corrected"]).toEqual(["Wrong file"]);
    expect(update.data["correction_details"]).toEqual({ corrected_to: "auth/login.ts" });
  });

  it("throws on write failure", async () => {
    const { client } = createMockWriteClient({ enrichment_outcomes: [] });

    // Override insert to simulate error
    const originalFrom = client.from.bind(client);
    client.from = (table: string) => {
      const builder = originalFrom(table);
      builder.insert = () => {
        const errorBuilder = {
          eq: () => errorBuilder,
          neq: () => errorBuilder,
          in: () => errorBuilder,
          lt: () => errorBuilder,
          order: () => errorBuilder,
          limit: () => errorBuilder,
          single: () => Promise.resolve({ data: null, error: { message: "RLS denied" } }),
          then: (onfulfilled: unknown) =>
            Promise.resolve({ data: null, error: { message: "RLS denied" } }).then(
              onfulfilled as (v: unknown) => unknown,
            ),
        };
        return errorBuilder as ReturnType<typeof builder.insert>;
      };
      return builder;
    };

    const writer = new KomatikOutcomeWriter(client, "user-42");
    await expect(writer.writeEnrichmentRecord("e-1", createEnrichedPrompt())).rejects.toThrow("RLS denied");
  });
});

describe("KomatikPilotProcessor with OutcomeWriter", () => {
  function createInvoker(): ProcessInvoker {
    return {
      process: vi.fn(async () => ({
        enrichedPrompt: createEnrichedPrompt(),
        modelRecommendation: {
          domain: "debugging" as const,
          recommended: {
            provider: "anthropic" as const,
            model: "claude-sonnet",
            score: 0.9,
            stats: { successRate: 0.9, acceptanceRate: 0.8, avgLatencyMs: 300, dataPoints: 12 },
          },
          alternatives: [],
          confidence: 0.8,
          reasoning: "test",
          basedOnDataPoints: 12,
        },
        modelResponse: {
          content: "done",
          model: "claude-sonnet",
          provider: "anthropic" as const,
          inputTokens: 120,
          outputTokens: 45,
          latencyMs: 180,
        },
      })),
    };
  }

  it("persists enrichment record on process()", async () => {
    const { client, writes } = createMockWriteClient({ enrichment_outcomes: [] });
    const writer = new KomatikOutcomeWriter(client, "user-42");

    const pilot = new KomatikPilotProcessor(createInvoker(), { outcomeWriter: writer });
    await pilot.process(
      { message: "fix auth", conversation: [] },
      { sourceApp: "forge", userId: "user-42", sessionId: "s-1", requestId: "r-1" },
    );

    const inserts = writes["enrichment_outcomes"]!.inserts;
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!["id"]).toBe("r-1");
    expect(inserts[0]!["platform"]).toBe("forge");
    expect(inserts[0]!["session_id"]).toBe("s-1");
    expect(inserts[0]!["model_used"]).toBe("claude-sonnet");
  });

  it("persists verdict on recordOutcome()", async () => {
    const { client, writes } = createMockWriteClient({ enrichment_outcomes: [] });
    const writer = new KomatikOutcomeWriter(client, "user-42");

    const pilot = new KomatikPilotProcessor(createInvoker(), { outcomeWriter: writer });
    const result = await pilot.process(
      { message: "fix auth", conversation: [] },
      { sourceApp: "forge", requestId: "r-2" },
    );

    await pilot.recordOutcome({
      requestId: result.pilotTelemetry.requestId,
      accepted: true,
      assumptionsAccepted: ["auth/middleware.ts is the target"],
    });

    const updates = writes["enrichment_outcomes"]!.updates;
    expect(updates).toHaveLength(1);
    expect(updates[0]!.data["verdict"]).toBe("accepted");
    expect(updates[0]!.filters["id"]).toBe("r-2");
  });

  it("persists rejected verdict on recordOutcome()", async () => {
    const { client, writes } = createMockWriteClient({ enrichment_outcomes: [] });
    const writer = new KomatikOutcomeWriter(client, "user-42");

    const pilot = new KomatikPilotProcessor(createInvoker(), { outcomeWriter: writer });
    await pilot.process(
      { message: "fix auth", conversation: [] },
      { sourceApp: "triage", requestId: "r-3" },
    );

    await pilot.recordOutcome({
      requestId: "r-3",
      accepted: false,
      assumptionsCorrected: ["wrong file referenced"],
    });

    const updates = writes["enrichment_outcomes"]!.updates;
    expect(updates[0]!.data["verdict"]).toBe("rejected");
    expect(updates[0]!.data["assumptions_corrected"]).toEqual(["wrong file referenced"]);
  });

  it("still works with legacy PilotTelemetrySink API (no outcomeWriter)", async () => {
    const sink = { onProcessTelemetry: vi.fn(), onOutcome: vi.fn() };
    const pilot = new KomatikPilotProcessor(createInvoker(), sink);

    const result = await pilot.process(
      { message: "fix auth", conversation: [] },
      { sourceApp: "forge", requestId: "r-4" },
    );

    expect(sink.onProcessTelemetry).toHaveBeenCalledOnce();
    expect(result.pilotTelemetry.requestId).toBe("r-4");

    await pilot.recordOutcome({ requestId: "r-4", accepted: true });
    expect(sink.onOutcome).toHaveBeenCalledOnce();
  });

  it("silently handles write failures without breaking process()", async () => {
    const { client } = createMockWriteClient({ enrichment_outcomes: [] });

    // Make insert throw
    const originalFrom = client.from.bind(client);
    client.from = (table: string) => {
      const builder = originalFrom(table);
      builder.insert = () => {
        throw new Error("DB connection lost");
      };
      return builder;
    };

    const writer = new KomatikOutcomeWriter(client, "user-42");
    const pilot = new KomatikPilotProcessor(createInvoker(), { outcomeWriter: writer });

    const result = await pilot.process(
      { message: "fix auth", conversation: [] },
      { sourceApp: "forge", requestId: "r-5" },
    );

    expect(result.pilotTelemetry.requestId).toBe("r-5");
    expect(result.enrichedPrompt.originalMessage).toBe("fix the auth bug");
  });
});

describe("Slipstream.enrich() outcome persistence", () => {
  it("auto-persists enrichment record when outcomeWriter is configured", async () => {
    const { Slipstream } = await import("../index.js");
    const { DefaultStrategy } = await import("../strategies/default.js");
    const { client, writes } = createMockWriteClient({ enrichment_outcomes: [] });
    const writer = new KomatikOutcomeWriter(client, "user-99");

    const uc = new Slipstream({
      adapters: [],
      strategy: new DefaultStrategy(),
      outcomeWriter: { writer, sessionId: "sess-x", workspaceId: "ws-1" },
    });

    const result = await uc.enrich({ message: "fix the login page" });

    expect(result.metadata.enrichmentId).toBeTruthy();
    const inserts = writes["enrichment_outcomes"]!.inserts;
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!["id"]).toBe(result.metadata.enrichmentId);
    expect(inserts[0]!["session_id"]).toBe("sess-x");
    expect(inserts[0]!["workspace_id"]).toBe("ws-1");
  });

  it("does not persist when outcomeWriter is not configured", async () => {
    const { Slipstream } = await import("../index.js");
    const { DefaultStrategy } = await import("../strategies/default.js");

    const uc = new Slipstream({
      adapters: [],
      strategy: new DefaultStrategy(),
    });

    const result = await uc.enrich({ message: "just a question" });
    expect(result.metadata.enrichmentId).toBeTruthy();
  });

  it("recordVerdict updates the outcome row", async () => {
    const { Slipstream } = await import("../index.js");
    const { DefaultStrategy } = await import("../strategies/default.js");
    const { client, writes } = createMockWriteClient({ enrichment_outcomes: [] });
    const writer = new KomatikOutcomeWriter(client, "user-99");

    const uc = new Slipstream({
      adapters: [],
      strategy: new DefaultStrategy(),
      outcomeWriter: { writer },
    });

    const result = await uc.enrich({ message: "fix something" });

    await uc.recordVerdict({
      enrichmentId: result.metadata.enrichmentId,
      verdict: "accepted",
    });

    const updates = writes["enrichment_outcomes"]!.updates;
    expect(updates).toHaveLength(1);
    expect(updates[0]!.data["verdict"]).toBe("accepted");
    expect(updates[0]!.filters["id"]).toBe(result.metadata.enrichmentId);
  });

  it("enrichment succeeds even if outcome write fails", async () => {
    const { Slipstream } = await import("../index.js");
    const { DefaultStrategy } = await import("../strategies/default.js");
    const { client } = createMockWriteClient({ enrichment_outcomes: [] });

    // Sabotage inserts
    const originalFrom = client.from.bind(client);
    client.from = (table: string) => {
      const builder = originalFrom(table);
      builder.insert = () => {
        throw new Error("Network timeout");
      };
      return builder;
    };

    const writer = new KomatikOutcomeWriter(client, "user-99");
    const uc = new Slipstream({
      adapters: [],
      strategy: new DefaultStrategy(),
      outcomeWriter: { writer },
    });

    const result = await uc.enrich({ message: "do something" });
    expect(result.enrichedMessage).toBeTruthy();
  });
});
