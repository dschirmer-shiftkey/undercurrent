import { describe, it, expect, vi } from "vitest";
import { KomatikPilotProcessor } from "./pilot.js";
import type { ProcessInvoker } from "./pilot.js";

function createInvoker(): ProcessInvoker {
  return {
    process: vi.fn(async () => ({
      enrichedPrompt: {
        originalMessage: "fix auth",
        enrichedMessage: "Fix auth in login.ts line 12",
        intent: {
          action: "fix",
          specificity: "high",
          scope: "atomic",
          emotionalLoad: "neutral",
          confidence: 0.9,
          rawFragments: [],
          domainHints: ["auth"],
        },
        context: [],
        gaps: [],
        assumptions: [],
        clarifications: [],
        metadata: {
          pipelineVersion: "0.2.0",
          enrichmentDepth: "standard",
          processingTimeMs: 20,
          adapterTimings: {},
          strategyUsed: "default",
          targetPlatform: "generic",
          governance: {
            preset: "balanced",
            contextLayersBefore: 0,
            contextLayersAfter: 0,
            assumptionsBefore: 1,
            assumptionsAfter: 0,
            interventions: [
              {
                type: "assumption-blocked",
                reason: "below threshold",
                severity: "warn",
              },
            ],
          },
          tokens: {
            originalMessage: 10,
            enrichedMessage: 22,
            context: 0,
            contextByAdapter: {},
            overhead: 12,
          },
        },
      },
      modelRecommendation: {
        domain: "debugging",
        recommended: {
          provider: "anthropic",
          model: "claude-sonnet",
          score: 0.9,
          stats: {
            successRate: 0.9,
            acceptanceRate: 0.8,
            avgLatencyMs: 300,
            dataPoints: 12,
          },
        },
        alternatives: [],
        confidence: 0.8,
        reasoning: "test",
        basedOnDataPoints: 12,
      },
      modelResponse: {
        content: "done",
        model: "claude-sonnet",
        provider: "anthropic",
        inputTokens: 120,
        outputTokens: 45,
        latencyMs: 180,
      },
    })),
  };
}

describe("KomatikPilotProcessor", () => {
  it("emits process telemetry with ROI metrics", async () => {
    const sink = {
      onProcessTelemetry: vi.fn(),
      onOutcome: vi.fn(),
    };
    const pilot = new KomatikPilotProcessor(createInvoker(), sink);
    const result = await pilot.process(
      { message: "fix auth", conversation: [], targetPlatform: "generic" },
      { sourceApp: "forge", userId: "user-1", sessionId: "session-1", requestId: "req-1" },
    );

    expect(result.pilotTelemetry.requestId).toBe("req-1");
    expect(result.pilotTelemetry.sourceApp).toBe("forge");
    expect(result.pilotTelemetry.blockedAssumptions).toBe(1);
    expect(result.pilotTelemetry.tokenMultiplier).toBe(2.2);
    expect(sink.onProcessTelemetry).toHaveBeenCalledOnce();
  });

  it("tracks outcomes and summarizes acceptance + latency", async () => {
    const pilot = new KomatikPilotProcessor(createInvoker());
    const processed = await pilot.process(
      { message: "fix auth", conversation: [] },
      { sourceApp: "triage", requestId: "req-2" },
    );
    await pilot.recordOutcome({ requestId: processed.pilotTelemetry.requestId, accepted: true });

    const summary = pilot.summarizeRoi();
    expect(summary.totalRequests).toBe(1);
    expect(summary.acceptedCount).toBe(1);
    expect(summary.acceptanceRate).toBe(1);
    expect(summary.avgTokenMultiplier).toBeGreaterThan(1);
  });
});

