import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Undercurrent } from "../index.js";
import { ConversationAdapter } from "../adapters/conversation.js";
import { GitAdapter } from "../adapters/git.js";
import { FilesystemAdapter } from "../adapters/filesystem.js";
import { DefaultStrategy } from "../strategies/default.js";
import { parseTranscript } from "./transcript-parser.js";
import type { TargetPlatform } from "../types.js";

interface GateMetrics {
  totalMessages: number;
  depthDistribution: Record<string, number>;
  tokenMultiplier: number;
  interventionsPerMessage: number;
  blockedAssumptionRate: number;
}

interface ReliabilityBaseline {
  generatedAt: string;
  dataset: string[];
  platform: TargetPlatform;
  baseline: GateMetrics;
  thresholds: {
    maxTokenMultiplier: number;
    maxDepthDriftL1: number;
    minInterventionsPerMessage: number;
    maxInterventionsPerMessage: number;
    maxBlockedAssumptionRate: number;
  };
}

function createPipeline(platform: TargetPlatform): Undercurrent {
  return new Undercurrent({
    adapters: [
      new ConversationAdapter(),
      new GitAdapter({ cwd: process.cwd() }),
      new FilesystemAdapter({ root: "./src" }),
    ],
    strategy: new DefaultStrategy(),
    targetPlatform: platform,
  });
}

function parseArgs(argv: string[]): {
  baselinePath: string;
  transcripts: string[];
  platform: TargetPlatform;
  writeBaseline: boolean;
} {
  let baselinePath = "ci/reliability-baseline.json";
  const transcripts: string[] = [];
  let platform: TargetPlatform = "generic";
  let writeBaseline = false;

  for (let idx = 0; idx < argv.length; idx++) {
    const arg = argv[idx]!;
    if (arg === "--baseline" && argv[idx + 1]) baselinePath = argv[++idx]!;
    else if (arg === "--transcript" && argv[idx + 1]) transcripts.push(argv[++idx]!);
    else if (arg === "--platform" && argv[idx + 1]) platform = argv[++idx]! as TargetPlatform;
    else if (arg === "--write-baseline") writeBaseline = true;
  }

  if (transcripts.length === 0) {
    transcripts.push("fixtures/replay/reliability-ci.jsonl");
  }

  return {
    baselinePath,
    transcripts,
    platform,
    writeBaseline,
  };
}

async function computeMetrics(
  pipeline: Undercurrent,
  transcripts: string[],
  platform: TargetPlatform,
): Promise<GateMetrics> {
  let totalMessages = 0;
  let totalOriginalTokens = 0;
  let totalEnrichedTokens = 0;
  let interventions = 0;
  let blocked = 0;
  let assumptionsBefore = 0;
  const depthDistribution: Record<string, number> = {};

  for (const transcript of transcripts) {
    const entries = await parseTranscript(transcript);
    for (const entry of entries) {
      const result = await pipeline.enrich({
        message: entry.rawMessage,
        conversation: entry.conversationSoFar,
        targetPlatform: platform,
      });
      totalMessages++;

      const depth = result.metadata.enrichmentDepth;
      depthDistribution[depth] = (depthDistribution[depth] ?? 0) + 1;

      if (result.metadata.tokens) {
        totalOriginalTokens += result.metadata.tokens.originalMessage;
        totalEnrichedTokens += result.metadata.tokens.enrichedMessage;
      }
      const gov = result.metadata.governance;
      if (gov) {
        interventions += gov.interventions.length;
        blocked += gov.interventions.filter((i) => i.type === "assumption-blocked").length;
        assumptionsBefore += gov.assumptionsBefore;
      }
    }
  }

  const messageDenom = totalMessages || 1;
  const assumptionDenom = assumptionsBefore || 1;
  return {
    totalMessages,
    depthDistribution,
    tokenMultiplier: totalOriginalTokens > 0 ? totalEnrichedTokens / totalOriginalTokens : 1,
    interventionsPerMessage: interventions / messageDenom,
    blockedAssumptionRate: blocked / assumptionDenom,
  };
}

function depthShare(metrics: GateMetrics): Record<string, number> {
  const total = metrics.totalMessages || 1;
  const allDepths = ["none", "light", "standard", "deep"];
  const out: Record<string, number> = {};
  for (const depth of allDepths) {
    out[depth] = (metrics.depthDistribution[depth] ?? 0) / total;
  }
  return out;
}

function depthDriftL1(a: GateMetrics, b: GateMetrics): number {
  const da = depthShare(a);
  const db = depthShare(b);
  return ["none", "light", "standard", "deep"].reduce(
    (sum, depth) => sum + Math.abs((da[depth] ?? 0) - (db[depth] ?? 0)),
    0,
  );
}

function printMetrics(label: string, metrics: GateMetrics): void {
  console.log(`\n${label}`);
  console.log(`  messages: ${metrics.totalMessages}`);
  console.log(`  tokenMultiplier: ${metrics.tokenMultiplier.toFixed(3)}x`);
  console.log(`  interventions/message: ${metrics.interventionsPerMessage.toFixed(3)}`);
  console.log(`  blockedAssumptionRate: ${metrics.blockedAssumptionRate.toFixed(3)}`);
  console.log(`  depth: ${JSON.stringify(metrics.depthDistribution)}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const resolvedTranscripts = args.transcripts.map((p) => resolve(p));
  const pipeline = createPipeline(args.platform);
  const current = await computeMetrics(pipeline, resolvedTranscripts, args.platform);

  if (args.writeBaseline) {
    const baseline: ReliabilityBaseline = {
      generatedAt: new Date().toISOString(),
      dataset: args.transcripts,
      platform: args.platform,
      baseline: current,
      thresholds: {
        maxTokenMultiplier: Number((current.tokenMultiplier + 0.75).toFixed(3)),
        maxDepthDriftL1: 0.55,
        minInterventionsPerMessage: Math.max(
          0,
          Number((current.interventionsPerMessage - 0.6).toFixed(3)),
        ),
        maxInterventionsPerMessage: Number((current.interventionsPerMessage + 0.8).toFixed(3)),
        maxBlockedAssumptionRate: Math.max(
          0.25,
          Number((current.blockedAssumptionRate + 0.45).toFixed(3)),
        ),
      },
    };
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(resolve(args.baselinePath), `${JSON.stringify(baseline, null, 2)}\n`),
    );
    printMetrics("Reliability baseline written from current metrics", current);
    console.log(`\nWrote baseline: ${resolve(args.baselinePath)}`);
    return;
  }

  const baselineRaw = await readFile(resolve(args.baselinePath), "utf8");
  const baseline = JSON.parse(baselineRaw) as ReliabilityBaseline;
  const drift = depthDriftL1(current, baseline.baseline);
  const failures: string[] = [];

  if (current.tokenMultiplier > baseline.thresholds.maxTokenMultiplier) {
    failures.push(
      `tokenMultiplier ${current.tokenMultiplier.toFixed(3)}x > max ${baseline.thresholds.maxTokenMultiplier.toFixed(3)}x`,
    );
  }
  if (drift > baseline.thresholds.maxDepthDriftL1) {
    failures.push(
      `depth drift L1 ${drift.toFixed(3)} > max ${baseline.thresholds.maxDepthDriftL1.toFixed(3)}`,
    );
  }
  if (
    current.interventionsPerMessage < baseline.thresholds.minInterventionsPerMessage ||
    current.interventionsPerMessage > baseline.thresholds.maxInterventionsPerMessage
  ) {
    failures.push(
      `interventions/message ${current.interventionsPerMessage.toFixed(3)} out of bounds [${baseline.thresholds.minInterventionsPerMessage.toFixed(3)}, ${baseline.thresholds.maxInterventionsPerMessage.toFixed(3)}]`,
    );
  }
  if (current.blockedAssumptionRate > baseline.thresholds.maxBlockedAssumptionRate) {
    failures.push(
      `blockedAssumptionRate ${current.blockedAssumptionRate.toFixed(3)} > max ${baseline.thresholds.maxBlockedAssumptionRate.toFixed(3)}`,
    );
  }

  printMetrics("Current reliability metrics", current);
  printMetrics("Baseline reliability metrics", baseline.baseline);
  console.log(`\nDepth drift L1: ${drift.toFixed(3)}`);

  if (failures.length > 0) {
    console.error("\nReliability gate FAILED:");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  console.log("\nReliability gate PASSED.");
}

main().catch((err) => {
  console.error("Reliability gate fatal error:", err);
  process.exit(1);
});

