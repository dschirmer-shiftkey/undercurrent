import { describe, it, expect } from "vitest";
import { KomatikIdentityAdapter } from "./identity-adapter.js";
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

describe("KomatikIdentityAdapter", () => {
  it("returns user profile context for a known user", async () => {
    const client = createMockClient({
      komatik_profiles: [
        {
          id: "user-1",
          display_name: "David",
          email: "david@komatik.xyz",
          avatar_url: null,
          primary_role: "developer",
          products_used: ["marketplace", "triage", "floe"],
          onboarding_complete: true,
          created_at: "2026-04-01T00:00:00Z",
          updated_at: "2026-04-15T00:00:00Z",
        },
      ],
    });

    const adapter = new KomatikIdentityAdapter({ client, userId: "user-1" });

    expect(await adapter.available()).toBe(true);

    const layers = await adapter.gather(stubInput);
    expect(layers).toHaveLength(1);

    const layer = layers[0]!;
    expect(layer.source).toBe("komatik-identity");
    expect(layer.priority).toBe(0);
    expect(layer.summary).toContain("David");
    expect(layer.summary).toContain("developer");
    expect(layer.summary).toContain("marketplace");
    expect(layer.summary).toContain("Onboarding complete.");

    const profile = (layer.data as { profile: { email: string } }).profile;
    expect(profile.email).toBe("david@komatik.xyz");
  });

  it("returns empty layers for unknown user", async () => {
    const client = createMockClient({ komatik_profiles: [] });
    const adapter = new KomatikIdentityAdapter({
      client,
      userId: "nonexistent",
    });

    const layers = await adapter.gather(stubInput);
    expect(layers).toHaveLength(0);
  });

  it("handles user with no role and no products", async () => {
    const client = createMockClient({
      komatik_profiles: [
        {
          id: "user-2",
          display_name: null,
          email: "new@komatik.xyz",
          avatar_url: null,
          primary_role: null,
          products_used: [],
          onboarding_complete: false,
          created_at: "2026-04-15T00:00:00Z",
          updated_at: "2026-04-15T00:00:00Z",
        },
      ],
    });

    const adapter = new KomatikIdentityAdapter({ client, userId: "user-2" });
    const layers = await adapter.gather(stubInput);

    expect(layers).toHaveLength(1);
    const layer = layers[0]!;
    expect(layer.summary).toContain("new@komatik.xyz");
    expect(layer.summary).toContain("Onboarding not yet complete.");
    expect(layer.summary).not.toContain("developer");
  });

  it("reports unavailable when userId is empty", async () => {
    const client = createMockClient({});
    const adapter = new KomatikIdentityAdapter({ client, userId: "" });
    expect(await adapter.available()).toBe(false);
  });
});
