import { describe, it, expect } from "vitest";
import { KomatikPreferenceAdapter } from "./preference-adapter.js";
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

describe("KomatikPreferenceAdapter", () => {
  it("returns full preference context for a configured user", async () => {
    const client = createMockClient({
      user_preferences: [
        {
          id: "pref-1",
          user_id: "user-1",
          tone: "terse",
          explanation_depth: "minimal",
          response_format: "code-first",
          code_style: {
            language: "TypeScript",
            framework: "Next.js",
            paradigm: "functional",
            indent: "2 spaces",
            other: ["no semicolons", "prefer const"],
          },
          always_assume: [
            "I always mean TypeScript unless I say otherwise",
            "Use ESM imports with .js extension",
          ],
          never_assume: ["Never add comments explaining what code does"],
          created_at: "2026-04-01T00:00:00Z",
          updated_at: "2026-04-15T00:00:00Z",
        },
      ],
    });

    const adapter = new KomatikPreferenceAdapter({ client, userId: "user-1" });
    expect(await adapter.available()).toBe(true);

    const layers = await adapter.gather(stubInput);
    expect(layers).toHaveLength(1);

    const layer = layers[0]!;
    expect(layer.source).toBe("komatik-preferences");
    expect(layer.priority).toBe(0);
    expect(layer.summary).toContain("Tone: terse");
    expect(layer.summary).toContain("Explanation depth: minimal");
    expect(layer.summary).toContain("Response format: code-first");
    expect(layer.summary).toContain("TypeScript");
    expect(layer.summary).toContain("functional");
    expect(layer.summary).toContain("I always mean TypeScript");
    expect(layer.summary).toContain("Never assume");

    const prefs = (layer.data as { preferences: { tone: string } }).preferences;
    expect(prefs.tone).toBe("terse");
  });

  it("returns empty layers when no preferences exist", async () => {
    const client = createMockClient({ user_preferences: [] });
    const adapter = new KomatikPreferenceAdapter({
      client,
      userId: "nonexistent",
    });

    const layers = await adapter.gather(stubInput);
    expect(layers).toHaveLength(0);
  });

  it("handles partial preferences gracefully", async () => {
    const client = createMockClient({
      user_preferences: [
        {
          id: "pref-2",
          user_id: "user-2",
          tone: "casual",
          explanation_depth: null,
          response_format: null,
          code_style: {},
          always_assume: [],
          never_assume: [],
          created_at: "2026-04-15T00:00:00Z",
          updated_at: "2026-04-15T00:00:00Z",
        },
      ],
    });

    const adapter = new KomatikPreferenceAdapter({ client, userId: "user-2" });
    const layers = await adapter.gather(stubInput);

    expect(layers).toHaveLength(1);
    const layer = layers[0]!;
    expect(layer.summary).toContain("Tone: casual");
    expect(layer.summary).not.toContain("Explanation depth");
    expect(layer.summary).not.toContain("Always assume");
  });

  it("reports unavailable when userId is empty", async () => {
    const client = createMockClient({});
    const adapter = new KomatikPreferenceAdapter({ client, userId: "" });
    expect(await adapter.available()).toBe(false);
  });
});
