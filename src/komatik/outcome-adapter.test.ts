import { describe, it, expect } from "vitest";
import { KomatikOutcomeAdapter } from "./outcome-adapter.js";
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
  message: "fix the thing",
  intent: stubIntent,
  conversation: [],
  existingContext: [],
};

describe("KomatikOutcomeAdapter", () => {
  it("returns outcome stats for a user with enrichment history", async () => {
    const client = createMockClient({
      enrichment_outcomes: [
        {
          id: "out-1",
          user_id: "user-1",
          enrichment_id: "enr-1",
          original_message: "fix the auth",
          enriched_message: "[Original]: fix the auth...",
          strategy_used: "default",
          enrichment_depth: "deep",
          verdict: "accepted",
          assumptions_accepted: ["inferred auth module"],
          assumptions_corrected: [],
          correction_details: {},
          platform: "cursor",
          session_id: "sess-1",
          created_at: "2026-04-15T10:00:00Z",
        },
        {
          id: "out-2",
          user_id: "user-1",
          enrichment_id: "enr-2",
          original_message: "update the thing",
          enriched_message: "[Original]: update the thing...",
          strategy_used: "default",
          enrichment_depth: "standard",
          verdict: "revised",
          assumptions_accepted: [],
          assumptions_corrected: ["wrong file assumed", "wrong scope assumed"],
          correction_details: { file: "src/api/routes.ts" },
          platform: "claude",
          session_id: "sess-2",
          created_at: "2026-04-15T08:00:00Z",
        },
        {
          id: "out-3",
          user_id: "user-1",
          enrichment_id: "enr-3",
          original_message: "deploy it",
          enriched_message: "[Original]: deploy it...",
          strategy_used: "default",
          enrichment_depth: "light",
          verdict: "rejected",
          assumptions_accepted: [],
          assumptions_corrected: ["wrong scope assumed"],
          correction_details: {},
          platform: "cursor",
          session_id: "sess-3",
          created_at: "2026-04-14T20:00:00Z",
        },
      ],
    });

    const adapter = new KomatikOutcomeAdapter({ client, userId: "user-1" });
    expect(await adapter.available()).toBe(true);

    const layers = await adapter.gather(stubInput);
    expect(layers).toHaveLength(1);

    const layer = layers[0]!;
    expect(layer.source).toBe("komatik-outcomes");
    expect(layer.summary).toContain("3 recent enrichments");
    expect(layer.summary).toContain("1 accepted");
    expect(layer.summary).toContain("1 revised");
    expect(layer.summary).toContain("1 rejected");
    expect(layer.summary).toContain("33% acceptance");
    expect(layer.summary).toContain("wrong scope assumed");

    const stats = (layer.data as { stats: { totalCorrected: number } }).stats;
    expect(stats.totalCorrected).toBe(3);
  });

  it("returns empty layers when no outcomes exist", async () => {
    const client = createMockClient({ enrichment_outcomes: [] });
    const adapter = new KomatikOutcomeAdapter({
      client,
      userId: "new-user",
    });

    const layers = await adapter.gather(stubInput);
    expect(layers).toHaveLength(0);
  });

  it("handles all-accepted outcomes correctly", async () => {
    const client = createMockClient({
      enrichment_outcomes: [
        {
          id: "out-1",
          user_id: "user-2",
          enrichment_id: "enr-1",
          original_message: "build login page",
          enriched_message: "[Original]: build login page...",
          strategy_used: "default",
          enrichment_depth: "standard",
          verdict: "accepted",
          assumptions_accepted: ["React + Tailwind"],
          assumptions_corrected: [],
          correction_details: {},
          platform: "cursor",
          session_id: null,
          created_at: "2026-04-15T12:00:00Z",
        },
      ],
    });

    const adapter = new KomatikOutcomeAdapter({ client, userId: "user-2" });
    const layers = await adapter.gather(stubInput);

    expect(layers).toHaveLength(1);
    expect(layers[0]!.summary).toContain("100% acceptance");
    expect(layers[0]!.summary).not.toContain("Frequent corrections");
  });

  it("reports unavailable when userId is empty", async () => {
    const client = createMockClient({});
    const adapter = new KomatikOutcomeAdapter({ client, userId: "" });
    expect(await adapter.available()).toBe(false);
  });
});
