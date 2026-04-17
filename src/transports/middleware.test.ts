import { describe, it, expect, vi } from "vitest";
import { createMiddleware, createFetchHandler } from "./middleware.js";
import type { Pipeline } from "../engine/pipeline.js";
import type { EnrichedPrompt, IntentSignal } from "../types.js";

const stubIntent: IntentSignal = {
  action: "fix",
  specificity: "medium",
  scope: "local",
  emotionalLoad: "neutral",
  confidence: 0.8,
  rawFragments: [],
  domainHints: [],
};

const stubEnrichedPrompt: EnrichedPrompt = {
  originalMessage: "fix the bug",
  intent: stubIntent,
  context: [],
  gaps: [],
  assumptions: [],
  clarifications: [],
  enrichedMessage: "[Original]: fix the bug\n[Intent]: fix",
  metadata: {
    strategyUsed: "default",
    pipelineVersion: "0.1.0",
    processingTimeMs: 5,
    enrichmentDepth: "standard",
    adapterTimings: {},
    totalAdaptersRun: 0,
    adaptersSucceeded: 0,
    adaptersFailed: 0,
  },
};

function mockPipeline(result: EnrichedPrompt = stubEnrichedPrompt): Pipeline {
  return {
    enrich: vi.fn().mockResolvedValue(result),
  } as unknown as Pipeline;
}

describe("createMiddleware", () => {
  it("calls next() when no message in body", async () => {
    const pipeline = mockPipeline();
    const middleware = createMiddleware(pipeline);
    const req = { body: {} };
    const res = {};
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
    expect(pipeline.enrich).not.toHaveBeenCalled();
  });

  it("calls next() when body is undefined", async () => {
    const pipeline = mockPipeline();
    const middleware = createMiddleware(pipeline);
    const req = {};
    const res = {};
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(pipeline.enrich).not.toHaveBeenCalled();
  });

  it("enriches message and attaches to req.undercurrent", async () => {
    const pipeline = mockPipeline();
    const middleware = createMiddleware(pipeline);
    const req = {
      body: {
        message: "fix the bug",
        conversation: [{ role: "user", content: "help" }],
      },
    } as Record<string, unknown>;
    const res = {};
    const next = vi.fn();

    await middleware(req, res, next);

    expect(pipeline.enrich).toHaveBeenCalledWith({
      message: "fix the bug",
      conversation: [{ role: "user", content: "help" }],
    });
    expect((req as { undercurrent?: EnrichedPrompt }).undercurrent).toBe(stubEnrichedPrompt);
    expect(next).toHaveBeenCalledWith();
  });

  it("calls onError and next(error) when pipeline throws", async () => {
    const error = new Error("pipeline failed");
    const pipeline = {
      enrich: vi.fn().mockRejectedValue(error),
    } as unknown as Pipeline;
    const onError = vi.fn();
    const middleware = createMiddleware(pipeline, { onError });
    const req = { body: { message: "test" } };
    const res = {};
    const next = vi.fn();

    await middleware(req, res, next);

    expect(onError).toHaveBeenCalledWith(error);
    expect(next).toHaveBeenCalledWith(error);
  });

  it("supports custom extractMessage", async () => {
    const pipeline = mockPipeline();
    const middleware = createMiddleware(pipeline, {
      extractMessage: (req) => {
        const r = req as { query?: { msg?: string } };
        return r.query?.msg ? { message: r.query.msg } : null;
      },
    });
    const req = { query: { msg: "custom extraction" } };
    const res = {};
    const next = vi.fn();

    await middleware(req, res, next);

    expect(pipeline.enrich).toHaveBeenCalledWith({
      message: "custom extraction",
    });
  });

  it("supports custom attachResult", async () => {
    const pipeline = mockPipeline();
    const middleware = createMiddleware(pipeline, {
      attachResult: (req, result) => {
        (req as Record<string, unknown>).enrichment = result;
      },
    });
    const req = { body: { message: "test" } } as Record<string, unknown>;
    const res = {};
    const next = vi.fn();

    await middleware(req, res, next);

    expect(req.enrichment).toBe(stubEnrichedPrompt);
    expect((req as { undercurrent?: unknown }).undercurrent).toBeUndefined();
  });
});

describe("createFetchHandler", () => {
  function makeRequest(body: unknown): Request {
    return {
      json: async () => body,
    } as unknown as Request;
  }

  it("returns null enrichment when no message in body", async () => {
    const pipeline = mockPipeline();
    const handler = createFetchHandler(pipeline);
    const result = await handler(makeRequest({ foo: "bar" }));

    expect(result.enriched).toBeNull();
    expect(result.body).toEqual({ foo: "bar" });
    expect(pipeline.enrich).not.toHaveBeenCalled();
  });

  it("enriches and returns result for valid message", async () => {
    const pipeline = mockPipeline();
    const handler = createFetchHandler(pipeline);
    const result = await handler(
      makeRequest({
        message: "fix the bug",
        conversation: [{ role: "user", content: "help" }],
      }),
    );

    expect(result.enriched).toBe(stubEnrichedPrompt);
    expect(result.body.message).toBe("fix the bug");
    expect(pipeline.enrich).toHaveBeenCalledWith({
      message: "fix the bug",
      conversation: [{ role: "user", content: "help" }],
    });
  });

  it("passes undefined conversation when not provided", async () => {
    const pipeline = mockPipeline();
    const handler = createFetchHandler(pipeline);
    await handler(makeRequest({ message: "hello" }));

    expect(pipeline.enrich).toHaveBeenCalledWith({
      message: "hello",
      conversation: undefined,
    });
  });
});
