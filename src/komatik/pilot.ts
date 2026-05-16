import { randomUUID } from "node:crypto";
import type { EnrichInput } from "../engine/pipeline.js";
import type { ProcessResult } from "../types.js";

export interface PilotRequestContext {
  sourceApp: "forge" | "triage" | "floe" | "platform" | string;
  userId?: string;
  sessionId?: string;
  requestId?: string;
}

export interface PilotProcessTelemetry {
  requestId: string;
  sourceApp: string;
  userId?: string;
  sessionId?: string;
  startedAt: number;
  completedAt: number;
  totalLatencyMs: number;
  modelLatencyMs: number;
  enrichmentLatencyMs: number;
  tokenMultiplier: number;
  tokenOverhead: number;
  governanceInterventions: number;
  blockedAssumptions: number;
  modelProvider: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
}

export interface PilotOutcome {
  requestId: string;
  accepted: boolean;
  reason?: string;
  at: number;
}

export interface PilotRoiSummary {
  totalRequests: number;
  acceptedCount: number;
  acceptanceRate: number;
  avgTotalLatencyMs: number;
  avgEnrichmentLatencyMs: number;
  avgModelLatencyMs: number;
  avgTokenMultiplier: number;
  avgTokenOverhead: number;
  avgGovernanceInterventions: number;
}

export interface PilotTelemetrySink {
  onProcessTelemetry?: (event: PilotProcessTelemetry) => Promise<void> | void;
  onOutcome?: (event: PilotOutcome) => Promise<void> | void;
}

export interface ProcessInvoker {
  process(input: EnrichInput): Promise<ProcessResult>;
}

export interface PilotProcessResult extends ProcessResult {
  pilotTelemetry: PilotProcessTelemetry;
}

export class KomatikPilotProcessor {
  private readonly invoker: ProcessInvoker;
  private readonly sink?: PilotTelemetrySink;
  private readonly processEvents: PilotProcessTelemetry[] = [];
  private readonly outcomes = new Map<string, PilotOutcome>();

  constructor(invoker: ProcessInvoker, sink?: PilotTelemetrySink) {
    this.invoker = invoker;
    this.sink = sink;
  }

  async process(input: EnrichInput, context: PilotRequestContext): Promise<PilotProcessResult> {
    const startedAt = Date.now();
    const startPerf = performance.now();
    const requestId = context.requestId ?? randomUUID();

    const result = await this.invoker.process(input);

    const completedAt = Date.now();
    const totalLatencyMs = performance.now() - startPerf;
    const modelLatencyMs = result.modelResponse.latencyMs;
    const enrichmentLatencyMs = Math.max(0, totalLatencyMs - modelLatencyMs);
    const governance = result.enrichedPrompt.metadata.governance;
    const interventions = governance?.interventions ?? [];
    const blockedAssumptions = interventions.filter((i) => i.type === "assumption-blocked").length;
    const tokens = result.enrichedPrompt.metadata.tokens;
    const tokenMultiplier =
      tokens && tokens.originalMessage > 0
        ? Number((tokens.enrichedMessage / tokens.originalMessage).toFixed(3))
        : 1;
    const tokenOverhead = tokens?.overhead ?? 0;

    const telemetry: PilotProcessTelemetry = {
      requestId,
      sourceApp: context.sourceApp,
      userId: context.userId,
      sessionId: context.sessionId,
      startedAt,
      completedAt,
      totalLatencyMs: Number(totalLatencyMs.toFixed(2)),
      modelLatencyMs,
      enrichmentLatencyMs: Number(enrichmentLatencyMs.toFixed(2)),
      tokenMultiplier,
      tokenOverhead,
      governanceInterventions: interventions.length,
      blockedAssumptions,
      modelProvider: result.modelResponse.provider,
      modelName: result.modelResponse.model,
      inputTokens: result.modelResponse.inputTokens,
      outputTokens: result.modelResponse.outputTokens,
    };

    this.processEvents.push(telemetry);
    await this.sink?.onProcessTelemetry?.(telemetry);

    return {
      ...result,
      pilotTelemetry: telemetry,
    };
  }

  async recordOutcome(input: {
    requestId: string;
    accepted: boolean;
    reason?: string;
    at?: number;
  }): Promise<void> {
    const outcome: PilotOutcome = {
      requestId: input.requestId,
      accepted: input.accepted,
      reason: input.reason,
      at: input.at ?? Date.now(),
    };
    this.outcomes.set(outcome.requestId, outcome);
    await this.sink?.onOutcome?.(outcome);
  }

  summarizeRoi(): PilotRoiSummary {
    const totalRequests = this.processEvents.length;
    const acceptedCount = [...this.outcomes.values()].filter((o) => o.accepted).length;
    const sum = this.processEvents.reduce(
      (acc, event) => {
        acc.totalLatencyMs += event.totalLatencyMs;
        acc.enrichmentLatencyMs += event.enrichmentLatencyMs;
        acc.modelLatencyMs += event.modelLatencyMs;
        acc.tokenMultiplier += event.tokenMultiplier;
        acc.tokenOverhead += event.tokenOverhead;
        acc.governanceInterventions += event.governanceInterventions;
        return acc;
      },
      {
        totalLatencyMs: 0,
        enrichmentLatencyMs: 0,
        modelLatencyMs: 0,
        tokenMultiplier: 0,
        tokenOverhead: 0,
        governanceInterventions: 0,
      },
    );

    const denom = totalRequests || 1;
    return {
      totalRequests,
      acceptedCount,
      acceptanceRate: totalRequests > 0 ? acceptedCount / totalRequests : 0,
      avgTotalLatencyMs: Number((sum.totalLatencyMs / denom).toFixed(2)),
      avgEnrichmentLatencyMs: Number((sum.enrichmentLatencyMs / denom).toFixed(2)),
      avgModelLatencyMs: Number((sum.modelLatencyMs / denom).toFixed(2)),
      avgTokenMultiplier: Number((sum.tokenMultiplier / denom).toFixed(3)),
      avgTokenOverhead: Number((sum.tokenOverhead / denom).toFixed(2)),
      avgGovernanceInterventions: Number((sum.governanceInterventions / denom).toFixed(2)),
    };
  }
}

