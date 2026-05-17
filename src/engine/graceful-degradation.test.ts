import { describe, it, expect } from "vitest";
import { Slipstream } from "../index.js";
import { ConversationAdapter } from "../adapters/conversation.js";
import { DefaultStrategy } from "../strategies/default.js";
import type {
  AdapterInput,
  ContextAdapter,
  ContextLayer,
} from "../types.js";

/**
 * Adapter test doubles. Mirror the IDE failure modes:
 *   - flaky: throws on gather() (Supabase auth/RLS/network failure)
 *   - timeout: returns a promise that never resolves
 *   - unavailable: available() returns false (feature flag off / no client)
 *   - throwing-available: available() throws (degraded SupabaseClient init)
 */

function flakyAdapter(name = "flaky-komatik"): ContextAdapter {
  return {
    name,
    priority: 1,
    async available() { return true; },
    async gather() {
      throw new Error("Komatik backend unreachable");
    },
  };
}

function timeoutAdapter(name = "slow-komatik"): ContextAdapter {
  return {
    name,
    priority: 1,
    async available() { return true; },
    async gather(): Promise<ContextLayer[]> {
      return new Promise(() => { /* never resolves */ });
    },
  };
}

function unavailableAdapter(name = "off-komatik"): ContextAdapter {
  return {
    name,
    priority: 1,
    async available() { return false; },
    async gather() { return []; },
  };
}

function throwingAvailableAdapter(name = "broken-init"): ContextAdapter {
  return {
    name,
    priority: 1,
    async available() { throw new Error("client init failed"); },
    async gather() { return []; },
  };
}

function workingAdapter(name = "working", layerSummary = "ok"): ContextAdapter {
  return {
    name,
    priority: 1,
    async available() { return true; },
    async gather(_input: AdapterInput) {
      return [{
        source: name,
        priority: 1,
        timestamp: Date.now(),
        data: { ok: true },
        summary: layerSummary,
      }];
    },
  };
}

function makeSlipstream(adapters: ContextAdapter[], overrides: Record<string, unknown> = {}) {
  return new Slipstream({
    adapters,
    strategy: new DefaultStrategy(),
    targetPlatform: "api",
    ...overrides,
  });
}

describe("graceful degradation — degraded mode (default)", () => {
  it("survives a failing Komatik adapter; surfaces degradation in metadata", async () => {
    const slip = makeSlipstream([
      workingAdapter("local"),       // a working adapter so we still get a layer
      flakyAdapter(),                 // and a failing Komatik-style one
    ]);
    const result = await slip.enrich({ message: "fix the auth bug", conversation: [] });

    expect(result.enrichedMessage).toBeTypeOf("string");
    expect(result.metadata.adapterResults!["flaky-komatik"].status).toBe("error");
    expect(result.metadata.degradation).toBeDefined();
    expect(result.metadata.degradation!.failedAdapters).toBe(1);
    expect(result.metadata.degradation!.failedAdapterNames).toEqual(["flaky-komatik"]);
    expect(result.metadata.degradation!.noContextHarvested).toBe(false);
  });

  it("survives ALL adapters failing; marks noContextHarvested=true", async () => {
    const slip = makeSlipstream([flakyAdapter("a"), flakyAdapter("b"), flakyAdapter("c")]);
    const result = await slip.enrich({ message: "do something", conversation: [] });

    expect(result.metadata.degradation!.failedAdapters).toBe(3);
    expect(result.metadata.degradation!.noContextHarvested).toBe(true);
    expect(result.context).toHaveLength(0);
  });

  it("returns no degradation summary when every adapter succeeds", async () => {
    const slip = makeSlipstream([workingAdapter("a"), workingAdapter("b")]);
    const result = await slip.enrich({ message: "test", conversation: [] });
    expect(result.metadata.degradation).toBeUndefined();
  });

  it("respects per-adapter timeout — a hanging adapter does not block the pipeline", async () => {
    const slip = makeSlipstream(
      [new ConversationAdapter(), timeoutAdapter()],
      { adapterTimeoutMs: 50, timeoutMs: 10_000 },
    );
    const start = Date.now();
    const result = await slip.enrich({ message: "test", conversation: [] });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500); // well under the pipeline timeout
    expect(result.metadata.adapterResults!["slow-komatik"].status).toBe("error");
    expect(result.metadata.adapterResults!["slow-komatik"].error).toMatch(/timeout/i);
    expect(result.metadata.degradation!.timedOutAdapters).toBe(1);
  });

  it("an adapter whose available() throws is excluded but doesn't crash the pipeline", async () => {
    const slip = makeSlipstream([
      new ConversationAdapter(),
      throwingAvailableAdapter(),
    ]);
    const result = await slip.enrich({ message: "test", conversation: [] });

    expect(result.metadata.adapterResults!["broken-init"].status).toBe("error");
    expect(result.metadata.adapterResults!["broken-init"].error).toMatch(/client init failed/);
  });

  it("excluded-via-unavailable adapter shows status=unavailable, not error", async () => {
    const slip = makeSlipstream([
      new ConversationAdapter(),
      unavailableAdapter(),
    ]);
    const result = await slip.enrich({ message: "test", conversation: [] });

    expect(result.metadata.adapterResults!["off-komatik"].status).toBe("unavailable");
    expect(result.metadata.degradation).toBeUndefined(); // unavailable != error
  });
});

describe("graceful degradation — strict mode", () => {
  it("re-throws adapter gather failures in strict mode", async () => {
    const slip = makeSlipstream(
      [flakyAdapter()],
      { failureMode: "strict" },
    );
    await expect(slip.enrich({ message: "test", conversation: [] })).rejects.toThrow(
      /Komatik backend unreachable/,
    );
  });

  it("degraded mode (default) does not throw even when strict would", async () => {
    const slip = makeSlipstream([flakyAdapter()]); // default failureMode = degraded
    const result = await slip.enrich({ message: "test", conversation: [] });
    expect(result.metadata.degradation).toBeDefined();
  });
});

describe("Slipstream.healthCheck()", () => {
  it("returns status=healthy when every adapter is available", async () => {
    const slip = makeSlipstream([workingAdapter("a"), workingAdapter("b")]);
    const health = await slip.healthCheck();

    expect(health.status).toBe("healthy");
    expect(health.adapters).toHaveLength(2);
    expect(health.adapters.every((a) => a.status === "ok")).toBe(true);
    expect(health.totalLatencyMs).toBeGreaterThan(0);
  });

  it("returns status=degraded when some adapters fail and some succeed", async () => {
    const slip = makeSlipstream([workingAdapter("ok"), throwingAvailableAdapter("bad")]);
    const health = await slip.healthCheck();

    expect(health.status).toBe("degraded");
    const byName = Object.fromEntries(health.adapters.map((a) => [a.name, a.status]));
    expect(byName.ok).toBe("ok");
    expect(byName.bad).toBe("error");
  });

  it("returns status=unavailable when zero adapters are ok", async () => {
    const slip = makeSlipstream([throwingAvailableAdapter("a"), throwingAvailableAdapter("b")]);
    const health = await slip.healthCheck();

    expect(health.status).toBe("unavailable");
    expect(health.adapters.every((a) => a.status === "error")).toBe(true);
  });

  it("does not throw on adapter failure — failures are reported in entries", async () => {
    const slip = makeSlipstream([flakyAdapter()]);
    // flakyAdapter throws on gather, but available() returns true → health is "healthy"
    const health = await slip.healthCheck();
    expect(health.status).toBe("healthy");
    // Real failure-mode signal comes from running enrich(), not healthCheck.
  });

  it("respects per-adapter timeout — slow available() check does not hang", async () => {
    const slowAvailable: ContextAdapter = {
      name: "slow-available",
      priority: 1,
      async available() {
        return new Promise(() => { /* never */ });
      },
      async gather() { return []; },
    };
    const slip = makeSlipstream(
      [workingAdapter("fast"), slowAvailable],
      { adapterTimeoutMs: 50 },
    );
    const start = Date.now();
    const health = await slip.healthCheck();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    const slowEntry = health.adapters.find((a) => a.name === "slow-available")!;
    expect(slowEntry.status).toBe("error");
    expect(slowEntry.error).toMatch(/timeout/i);
  });

  it("reports unavailable status when zero adapters are configured", async () => {
    const slip = makeSlipstream([]);
    const health = await slip.healthCheck();
    expect(health.status).toBe("unavailable");
    expect(health.adapters).toHaveLength(0);
  });
});
