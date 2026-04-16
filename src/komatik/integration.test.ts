import { describe, it, expect } from "vitest";
import { Pipeline } from "../engine/pipeline.js";
import { DefaultStrategy } from "../strategies/default.js";
import { ConversationAdapter } from "../adapters/conversation.js";
import { KomatikIdentityAdapter } from "./identity-adapter.js";
import { KomatikHistoryAdapter } from "./history-adapter.js";
import { KomatikProjectAdapter } from "./project-adapter.js";
import { KomatikMarketplaceAdapter } from "./marketplace-adapter.js";
import { createMockClient } from "./testing.js";
import type { UndercurrentConfig } from "../types.js";

const now = Date.now();
const hoursAgo = (h: number) =>
  new Date(now - h * 60 * 60 * 1000).toISOString();

function buildFullEcosystemClient() {
  return createMockClient({
    komatik_profiles: [
      {
        id: "user-1",
        display_name: "Sarah Chen",
        email: "sarah@komatik.xyz",
        avatar_url: null,
        primary_role: "founder",
        products_used: ["marketplace", "triage", "floe", "cognitive-debt"],
        onboarding_complete: true,
        created_at: "2026-03-01T00:00:00Z",
        updated_at: "2026-04-15T00:00:00Z",
      },
    ],
    user_product_events: [
      {
        id: "evt-1",
        user_id: "user-1",
        email: "sarah@komatik.xyz",
        product_slug: "triage",
        event_type: "submitted_intake",
        metadata: {},
        created_at: hoursAgo(2),
      },
      {
        id: "evt-2",
        user_id: "user-1",
        email: "sarah@komatik.xyz",
        product_slug: "floe",
        event_type: "purchased",
        metadata: {},
        created_at: hoursAgo(26),
      },
      {
        id: "evt-3",
        user_id: "user-1",
        email: "sarah@komatik.xyz",
        product_slug: "cognitive-debt",
        event_type: "completed_quiz",
        metadata: { score: 72, level: "moderate" },
        created_at: hoursAgo(100),
      },
    ],
    crm_contacts: [
      {
        id: "crm-1",
        email: "sarah@komatik.xyz",
        name: "Sarah Chen",
        company: "TechCo",
        source: "triage",
        status: "customer",
        score: 95,
        tags: ["founder", "repeat"],
        metadata: {},
        first_seen_at: hoursAgo(500),
        last_activity_at: hoursAgo(2),
        created_at: hoursAgo(500),
        updated_at: hoursAgo(2),
      },
    ],
    crm_activities: [
      {
        id: "act-1",
        contact_id: "crm-1",
        deal_id: null,
        activity_type: "quiz_completed",
        description: null,
        metadata: {},
        created_at: hoursAgo(100),
      },
      {
        id: "act-2",
        contact_id: "crm-1",
        deal_id: null,
        activity_type: "triage_submitted",
        description: null,
        metadata: {},
        created_at: hoursAgo(50),
      },
      {
        id: "act-3",
        contact_id: "crm-1",
        deal_id: null,
        activity_type: "triage_paid",
        description: null,
        metadata: {},
        created_at: hoursAgo(48),
      },
      {
        id: "act-4",
        contact_id: "crm-1",
        deal_id: null,
        activity_type: "floe_paid",
        description: null,
        metadata: {},
        created_at: hoursAgo(26),
      },
    ],
    triage_intakes: [
      {
        id: "tri-1",
        name: "Sarah Chen",
        email: "sarah@komatik.xyz",
        project_url: "https://github.com/techco/platform",
        project_type: "repo",
        description:
          "Full-stack e-commerce platform rebuild — migrating from PHP to Next.js + Supabase. Need architecture review and security audit.",
        urgency: "high",
        budget: "$5000",
        status: "in_progress",
        stripe_checkout_url: null,
        stripe_payment_intent: "pi_abc123",
        report_url: null,
        notes: "Quiz flagged high_ai_reliance and shallow_reviews",
        created_at: hoursAgo(48),
        updated_at: hoursAgo(2),
      },
    ],
    floe_scans: [
      {
        id: "scan-1",
        email: "sarah@komatik.xyz",
        user_id: "user-1",
        repo_url: "https://github.com/techco/platform",
        repo_name: "techco/platform",
        scan_tier: "deep",
        status: "completed",
        stripe_checkout_url: null,
        stripe_payment_intent: "pi_def456",
        findings_summary: { sql_injection: 2, hardcoded_secrets: 1 },
        findings_count: 8,
        critical_count: 2,
        high_count: 3,
        medium_count: 2,
        low_count: 1,
        report_url: "https://floe.komatik.xyz/report/scan-1",
        scan_started_at: hoursAgo(25),
        scan_completed_at: hoursAgo(24),
        scan_duration_ms: 180000,
        created_at: hoursAgo(26),
        updated_at: hoursAgo(24),
      },
    ],
    forge_usage: [
      {
        id: "use-1",
        tool_id: "tool-code-review",
        consumer_id: "user-1",
        latency_ms: 340,
        success: true,
        cost_cents: 1.5,
        created_at: hoursAgo(12),
      },
      {
        id: "use-2",
        tool_id: "tool-code-review",
        consumer_id: "user-1",
        latency_ms: 290,
        success: true,
        cost_cents: 1.5,
        created_at: hoursAgo(6),
      },
    ],
    forge_tools: [],
  });
}

describe("Komatik Integration — Full Pipeline", () => {
  it("enriches a vague message with full ecosystem context", async () => {
    const client = buildFullEcosystemClient();

    const config: UndercurrentConfig = {
      adapters: [
        new KomatikIdentityAdapter({ client, userId: "user-1" }),
        new KomatikHistoryAdapter({ client, userId: "user-1" }),
        new KomatikProjectAdapter({ client, userId: "user-1" }),
        new KomatikMarketplaceAdapter({ client, userId: "user-1" }),
        new ConversationAdapter(),
      ],
      strategy: new DefaultStrategy(),
    };

    const pipeline = new Pipeline(config);
    const result = await pipeline.enrich({
      message: "check the security stuff",
      conversation: [
        {
          role: "user",
          content: "I submitted my platform for review yesterday",
        },
        {
          role: "assistant",
          content: "I see your triage intake is in progress",
        },
      ],
      enrichmentContext: { source: "consultant", sessionId: "sess-123" },
    });

    expect(result.originalMessage).toBe("check the security stuff");
    expect(result.intent.action).toBe("explore");
    expect(result.intent.domainHints).toContain("security");

    expect(result.context.length).toBeGreaterThanOrEqual(4);

    const sources = result.context.map((c) => c.source);
    expect(sources).toContain("komatik-identity");
    expect(sources).toContain("komatik-history");
    expect(sources).toContain("komatik-projects");
    expect(sources).toContain("komatik-marketplace");
    expect(sources).toContain("conversation");

    const identityLayer = result.context.find(
      (c) => c.source === "komatik-identity",
    );
    expect(identityLayer!.summary).toContain("Sarah Chen");
    expect(identityLayer!.summary).toContain("founder");

    const projectLayer = result.context.find(
      (c) =>
        c.source === "komatik-projects" &&
        c.summary.includes("Floe"),
    );
    expect(projectLayer).toBeDefined();
    expect(projectLayer!.summary).toContain("8 total findings");
    expect(projectLayer!.summary).toContain("2 critical");

    expect(result.enrichedMessage).toContain("[Original]:");
    expect(result.enrichedMessage).toContain("[Context]:");
    expect(result.enrichedMessage).toContain("Sarah Chen");
    expect(result.enrichedMessage).toContain("security");

    expect(result.metadata.enrichmentDepth).toBe("deep");
    expect(result.metadata.strategyUsed).toBe("default");
    expect(result.metadata.processingTimeMs).toBeGreaterThan(0);
  });

  it("passes through high-specificity requests even with ecosystem context", async () => {
    const client = buildFullEcosystemClient();

    const config: UndercurrentConfig = {
      adapters: [
        new KomatikIdentityAdapter({ client, userId: "user-1" }),
        new KomatikHistoryAdapter({ client, userId: "user-1" }),
      ],
      strategy: new DefaultStrategy(),
    };

    const pipeline = new Pipeline(config);
    const result = await pipeline.enrich({
      message:
        "fix the `validateInput` function on line 42 of src/auth/middleware.ts — it crashes on empty string",
    });

    expect(result.metadata.enrichmentDepth).toBe("none");
    expect(result.enrichedMessage).toBe(result.originalMessage);
    expect(result.context).toEqual([]);
  });

  it("gracefully handles missing user data across all adapters", async () => {
    const emptyClient = createMockClient({
      komatik_profiles: [],
      user_product_events: [],
      crm_contacts: [],
      crm_activities: [],
      triage_intakes: [],
      floe_scans: [],
      forge_usage: [],
      forge_tools: [],
    });

    const config: UndercurrentConfig = {
      adapters: [
        new KomatikIdentityAdapter({
          client: emptyClient,
          userId: "ghost-user",
        }),
        new KomatikHistoryAdapter({
          client: emptyClient,
          userId: "ghost-user",
        }),
        new KomatikProjectAdapter({
          client: emptyClient,
          userId: "ghost-user",
        }),
        new KomatikMarketplaceAdapter({
          client: emptyClient,
          userId: "ghost-user",
        }),
      ],
      strategy: new DefaultStrategy(),
    };

    const pipeline = new Pipeline(config);
    const result = await pipeline.enrich({
      message: "help me with something",
    });

    expect(result.enrichedMessage).toBeTruthy();
    const komatikLayers = result.context.filter((c) =>
      c.source.startsWith("komatik-"),
    );
    expect(komatikLayers).toHaveLength(0);
  });
});
