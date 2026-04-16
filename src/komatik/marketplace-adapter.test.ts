import { describe, it, expect } from "vitest";
import { KomatikMarketplaceAdapter } from "./marketplace-adapter.js";
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
  message: "check marketplace",
  intent: stubIntent,
  conversation: [],
  existingContext: [],
};

describe("KomatikMarketplaceAdapter", () => {
  it("returns usage and authored tools context", async () => {
    const client = createMockClient({
      forge_usage: [
        {
          id: "use-1",
          tool_id: "tool-a",
          consumer_id: "user-1",
          latency_ms: 120,
          success: true,
          cost_cents: 0.5,
          created_at: "2026-04-15T10:00:00Z",
        },
        {
          id: "use-2",
          tool_id: "tool-a",
          consumer_id: "user-1",
          latency_ms: 95,
          success: true,
          cost_cents: 0.5,
          created_at: "2026-04-15T11:00:00Z",
        },
        {
          id: "use-3",
          tool_id: "tool-b",
          consumer_id: "user-1",
          latency_ms: 200,
          success: false,
          cost_cents: 0,
          created_at: "2026-04-15T12:00:00Z",
        },
      ],
      forge_tools: [
        {
          id: "tool-x",
          author_id: "user-1",
          author_email: "dev@komatik.xyz",
          slug: "code-linter",
          name: "Code Linter",
          tagline: "Lint your code",
          description: "A fast linter",
          server_url: "https://example.com",
          category: "code",
          tags: ["lint"],
          pricing_model: "free",
          status: "active",
          is_verified: true,
          trust_score: 0.85,
          total_calls: 1200,
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-04-15T00:00:00Z",
        },
      ],
    });

    const adapter = new KomatikMarketplaceAdapter({
      client,
      userId: "user-1",
    });
    const layers = await adapter.gather(stubInput);

    expect(layers).toHaveLength(1);
    const layer = layers[0]!;
    expect(layer.source).toBe("komatik-marketplace");
    expect(layer.summary).toContain("2 Forge tool(s)");
    expect(layer.summary).toContain("3 calls");
    expect(layer.summary).toContain("67% success");
    expect(layer.summary).toContain("Authored 1 tool(s)");
    expect(layer.summary).toContain("Code Linter");
  });

  it("returns empty layers when no marketplace activity", async () => {
    const client = createMockClient({
      forge_usage: [],
      forge_tools: [],
    });

    const adapter = new KomatikMarketplaceAdapter({
      client,
      userId: "user-2",
    });
    const layers = await adapter.gather(stubInput);
    expect(layers).toHaveLength(0);
  });

  it("handles usage-only without authored tools", async () => {
    const client = createMockClient({
      forge_usage: [
        {
          id: "use-10",
          tool_id: "tool-z",
          consumer_id: "user-3",
          latency_ms: 50,
          success: true,
          cost_cents: 0,
          created_at: "2026-04-15T08:00:00Z",
        },
      ],
      forge_tools: [],
    });

    const adapter = new KomatikMarketplaceAdapter({
      client,
      userId: "user-3",
    });
    const layers = await adapter.gather(stubInput);

    expect(layers).toHaveLength(1);
    expect(layers[0]!.summary).toContain("1 Forge tool(s)");
    expect(layers[0]!.summary).toContain("100% success");
    expect(layers[0]!.summary).not.toContain("Authored");
  });

  it("handles authored tools without usage", async () => {
    const client = createMockClient({
      forge_usage: [],
      forge_tools: [
        {
          id: "tool-solo",
          author_id: "user-4",
          author_email: "author@komatik.xyz",
          slug: "my-tool",
          name: "My Tool",
          tagline: "Does stuff",
          description: null,
          server_url: "https://example.com",
          category: "general",
          tags: [],
          pricing_model: "free",
          status: "pending_review",
          is_verified: false,
          trust_score: 0.5,
          total_calls: 0,
          created_at: "2026-04-15T00:00:00Z",
          updated_at: "2026-04-15T00:00:00Z",
        },
      ],
    });

    const adapter = new KomatikMarketplaceAdapter({
      client,
      userId: "user-4",
    });
    const layers = await adapter.gather(stubInput);

    expect(layers).toHaveLength(1);
    expect(layers[0]!.summary).toContain("Authored 1 tool(s)");
    expect(layers[0]!.summary).toContain("0 active");
  });
});
