import { describe, it, expect } from "vitest";
import { ConversationAdapter } from "./conversation.js";
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

function makeInput(
  conversation: AdapterInput["conversation"],
  message = "test message",
): AdapterInput {
  return { message, intent: stubIntent, conversation, existingContext: [] };
}

describe("ConversationAdapter", () => {
  it("always reports available", async () => {
    const adapter = new ConversationAdapter();
    expect(await adapter.available()).toBe(true);
  });

  it("has correct name and priority", () => {
    const adapter = new ConversationAdapter();
    expect(adapter.name).toBe("conversation");
    expect(adapter.priority).toBe(1);
  });

  it("returns empty layers for empty conversation", async () => {
    const adapter = new ConversationAdapter();
    const layers = await adapter.gather(makeInput([]));
    expect(layers).toEqual([]);
  });

  describe("decision extraction", () => {
    it("detects 'let's go with' decisions", async () => {
      const adapter = new ConversationAdapter();
      const layers = await adapter.gather(
        makeInput([{ role: "user", content: "Let's go with React for the frontend." }]),
      );

      const decisionLayer = layers.find((l) => l.summary.includes("prior decision"));
      expect(decisionLayer).toBeDefined();
      expect(decisionLayer!.summary).toContain("1 prior decision");
    });

    it("detects 'decided to' decisions", async () => {
      const adapter = new ConversationAdapter();
      const layers = await adapter.gather(
        makeInput([{ role: "user", content: "We decided to use PostgreSQL instead." }]),
      );

      const decisionLayer = layers.find((l) => l.summary.includes("prior decision"));
      expect(decisionLayer).toBeDefined();
    });

    it("detects 'scratch that' reversals", async () => {
      const adapter = new ConversationAdapter();
      const layers = await adapter.gather(
        makeInput([{ role: "user", content: "Scratch that, let's try a different approach." }]),
      );

      const decisionLayer = layers.find((l) => l.summary.includes("prior decision"));
      expect(decisionLayer).toBeDefined();
    });

    it("detects affirmation patterns", async () => {
      const adapter = new ConversationAdapter();
      const layers = await adapter.gather(
        makeInput([{ role: "assistant", content: "Yes, that's correct." }]),
      );

      const decisionLayer = layers.find((l) => l.summary.includes("prior decision"));
      expect(decisionLayer).toBeDefined();
    });

    it("truncates long decision summaries to 200 chars", async () => {
      const adapter = new ConversationAdapter();
      const longSentence = "I decided to " + "x".repeat(300);
      const layers = await adapter.gather(makeInput([{ role: "user", content: longSentence }]));

      const decisionLayer = layers.find((l) => l.summary.includes("prior decision"));
      expect(decisionLayer).toBeDefined();
      const decisions = (decisionLayer!.data as { decisions: Array<{ summary: string }> })
        .decisions;
      expect(decisions[0]!.summary.length).toBeLessThanOrEqual(200);
    });
  });

  describe("topic trajectory", () => {
    it("extracts topic trajectory from user turns only", async () => {
      const adapter = new ConversationAdapter();
      const layers = await adapter.gather(
        makeInput([
          { role: "user", content: "Working on the authentication module" },
          { role: "assistant", content: "I see the auth module has some issues" },
          { role: "user", content: "Now let's focus on the database migration" },
        ]),
      );

      const topicLayer = layers.find((l) => l.summary.includes("Topic trajectory"));
      expect(topicLayer).toBeDefined();
      expect(topicLayer!.summary).toContain("→");
    });

    it("limits trajectory to last 5 topics", async () => {
      const adapter = new ConversationAdapter();
      const turns = Array.from({ length: 10 }, (_, i) => ({
        role: "user" as const,
        content: `Working on completely different topic number ${i} with extra words`,
      }));
      const layers = await adapter.gather(makeInput(turns));

      const topicLayer = layers.find((l) => l.summary.includes("Topic trajectory"));
      if (topicLayer) {
        const topics = (topicLayer.data as { topics: string[] }).topics;
        expect(topics.length).toBeLessThanOrEqual(5);
      }
    });
  });

  describe("terminology extraction", () => {
    it("extracts backtick-quoted terms that appear 2+ times", async () => {
      const adapter = new ConversationAdapter();
      const layers = await adapter.gather(
        makeInput([
          { role: "user", content: "The `calculateTotal` function is broken" },
          { role: "assistant", content: "I see `calculateTotal` has a bug" },
        ]),
      );

      const termLayer = layers.find((l) => l.summary.includes("Established terms"));
      expect(termLayer).toBeDefined();
      expect(termLayer!.summary).toContain("calculateTotal");
    });

    it("extracts hyphenated terms that appear 2+ times", async () => {
      const adapter = new ConversationAdapter();
      const layers = await adapter.gather(
        makeInput([
          { role: "user", content: "The auth-middleware needs fixing" },
          { role: "assistant", content: "I'll update the auth-middleware now" },
        ]),
      );

      const termLayer = layers.find((l) => l.summary.includes("Established terms"));
      expect(termLayer).toBeDefined();
      expect(termLayer!.summary).toContain("auth-middleware");
    });

    it("ignores terms that appear only once", async () => {
      const adapter = new ConversationAdapter();
      const layers = await adapter.gather(
        makeInput([
          { role: "user", content: "The `uniqueFunction` is fine" },
          { role: "assistant", content: "Nothing to do there" },
        ]),
      );

      const termLayer = layers.find((l) => l.summary.includes("Established terms"));
      expect(termLayer).toBeUndefined();
    });
  });

  describe("maxTurnsToAnalyze", () => {
    it("limits how many turns are analyzed", async () => {
      const adapter = new ConversationAdapter({ maxTurnsToAnalyze: 2 });
      const turns = [
        { role: "user" as const, content: "Let's go with Vue for the frontend" },
        { role: "user" as const, content: "Some neutral message with words" },
        { role: "user" as const, content: "Another neutral message with words" },
      ];
      const layers = await adapter.gather(makeInput(turns));

      const decisionLayer = layers.find((l) => l.summary.includes("prior decision"));
      expect(decisionLayer).toBeUndefined();
    });
  });

  it("produces multiple layer types from a rich conversation", async () => {
    const adapter = new ConversationAdapter();
    const layers = await adapter.gather(
      makeInput([
        { role: "user", content: "Let's use `auth-service` for the login flow" },
        { role: "assistant", content: "I'll set up `auth-service` with JWT" },
        { role: "user", content: "Actually, let's switch to the payment-gateway module" },
        { role: "assistant", content: "The `auth-service` can integrate with payment-gateway" },
      ]),
    );

    expect(layers.length).toBeGreaterThanOrEqual(2);
    const sources = layers.map((l) => l.source);
    expect(sources.every((s) => s === "conversation")).toBe(true);
  });
});
