import { describe, it, expect, vi } from "vitest";
import { Pipeline } from "./pipeline.js";
import { DefaultStrategy } from "../strategies/default.js";
import type {
  ContextAdapter,
  ContextLayer,
  EnrichedPrompt,
  UndercurrentConfig,
} from "../types.js";

function makeConfig(overrides: Partial<UndercurrentConfig> = {}): UndercurrentConfig {
  return {
    adapters: [],
    strategy: new DefaultStrategy(),
    ...overrides,
  };
}

function stubAdapter(
  name: string,
  layers: ContextLayer[] = [],
  opts: { available?: boolean; priority?: number } = {},
): ContextAdapter {
  return {
    name,
    priority: opts.priority ?? 1,
    available: async () => opts.available ?? true,
    gather: async () => layers,
  };
}

describe("Pipeline", () => {
  it("returns an EnrichedPrompt for a simple message", async () => {
    const pipeline = new Pipeline(makeConfig());
    const result = await pipeline.enrich({ message: "fix the login bug on line 42 of auth.ts" });

    expect(result.originalMessage).toBe("fix the login bug on line 42 of auth.ts");
    expect(result.intent.action).toBe("fix");
    expect(result.metadata.strategyUsed).toBe("default");
    expect(result.metadata.pipelineVersion).toBe("0.2.0");
    expect(result.metadata.processingTimeMs).toBeGreaterThan(0);
  });

  it("passes through high-specificity atomic requests without enrichment", async () => {
    const pipeline = new Pipeline(makeConfig());
    const result = await pipeline.enrich({
      message: "fix the `calculateTotal` function on line 15 of utils.ts — it returns NaN",
    });

    expect(result.metadata.enrichmentDepth).toBe("none");
    expect(result.enrichedMessage).toBe(result.originalMessage);
    expect(result.context).toEqual([]);
    expect(result.gaps).toEqual([]);
  });

  it("performs deep enrichment for vague messages", async () => {
    const pipeline = new Pipeline(makeConfig());
    const result = await pipeline.enrich({
      message: "the thing is broken somehow",
    });

    expect(result.metadata.enrichmentDepth).toBe("deep");
    expect(result.enrichedMessage).not.toBe(result.originalMessage);
    expect(result.intent.specificity).toBe("low");
  });

  it("collects context from available adapters", async () => {
    const layer: ContextLayer = {
      source: "test-adapter",
      priority: 1,
      timestamp: Date.now(),
      data: { branch: "feature/login" },
      summary: "Currently on feature/login branch with 3 uncommitted files",
    };

    const adapter = stubAdapter("test-adapter", [layer]);
    const pipeline = new Pipeline(makeConfig({ adapters: [adapter] }));

    const result = await pipeline.enrich({ message: "something is off with the api" });

    expect(result.context).toHaveLength(1);
    expect(result.context[0].source).toBe("test-adapter");
    expect(result.metadata.adapterTimings["test-adapter"]).toBeGreaterThanOrEqual(0);
  });

  it("skips unavailable adapters gracefully", async () => {
    const available = stubAdapter("live", [
      { source: "live", priority: 1, timestamp: Date.now(), data: {}, summary: "live context" },
    ]);
    const unavailable = stubAdapter("dead", [], { available: false });

    const pipeline = new Pipeline(makeConfig({ adapters: [unavailable, available] }));
    const result = await pipeline.enrich({ message: "i need to think about the database" });

    expect(result.context).toHaveLength(1);
    expect(result.context[0].source).toBe("live");
  });

  it("survives adapter failures without crashing", async () => {
    const failing: ContextAdapter = {
      name: "failing",
      priority: 1,
      available: async () => true,
      gather: async () => {
        throw new Error("adapter exploded");
      },
    };

    const pipeline = new Pipeline(makeConfig({ adapters: [failing] }));
    const result = await pipeline.enrich({ message: "check the deploy pipeline" });

    expect(result.context).toEqual([]);
    expect(result.enrichedMessage).toBeTruthy();
  });

  it("respects maxClarifications limit", async () => {
    const pipeline = new Pipeline(makeConfig({ maxClarifications: 1 }));
    const result = await pipeline.enrich({
      message: "it broke and that thing stopped and this other system is weird",
    });

    expect(result.clarifications.length).toBeLessThanOrEqual(1);
  });

  it("fires pipeline hooks in order", async () => {
    const calls: string[] = [];

    const pipeline = new Pipeline(makeConfig());
    pipeline.setHooks({
      beforeClassify: () => calls.push("beforeClassify"),
      afterClassify: () => calls.push("afterClassify"),
      beforeGather: () => calls.push("beforeGather"),
      afterGather: () => calls.push("afterGather"),
      beforeAnalyze: () => calls.push("beforeAnalyze"),
      afterAnalyze: () => calls.push("afterAnalyze"),
      beforeCompose: () => calls.push("beforeCompose"),
      afterCompose: () => calls.push("afterCompose"),
    });

    await pipeline.enrich({ message: "maybe we should redesign the auth system" });

    expect(calls).toEqual([
      "beforeClassify",
      "afterClassify",
      "beforeGather",
      "afterGather",
      "beforeAnalyze",
      "afterAnalyze",
      "beforeCompose",
      "afterCompose",
    ]);
  });

  it("invokes onEnrichment callback", async () => {
    const spy = vi.fn();
    const pipeline = new Pipeline(makeConfig({ onEnrichment: spy }));

    await pipeline.enrich({ message: "build a new landing page" });

    expect(spy).toHaveBeenCalledOnce();
    const result: EnrichedPrompt = spy.mock.calls[0][0];
    expect(result.originalMessage).toBe("build a new landing page");
  });

  it("sorts adapters by priority", async () => {
    const order: string[] = [];

    const low: ContextAdapter = {
      name: "low-priority",
      priority: 10,
      available: async () => true,
      gather: async () => {
        order.push("low");
        return [
          { source: "low-priority", priority: 10, timestamp: Date.now(), data: {}, summary: "low" },
        ];
      },
    };

    const high: ContextAdapter = {
      name: "high-priority",
      priority: 1,
      available: async () => true,
      gather: async () => {
        order.push("high");
        return [
          {
            source: "high-priority",
            priority: 1,
            timestamp: Date.now(),
            data: {},
            summary: "high",
          },
        ];
      },
    };

    const pipeline = new Pipeline(makeConfig({ adapters: [low, high] }));
    const result = await pipeline.enrich({ message: "what is the state of the project" });

    expect(result.context[0].source).toBe("high-priority");
    expect(result.context[1].source).toBe("low-priority");
  });

  describe("adapter result tracking", () => {
    it("reports 'ok' for adapters that return layers", async () => {
      const layer: ContextLayer = {
        source: "good-adapter",
        priority: 1,
        timestamp: Date.now(),
        data: { branch: "main" },
        summary: "On main branch",
      };
      const adapter = stubAdapter("good-adapter", [layer]);
      const pipeline = new Pipeline(makeConfig({ adapters: [adapter] }));

      const result = await pipeline.enrich({ message: "something is off with the api" });

      expect(result.metadata.adapterResults).toBeDefined();
      expect(result.metadata.adapterResults!["good-adapter"]).toEqual({
        status: "ok",
        layerCount: 1,
      });
    });

    it("reports 'empty' for adapters that return zero layers", async () => {
      const adapter = stubAdapter("empty-adapter", []);
      const pipeline = new Pipeline(makeConfig({ adapters: [adapter] }));

      const result = await pipeline.enrich({ message: "something is off with the api" });

      expect(result.metadata.adapterResults!["empty-adapter"]).toEqual({
        status: "empty",
        layerCount: 0,
      });
    });

    it("reports 'unavailable' for adapters where available() returns false", async () => {
      const adapter = stubAdapter("dead-adapter", [], { available: false });
      const pipeline = new Pipeline(makeConfig({ adapters: [adapter] }));

      const result = await pipeline.enrich({ message: "something is off with the api" });

      expect(result.metadata.adapterResults!["dead-adapter"]).toEqual({
        status: "unavailable",
        layerCount: 0,
      });
    });

    it("reports 'error' for adapters that throw during gather()", async () => {
      const failing: ContextAdapter = {
        name: "failing-adapter",
        priority: 1,
        available: async () => true,
        gather: async () => {
          throw new Error("db connection lost");
        },
      };
      const pipeline = new Pipeline(makeConfig({ adapters: [failing] }));

      const result = await pipeline.enrich({ message: "check the deploy pipeline" });

      expect(result.metadata.adapterResults!["failing-adapter"]).toEqual({
        status: "error",
        layerCount: 0,
        error: "db connection lost",
      });
    });

    it("reports 'error' for adapters that throw during available()", async () => {
      const broken: ContextAdapter = {
        name: "broken-adapter",
        priority: 1,
        available: async () => {
          throw new Error("init failed");
        },
        gather: async () => [],
      };
      const pipeline = new Pipeline(makeConfig({ adapters: [broken] }));

      const result = await pipeline.enrich({ message: "check the deploy pipeline" });

      expect(result.metadata.adapterResults!["broken-adapter"]).toEqual({
        status: "error",
        layerCount: 0,
        error: "availability check failed: init failed",
      });
    });

    it("tracks results for mixed adapter states", async () => {
      const okLayer: ContextLayer = {
        source: "ok-adapter",
        priority: 1,
        timestamp: Date.now(),
        data: {},
        summary: "good data",
      };
      const ok = stubAdapter("ok-adapter", [okLayer]);
      const empty = stubAdapter("empty-adapter", []);
      const unavail = stubAdapter("unavail-adapter", [], { available: false });
      const failing: ContextAdapter = {
        name: "failing-adapter",
        priority: 1,
        available: async () => true,
        gather: async () => {
          throw new Error("timeout");
        },
      };

      const pipeline = new Pipeline(
        makeConfig({ adapters: [ok, empty, unavail, failing] }),
      );
      const result = await pipeline.enrich({ message: "something is off with the api" });

      const ar = result.metadata.adapterResults!;
      expect(ar["ok-adapter"].status).toBe("ok");
      expect(ar["empty-adapter"].status).toBe("empty");
      expect(ar["unavail-adapter"].status).toBe("unavailable");
      expect(ar["failing-adapter"].status).toBe("error");
    });

    it("omits adapterResults from passthrough (depth=none) enrichments", async () => {
      const pipeline = new Pipeline(makeConfig());
      const result = await pipeline.enrich({
        message:
          "fix the `calculateTotal` function on line 15 of utils.ts — it returns NaN",
      });

      expect(result.metadata.enrichmentDepth).toBe("none");
      expect(result.metadata.adapterResults).toBeUndefined();
    });
  });

  describe("token accounting", () => {
    it("reports tokens metadata on enriched results", async () => {
      const adapter = stubAdapter("ctx", [
        {
          source: "ctx",
          priority: 1,
          timestamp: Date.now(),
          data: { foo: "bar" },
          summary: "some context summary text",
        },
      ]);
      const pipeline = new Pipeline(makeConfig({ adapters: [adapter] }));
      const result = await pipeline.enrich({
        message: "help me think through this approach",
      });

      expect(result.metadata.tokens).toBeDefined();
      const t = result.metadata.tokens!;
      expect(t.originalMessage).toBeGreaterThan(0);
      expect(t.enrichedMessage).toBeGreaterThanOrEqual(t.originalMessage);
      expect(t.context).toBeGreaterThan(0);
      expect(t.contextByAdapter["ctx"]).toBeGreaterThan(0);
      expect(t.overhead).toBe(t.enrichedMessage - t.originalMessage);
    });

    it("reports tokens metadata on passthrough results", async () => {
      const pipeline = new Pipeline(makeConfig());
      const result = await pipeline.enrich({
        message:
          "fix the `calculateTotal` function on line 15 of utils.ts — it returns NaN",
      });

      expect(result.metadata.enrichmentDepth).toBe("none");
      expect(result.metadata.tokens).toBeDefined();
      expect(result.metadata.tokens!.context).toBe(0);
      expect(result.metadata.tokens!.overhead).toBe(0);
    });
  });
});
