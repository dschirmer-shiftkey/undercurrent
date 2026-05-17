import { describe, it, expect } from "vitest";
import { runPilotSimulation } from "./pilot-simulator.js";

describe("runPilotSimulation", () => {
  it("runs the full pilot path end-to-end and emits ROI summary", async () => {
    const result = await runPilotSimulation({
      messages: [
        "Fix the auth crash in src/auth/login.ts when the token is missing.",
        "Also add a regression test for the null-token path.",
      ],
      sourceApp: "platform",
    });

    expect(result.events).toHaveLength(2);
    expect(result.outcomes).toHaveLength(2);
    expect(result.enrichments).toHaveLength(2);

    for (const event of result.events) {
      expect(event.sourceApp).toBe("platform");
      expect(event.modelProvider).toBeTypeOf("string");
      expect(event.modelName).toBeTypeOf("string");
      expect(event.tokenMultiplier).toBeGreaterThan(0);
      expect(event.totalLatencyMs).toBeGreaterThanOrEqual(event.modelLatencyMs);
    }

    expect(result.roi.totalRequests).toBe(2);
    expect(result.roi.acceptanceRate).toBeGreaterThan(0);
    expect(result.roi.avgTokenMultiplier).toBeGreaterThan(0);
  });

  it("persists enrichment records and verdicts to the outcome writer", async () => {
    const result = await runPilotSimulation({
      messages: ["Refactor billing to support split ledgers."],
    });

    const outcomeWrites = result.writes.enrichment_outcomes;
    expect(outcomeWrites).toBeDefined();
    // One insert per enrichment (telemetry row), then one update per outcome verdict.
    expect(outcomeWrites!.inserts).toHaveLength(1);
    expect(outcomeWrites!.updates).toHaveLength(1);

    const insert = outcomeWrites!.inserts[0]!;
    expect(insert.user_id).toBe("sim-user-1");
    expect(insert.original_message).toBe("Refactor billing to support split ledgers.");
    expect(insert.verdict).toBeNull();

    const update = outcomeWrites!.updates[0]!;
    expect(update.data.verdict).toMatch(/accepted|rejected/);
  });

  it("respects a custom verdict rule that rejects high-latency calls", async () => {
    const result = await runPilotSimulation({
      messages: ["Quick one-liner change."],
      verdictRule: () => false,
    });

    expect(result.outcomes[0]?.accepted).toBe(false);
    expect(result.roi.acceptanceRate).toBe(0);

    const update = result.writes.enrichment_outcomes!.updates[0]!;
    expect(update.data.verdict).toBe("rejected");
  });

  it("threads requestId through telemetry, outcome, and the persisted record", async () => {
    const result = await runPilotSimulation({
      messages: ["Wire up the new pilot consumer."],
    });

    const telemetry = result.events[0]!;
    const outcome = result.outcomes[0]!;
    const insertedId = result.writes.enrichment_outcomes!.inserts[0]!.id as string;

    expect(outcome.requestId).toBe(telemetry.requestId);
    expect(insertedId).toBe(telemetry.requestId);
  });
});
