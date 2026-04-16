import { describe, it, expect } from "vitest";
import { KomatikProjectAdapter } from "./project-adapter.js";
import { createMockClient } from "./testing.js";
import type { AdapterInput, IntentSignal } from "../types.js";

const stubIntent: IntentSignal = {
  action: "fix",
  specificity: "low",
  scope: "local",
  emotionalLoad: "neutral",
  confidence: 0.5,
  rawFragments: [],
  domainHints: [],
};

const stubInput: AdapterInput = {
  message: "check on my project",
  intent: stubIntent,
  conversation: [],
  existingContext: [],
};

describe("KomatikProjectAdapter", () => {
  it("returns triage intakes and floe scans for user", async () => {
    const client = createMockClient({
      komatik_profiles: [
        { id: "user-1", email: "dev@komatik.xyz" },
      ],
      triage_intakes: [
        {
          id: "tri-1",
          name: "Dev",
          email: "dev@komatik.xyz",
          project_url: null,
          project_type: "description",
          description: "E-commerce platform rewrite with Next.js and Supabase",
          urgency: "high",
          budget: null,
          status: "in_progress",
          stripe_checkout_url: null,
          stripe_payment_intent: null,
          report_url: null,
          notes: null,
          created_at: "2026-04-14T00:00:00Z",
          updated_at: "2026-04-15T00:00:00Z",
        },
      ],
      floe_scans: [
        {
          id: "scan-1",
          email: "dev@komatik.xyz",
          user_id: "user-1",
          repo_url: "https://github.com/user/repo",
          repo_name: "user/repo",
          scan_tier: "deep",
          status: "completed",
          stripe_checkout_url: null,
          stripe_payment_intent: null,
          findings_summary: {},
          findings_count: 12,
          critical_count: 3,
          high_count: 4,
          medium_count: 3,
          low_count: 2,
          report_url: null,
          scan_started_at: "2026-04-14T10:00:00Z",
          scan_completed_at: "2026-04-14T10:05:00Z",
          scan_duration_ms: 300000,
          created_at: "2026-04-14T10:00:00Z",
          updated_at: "2026-04-14T10:05:00Z",
        },
        {
          id: "scan-2",
          email: "dev@komatik.xyz",
          user_id: "user-1",
          repo_url: "https://github.com/user/repo2",
          repo_name: "user/repo2",
          scan_tier: "quick",
          status: "scanning",
          stripe_checkout_url: null,
          stripe_payment_intent: null,
          findings_summary: {},
          findings_count: 0,
          critical_count: 0,
          high_count: 0,
          medium_count: 0,
          low_count: 0,
          report_url: null,
          scan_started_at: "2026-04-15T10:00:00Z",
          scan_completed_at: null,
          scan_duration_ms: null,
          created_at: "2026-04-15T10:00:00Z",
          updated_at: "2026-04-15T10:00:00Z",
        },
      ],
    });

    const adapter = new KomatikProjectAdapter({ client, userId: "user-1" });
    const layers = await adapter.gather(stubInput);

    expect(layers.length).toBe(2);

    const intakeLayer = layers.find((l) =>
      l.summary.includes("triage"),
    );
    expect(intakeLayer).toBeDefined();
    expect(intakeLayer!.summary).toContain("E-commerce platform rewrite");
    expect(intakeLayer!.summary).toContain("in_progress");
    expect(intakeLayer!.summary).toContain("high urgency");

    const scanLayer = layers.find((l) =>
      l.summary.includes("Floe scan"),
    );
    expect(scanLayer).toBeDefined();
    expect(scanLayer!.summary).toContain("2 Floe scan(s)");
    expect(scanLayer!.summary).toContain("12 total findings");
    expect(scanLayer!.summary).toContain("3 critical");
  });

  it("returns empty layers when user has no projects", async () => {
    const client = createMockClient({
      komatik_profiles: [
        { id: "user-2", email: "empty@komatik.xyz" },
      ],
      triage_intakes: [],
      floe_scans: [],
    });

    const adapter = new KomatikProjectAdapter({ client, userId: "user-2" });
    const layers = await adapter.gather(stubInput);
    expect(layers).toHaveLength(0);
  });

  it("summarizes delivered diagnostics separately", async () => {
    const client = createMockClient({
      komatik_profiles: [
        { id: "user-3", email: "done@komatik.xyz" },
      ],
      triage_intakes: [
        {
          id: "tri-done",
          name: "Done",
          email: "done@komatik.xyz",
          project_url: null,
          project_type: "description",
          description: "API audit for security compliance",
          urgency: "medium",
          budget: null,
          status: "delivered",
          stripe_checkout_url: null,
          stripe_payment_intent: null,
          report_url: "https://report.url",
          notes: null,
          created_at: "2026-04-10T00:00:00Z",
          updated_at: "2026-04-12T00:00:00Z",
        },
      ],
      floe_scans: [],
    });

    const adapter = new KomatikProjectAdapter({ client, userId: "user-3" });
    const layers = await adapter.gather(stubInput);

    expect(layers).toHaveLength(1);
    expect(layers[0]!.summary).toContain("1 delivered diagnostic");
  });
});
