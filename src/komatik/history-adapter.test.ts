import { describe, it, expect } from "vitest";
import { KomatikHistoryAdapter } from "./history-adapter.js";
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
  message: "what's going on",
  intent: stubIntent,
  conversation: [],
  existingContext: [],
};

const now = Date.now();
const hoursAgo = (h: number) => new Date(now - h * 60 * 60 * 1000).toISOString();

describe("KomatikHistoryAdapter", () => {
  it("returns event history and CRM context", async () => {
    const client = createMockClient({
      komatik_profiles: [
        { id: "user-1", email: "dev@komatik.xyz" },
      ],
      user_product_events: [
        {
          id: "evt-1",
          user_id: "user-1",
          email: "dev@komatik.xyz",
          product_slug: "triage",
          event_type: "submitted_intake",
          metadata: {},
          created_at: hoursAgo(2),
        },
        {
          id: "evt-2",
          user_id: "user-1",
          email: "dev@komatik.xyz",
          product_slug: "floe",
          event_type: "purchased",
          metadata: {},
          created_at: hoursAgo(26),
        },
        {
          id: "evt-3",
          user_id: "user-1",
          email: "dev@komatik.xyz",
          product_slug: "marketplace",
          event_type: "visited",
          metadata: {},
          created_at: hoursAgo(72),
        },
      ],
      crm_contacts: [
        {
          id: "crm-1",
          email: "dev@komatik.xyz",
          name: "Dev",
          company: null,
          source: "triage",
          status: "qualified",
          score: 60,
          tags: [],
          metadata: {},
          first_seen_at: hoursAgo(200),
          last_activity_at: hoursAgo(2),
          created_at: hoursAgo(200),
          updated_at: hoursAgo(2),
        },
      ],
      crm_activities: [
        {
          id: "act-1",
          contact_id: "crm-1",
          deal_id: null,
          activity_type: "triage_submitted",
          description: null,
          metadata: {},
          created_at: hoursAgo(48),
        },
        {
          id: "act-2",
          contact_id: "crm-1",
          deal_id: null,
          activity_type: "triage_paid",
          description: null,
          metadata: {},
          created_at: hoursAgo(24),
        },
        {
          id: "act-3",
          contact_id: "crm-1",
          deal_id: null,
          activity_type: "floe_submitted",
          description: null,
          metadata: {},
          created_at: hoursAgo(2),
        },
      ],
    });

    const adapter = new KomatikHistoryAdapter({ client, userId: "user-1" });
    const layers = await adapter.gather(stubInput);

    expect(layers.length).toBeGreaterThanOrEqual(1);

    const eventLayer = layers.find((l) =>
      l.summary.includes("product events"),
    );
    expect(eventLayer).toBeDefined();
    expect(eventLayer!.summary).toContain("3 product events");
    expect(eventLayer!.summary).toContain("3 product(s)");

    const crmLayer = layers.find((l) => l.summary.includes("CRM"));
    expect(crmLayer).toBeDefined();
    expect(crmLayer!.summary).toContain("qualified");
    expect(crmLayer!.summary).toContain("score 60");
    expect(crmLayer!.summary).toContain("trajectory");
  });

  it("returns empty layers when no events exist", async () => {
    const client = createMockClient({
      komatik_profiles: [
        { id: "user-2", email: "empty@komatik.xyz" },
      ],
      user_product_events: [],
      crm_contacts: [],
    });

    const adapter = new KomatikHistoryAdapter({ client, userId: "user-2" });
    const layers = await adapter.gather(stubInput);
    expect(layers).toHaveLength(0);
  });

  it("returns events without CRM when contact not found", async () => {
    const client = createMockClient({
      komatik_profiles: [
        { id: "user-3", email: "nocrm@komatik.xyz" },
      ],
      user_product_events: [
        {
          id: "evt-10",
          user_id: "user-3",
          email: "nocrm@komatik.xyz",
          product_slug: "marketplace",
          event_type: "visited",
          metadata: {},
          created_at: hoursAgo(1),
        },
      ],
      crm_contacts: [],
    });

    const adapter = new KomatikHistoryAdapter({ client, userId: "user-3" });
    const layers = await adapter.gather(stubInput);

    expect(layers).toHaveLength(1);
    expect(layers[0]!.summary).toContain("1 product events");
  });

  it("respects maxEvents limit", async () => {
    const events = Array.from({ length: 100 }, (_, i) => ({
      id: `evt-${i}`,
      user_id: "user-4",
      email: "busy@komatik.xyz",
      product_slug: "marketplace",
      event_type: "visited",
      metadata: {},
      created_at: hoursAgo(i),
    }));

    const client = createMockClient({
      komatik_profiles: [{ id: "user-4", email: "busy@komatik.xyz" }],
      user_product_events: events,
      crm_contacts: [],
    });

    const adapter = new KomatikHistoryAdapter({
      client,
      userId: "user-4",
      maxEvents: 10,
    });
    const layers = await adapter.gather(stubInput);

    const eventLayer = layers[0]!;
    const layerEvents = (eventLayer.data as { events: unknown[] }).events;
    expect(layerEvents.length).toBeLessThanOrEqual(10);
  });
});
