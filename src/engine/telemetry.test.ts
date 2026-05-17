import { describe, it, expect, vi } from "vitest";
import { Slipstream } from "../index.js";
import { ConversationAdapter } from "../adapters/conversation.js";
import { DefaultStrategy } from "../strategies/default.js";
import { SessionTierBiasLearner } from "./tier-bias-learner.js";
import type { TelemetryEmitter, TelemetrySpan } from "../types.js";

function captureEmitter(spans: TelemetrySpan[]): TelemetryEmitter {
  return {
    emit(span: TelemetrySpan): void {
      spans.push(span);
    },
  };
}

function makeSlipstream(opts: { telemetry?: TelemetryEmitter; learner?: SessionTierBiasLearner } = {}) {
  return new Slipstream({
    adapters: [new ConversationAdapter()],
    strategy: new DefaultStrategy(),
    targetPlatform: "api",
    telemetry: opts.telemetry,
    tierBiasLearner: opts.learner,
  });
}

describe("Telemetry emission", () => {
  describe("opt-out (no emitter configured)", () => {
    it("does not throw when no emitter is provided", async () => {
      const slip = makeSlipstream();
      await expect(slip.enrich({ message: "test", conversation: [] })).resolves.toBeDefined();
    });
  });

  describe("enrich() emission", () => {
    it("emits exactly one slipstream.enrich span per enrich() call", async () => {
      const spans: TelemetrySpan[] = [];
      const slip = makeSlipstream({ telemetry: captureEmitter(spans) });
      await slip.enrich({ message: "fix the auth bug", conversation: [] });

      expect(spans).toHaveLength(1);
      expect(spans[0]!.name).toBe("slipstream.enrich");
      expect(spans[0]!.status).toBe("ok");
    });

    it("populates OTel GenAI convention attributes", async () => {
      const spans: TelemetrySpan[] = [];
      const slip = makeSlipstream({ telemetry: captureEmitter(spans) });
      await slip.enrich({ message: "test", conversation: [] });
      const attrs = spans[0]!.attributes;

      expect(attrs["gen_ai.system"]).toBe("slipstream");
      expect(attrs["gen_ai.operation.name"]).toBe("enrich");
      expect(attrs["gen_ai.request.model"]).toBe("n/a");
      // Slipstream-specific
      expect(attrs["slipstream.enrichment_id"]).toBeTypeOf("string");
      expect(attrs["slipstream.enrichment_depth"]).toBeTypeOf("string");
      expect(attrs["slipstream.preset"]).toBe("balanced");
      expect(attrs["slipstream.target_platform"]).toBe("api");
    });

    it("includes token accounting when available", async () => {
      const spans: TelemetrySpan[] = [];
      const slip = makeSlipstream({ telemetry: captureEmitter(spans) });
      await slip.enrich({ message: "test", conversation: [] });
      const attrs = spans[0]!.attributes;

      expect(attrs["gen_ai.usage.input_tokens"]).toBeTypeOf("number");
      expect(attrs["gen_ai.usage.output_tokens"]).toBeTypeOf("number");
      expect(attrs["slipstream.token_overhead"]).toBeTypeOf("number");
    });

    it("surfaces tier recommendation attributes", async () => {
      const spans: TelemetrySpan[] = [];
      const slip = makeSlipstream({ telemetry: captureEmitter(spans) });
      await slip.enrich({ message: "test", conversation: [] });
      const attrs = spans[0]!.attributes;

      expect(attrs["slipstream.tier_recommended"]).toMatch(/budget|balanced|premium/);
      expect(attrs["slipstream.tier_confidence"]).toBeTypeOf("number");
      expect(attrs["slipstream.tier_bias_applied"]).toBe(false);
    });

    it("surfaces tier_bias_applied=true when learner adjusted the recommendation", async () => {
      const spans: TelemetrySpan[] = [];
      const learner = new SessionTierBiasLearner({ warmThreshold: 3 });
      const slip = makeSlipstream({ telemetry: captureEmitter(spans), learner });
      const userId = "u-1";

      // Drive the learner into a flip path
      for (let i = 0; i < 3; i++) {
        slip.recordTierOutcome({ tier: "balanced", accepted: false, userId });
      }
      for (let i = 0; i < 3; i++) {
        slip.recordTierOutcome({ tier: "premium", accepted: true, userId });
      }

      await slip.enrich({
        message: "test",
        conversation: [],
        enrichmentContext: { userId },
      });
      const attrs = spans[0]!.attributes;
      expect(attrs["slipstream.tier_bias_applied"]).toBe(true);
      expect(attrs["slipstream.tier_bias_reason"]).toBeTypeOf("string");
      expect(attrs["slipstream.tier_bias_original"]).toMatch(/budget|balanced|premium/);
    });

    it("marks slipstream.degraded=false when nothing failed", async () => {
      const spans: TelemetrySpan[] = [];
      const slip = makeSlipstream({ telemetry: captureEmitter(spans) });
      await slip.enrich({ message: "test", conversation: [] });
      expect(spans[0]!.attributes["slipstream.degraded"]).toBe(false);
    });

    it("captures intent signals as attributes", async () => {
      const spans: TelemetrySpan[] = [];
      const slip = makeSlipstream({ telemetry: captureEmitter(spans) });
      await slip.enrich({ message: "fix the auth bug", conversation: [] });
      const attrs = spans[0]!.attributes;

      expect(attrs["slipstream.intent_action"]).toBeTypeOf("string");
      expect(attrs["slipstream.intent_specificity"]).toBeTypeOf("string");
      expect(attrs["slipstream.intent_scope"]).toBeTypeOf("string");
      expect(attrs["slipstream.intent_emotional_load"]).toBeTypeOf("string");
      expect(attrs["slipstream.intent_confidence"]).toBeTypeOf("number");
    });

    it("threads userId from enrichmentContext into the span", async () => {
      const spans: TelemetrySpan[] = [];
      const slip = makeSlipstream({ telemetry: captureEmitter(spans) });
      await slip.enrich({
        message: "test",
        conversation: [],
        enrichmentContext: { userId: "u-42" },
      });
      expect(spans[0]!.attributes["slipstream.user_id"]).toBe("u-42");
    });

    it("emits adapter events", async () => {
      const spans: TelemetrySpan[] = [];
      const slip = makeSlipstream({ telemetry: captureEmitter(spans) });
      await slip.enrich({ message: "test", conversation: [] });
      const events = spans[0]!.events ?? [];
      // ConversationAdapter should produce one adapter.completed event
      expect(events.some((e) => e.name === "adapter.completed")).toBe(true);
      const conversationEvent = events.find(
        (e) => e.attributes?.["slipstream.adapter.name"] === "conversation",
      );
      expect(conversationEvent).toBeDefined();
    });
  });

  describe("emitter resilience", () => {
    it("a throwing emitter does not break enrich()", async () => {
      const throwing: TelemetryEmitter = {
        emit() {
          throw new Error("backend down");
        },
      };
      const slip = makeSlipstream({ telemetry: throwing });
      await expect(slip.enrich({ message: "test", conversation: [] })).resolves.toBeDefined();
    });

    it("an async-rejecting emitter does not break enrich()", async () => {
      const asyncThrowing: TelemetryEmitter = {
        async emit() {
          throw new Error("async backend down");
        },
      };
      const slip = makeSlipstream({ telemetry: asyncThrowing });
      await expect(slip.enrich({ message: "test", conversation: [] })).resolves.toBeDefined();
    });
  });

  describe("span shape", () => {
    it("durationMs equals endedAt - startedAt", async () => {
      const spans: TelemetrySpan[] = [];
      const slip = makeSlipstream({ telemetry: captureEmitter(spans) });
      await slip.enrich({ message: "test", conversation: [] });
      const span = spans[0]!;
      expect(span.durationMs).toBeCloseTo(span.endedAt - span.startedAt, 1);
    });

    it("all attribute values are primitive (string | number | boolean)", async () => {
      const spans: TelemetrySpan[] = [];
      const slip = makeSlipstream({ telemetry: captureEmitter(spans) });
      await slip.enrich({ message: "test", conversation: [] });
      for (const value of Object.values(spans[0]!.attributes)) {
        expect(["string", "number", "boolean"]).toContain(typeof value);
      }
    });

    it("emit() is called exactly once per enrich() (not per adapter)", async () => {
      const emit = vi.fn();
      const slip = makeSlipstream({ telemetry: { emit } });
      await slip.enrich({ message: "test", conversation: [] });
      await slip.enrich({ message: "test 2", conversation: [] });
      expect(emit).toHaveBeenCalledTimes(2);
    });
  });
});
