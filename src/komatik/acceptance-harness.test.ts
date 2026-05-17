import { describe, it, expect } from "vitest";
import { runAcceptanceHarness, type HarnessMessage, type HarnessConfig } from "./acceptance-harness.js";

const WORKLOAD: HarnessMessage[] = [
  { text: "Fix the auth crash in src/auth/login.ts.", domain: "debugging" },
  { text: "Refactor the billing proration to support split ledgers.", domain: "coding" },
  { text: "Plan the v3 migration timeline for next quarter.", domain: "planning" },
  { text: "Write a blog post about the new pipeline.", domain: "creative" },
  { text: "Analyze last week's deploy metrics for regressions.", domain: "analysis" },
  { text: "Thanks, ship it.", domain: "conversation" },
];

const CONFIGS: HarnessConfig[] = [
  { name: "fixed-budget", tierBias: "budget" },
  { name: "fixed-balanced", tierBias: "balanced" },
  { name: "fixed-premier", tierBias: "premier" },
];

describe("runAcceptanceHarness", () => {
  it("runs every config against the workload and returns per-config results", async () => {
    const comparison = await runAcceptanceHarness({
      workload: WORKLOAD,
      configs: CONFIGS,
    });

    expect(comparison.results).toHaveLength(3);
    for (const r of comparison.results) {
      expect(r.totalMessages).toBe(WORKLOAD.length);
      expect(r.acceptanceRate).toBeGreaterThanOrEqual(0);
      expect(r.acceptanceRate).toBeLessThanOrEqual(1);
      expect(r.avgLatencyMs).toBeGreaterThan(0);
      expect(r.totalCost).toBeGreaterThan(0);
      // At least one model was picked per run.
      expect(Object.keys(r.modelHistogram).length).toBeGreaterThan(0);
    }
  });

  it("identifies winners along acceptance / latency / cost dimensions", async () => {
    const comparison = await runAcceptanceHarness({
      workload: WORKLOAD,
      configs: CONFIGS,
    });

    expect(["fixed-budget", "fixed-balanced", "fixed-premier"]).toContain(
      comparison.winners.byAcceptance,
    );
    expect(["fixed-budget", "fixed-balanced", "fixed-premier"]).toContain(
      comparison.winners.byLatency,
    );
    expect(["fixed-budget", "fixed-balanced", "fixed-premier"]).toContain(
      comparison.winners.byCost,
    );
  });

  it("computes spread (max - min) across configs for each metric", async () => {
    const comparison = await runAcceptanceHarness({
      workload: WORKLOAD,
      configs: CONFIGS,
    });

    expect(comparison.spreads.acceptance).toBeGreaterThanOrEqual(0);
    expect(comparison.spreads.latency).toBeGreaterThanOrEqual(0);
    expect(comparison.spreads.cost).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic — same seed produces identical results", async () => {
    const opts = { workload: WORKLOAD, configs: CONFIGS, seed: 12345 };
    const a = await runAcceptanceHarness(opts);
    const b = await runAcceptanceHarness(opts);

    for (let i = 0; i < a.results.length; i++) {
      expect(a.results[i]!.acceptedCount).toBe(b.results[i]!.acceptedCount);
      expect(a.results[i]!.acceptanceRate).toBeCloseTo(b.results[i]!.acceptanceRate, 6);
    }
  });

  it("respects custom simulated models with per-domain acceptance", async () => {
    const comparison = await runAcceptanceHarness({
      workload: [{ text: "Fix it.", domain: "debugging" }],
      configs: [{ name: "only", tierBias: "balanced" }],
      models: [
        {
          provider: "test",
          apiName: "perfect-debugger",
          smokeLatencyMs: 100,
          costPerKtoken: 0.001,
          acceptanceByDomain: { debugging: 1.0 },
        },
      ],
    });

    // Single model, 100% acceptance for debugging → always accepted.
    expect(comparison.results[0]!.acceptanceRate).toBe(1);
    expect(comparison.results[0]!.modelHistogram).toHaveProperty("perfect-debugger");
  });

  it("handles a single-config comparison without crashing", async () => {
    const comparison = await runAcceptanceHarness({
      workload: WORKLOAD,
      configs: [{ name: "solo", tierBias: "balanced" }],
    });
    expect(comparison.results).toHaveLength(1);
    expect(comparison.winners.byAcceptance).toBe("solo");
    expect(comparison.spreads.acceptance).toBe(0);
  });
});
