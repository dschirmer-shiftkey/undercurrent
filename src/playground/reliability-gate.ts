import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Undercurrent } from "../index.js";
import { ConversationAdapter } from "../adapters/conversation.js";
import { GitAdapter } from "../adapters/git.js";
import { FilesystemAdapter } from "../adapters/filesystem.js";
import { DefaultStrategy } from "../strategies/default.js";
import { parseTranscript } from "./transcript-parser.js";
import type { GovernancePreset, TargetPlatform } from "../types.js";

interface GateMetrics {
  totalMessages: number;
  depthDistribution: Record<string, number>;
  tokenMultiplier: number;
  interventionsPerMessage: number;
  blockedAssumptionRate: number;
  blockingClarificationRate: number;
  highCascadeRiskRate: number;
}

interface GateThresholds {
  maxTokenMultiplier: number;
  maxDepthDriftL1: number;
  minInterventionsPerMessage: number;
  maxInterventionsPerMessage: number;
  maxBlockedAssumptionRate: number;
  maxBlockingClarificationRate: number;
  maxHighCascadeRiskRate: number;
}

interface ReliabilityBaseline {
  generatedAt: string;
  dataset: string[];
  platform: TargetPlatform;
  preset?: GovernancePreset;
  baseline: GateMetrics;
  thresholds: GateThresholds;
}

interface MatrixCell {
  name: string;
  fixtures: string[];
  platform: TargetPlatform;
  preset?: GovernancePreset;
  baseline?: GateMetrics;
  thresholds?: GateThresholds;
}

interface ReliabilityMatrix {
  generatedAt: string;
  cells: MatrixCell[];
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

interface CliArgs {
  mode: "single" | "matrix";
  baselinePath: string;
  matrixPath: string;
  transcripts: string[];
  platform: TargetPlatform;
  preset?: GovernancePreset;
  writeBaseline: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let baselinePath = "ci/reliability-baseline.json";
  let matrixPath = "";
  const transcripts: string[] = [];
  let platform: TargetPlatform = "generic";
  let preset: GovernancePreset | undefined;
  let writeBaseline = false;

  for (let idx = 0; idx < argv.length; idx++) {
    const arg = argv[idx]!;
    if (arg === "--baseline" && argv[idx + 1]) baselinePath = argv[++idx]!;
    else if (arg === "--matrix" && argv[idx + 1]) matrixPath = argv[++idx]!;
    else if (arg === "--transcript" && argv[idx + 1]) transcripts.push(argv[++idx]!);
    else if (arg === "--platform" && argv[idx + 1]) platform = argv[++idx]! as TargetPlatform;
    else if (arg === "--preset" && argv[idx + 1]) preset = argv[++idx]! as GovernancePreset;
    else if (arg === "--write-baseline" || arg === "--write") writeBaseline = true;
  }

  if (transcripts.length === 0 && !matrixPath) {
    transcripts.push("fixtures/replay/reliability-ci.jsonl");
  }

  return {
    mode: matrixPath ? "matrix" : "single",
    baselinePath,
    matrixPath,
    transcripts,
    platform,
    preset,
    writeBaseline,
  };
}

async function computeMetrics(
  pipeline: Undercurrent,
  transcripts: string[],
  platform: TargetPlatform,
  preset?: GovernancePreset,
): Promise<GateMetrics> {
  let totalMessages = 0;
  let totalOriginalTokens = 0;
  let totalEnrichedTokens = 0;
  let interventions = 0;
  let blocked = 0;
  let assumptionsBefore = 0;
  let blockingClarifications = 0;
  let highCascade = 0;
  const depthDistribution: Record<string, number> = {};

  for (const transcript of transcripts) {
    const entries = await parseTranscript(transcript);
    for (const entry of entries) {
      const result = await pipeline.enrich({
        message: entry.rawMessage,
        conversation: entry.conversationSoFar,
        targetPlatform: platform,
        preset,
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
      const pre = result.metadata.preflight;
      if (pre) {
        if (pre.blockingClarificationNeeded) blockingClarifications++;
        if (pre.cascadeRisk.level === "high") highCascade++;
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
    blockingClarificationRate: blockingClarifications / messageDenom,
    highCascadeRiskRate: highCascade / messageDenom,
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

function deriveThresholds(metrics: GateMetrics): GateThresholds {
  return {
    maxTokenMultiplier: Number((metrics.tokenMultiplier + 0.75).toFixed(3)),
    maxDepthDriftL1: 0.55,
    minInterventionsPerMessage: Math.max(
      0,
      Number((metrics.interventionsPerMessage - 0.6).toFixed(3)),
    ),
    maxInterventionsPerMessage: Number((metrics.interventionsPerMessage + 0.8).toFixed(3)),
    maxBlockedAssumptionRate: Math.max(
      0.25,
      Number((metrics.blockedAssumptionRate + 0.45).toFixed(3)),
    ),
    // Blocking clarifications are the preflight regression we're guarding against
    // (PR #62 had 17.5% of messages blocked; safe-tuned should sit well below that).
    maxBlockingClarificationRate: Math.max(
      0.05,
      Number((metrics.blockingClarificationRate + 0.05).toFixed(3)),
    ),
    // High cascade-risk should track its own design intent (~2-5% of messages).
    maxHighCascadeRiskRate: Math.max(
      0.1,
      Number((metrics.highCascadeRiskRate + 0.05).toFixed(3)),
    ),
  };
}

interface FailureReason {
  cell: string;
  message: string;
}

function evaluateCell(
  cellName: string,
  current: GateMetrics,
  baseline: GateMetrics,
  thresholds: GateThresholds,
): FailureReason[] {
  const failures: FailureReason[] = [];
  const drift = depthDriftL1(current, baseline);

  if (current.tokenMultiplier > thresholds.maxTokenMultiplier) {
    failures.push({
      cell: cellName,
      message: `tokenMultiplier ${current.tokenMultiplier.toFixed(3)}x > max ${thresholds.maxTokenMultiplier.toFixed(3)}x`,
    });
  }
  if (drift > thresholds.maxDepthDriftL1) {
    failures.push({
      cell: cellName,
      message: `depth drift L1 ${drift.toFixed(3)} > max ${thresholds.maxDepthDriftL1.toFixed(3)}`,
    });
  }
  if (
    current.interventionsPerMessage < thresholds.minInterventionsPerMessage ||
    current.interventionsPerMessage > thresholds.maxInterventionsPerMessage
  ) {
    failures.push({
      cell: cellName,
      message: `interventions/message ${current.interventionsPerMessage.toFixed(3)} out of bounds [${thresholds.minInterventionsPerMessage.toFixed(3)}, ${thresholds.maxInterventionsPerMessage.toFixed(3)}]`,
    });
  }
  if (current.blockedAssumptionRate > thresholds.maxBlockedAssumptionRate) {
    failures.push({
      cell: cellName,
      message: `blockedAssumptionRate ${current.blockedAssumptionRate.toFixed(3)} > max ${thresholds.maxBlockedAssumptionRate.toFixed(3)}`,
    });
  }
  if (current.blockingClarificationRate > thresholds.maxBlockingClarificationRate) {
    failures.push({
      cell: cellName,
      message: `blockingClarificationRate ${current.blockingClarificationRate.toFixed(3)} > max ${thresholds.maxBlockingClarificationRate.toFixed(3)} (preflight regression?)`,
    });
  }
  if (current.highCascadeRiskRate > thresholds.maxHighCascadeRiskRate) {
    failures.push({
      cell: cellName,
      message: `highCascadeRiskRate ${current.highCascadeRiskRate.toFixed(3)} > max ${thresholds.maxHighCascadeRiskRate.toFixed(3)}`,
    });
  }

  return failures;
}

function printCellMetrics(label: string, metrics: GateMetrics): void {
  console.log(`  ${label}`);
  console.log(`    messages: ${metrics.totalMessages}`);
  console.log(`    tokenMultiplier: ${metrics.tokenMultiplier.toFixed(3)}x`);
  console.log(`    interventions/message: ${metrics.interventionsPerMessage.toFixed(3)}`);
  console.log(`    blockedAssumptionRate: ${metrics.blockedAssumptionRate.toFixed(3)}`);
  console.log(`    blockingClarificationRate: ${metrics.blockingClarificationRate.toFixed(3)}`);
  console.log(`    highCascadeRiskRate: ${metrics.highCascadeRiskRate.toFixed(3)}`);
  console.log(`    depth: ${JSON.stringify(metrics.depthDistribution)}`);
}

async function runMatrix(args: CliArgs): Promise<void> {
  const matrixPath = resolve(args.matrixPath);
  const raw = await readFile(matrixPath, "utf8");
  const matrix = JSON.parse(raw) as ReliabilityMatrix;
  const failures: FailureReason[] = [];
  const updatedCells: MatrixCell[] = [];

  for (const cell of matrix.cells) {
    console.log(`\n── ${cell.name} (preset=${cell.preset ?? "default"}, platform=${cell.platform}) ──`);
    const pipeline = createPipeline(cell.platform);
    const fixtures = cell.fixtures.map((p) => resolve(p));
    const current = await computeMetrics(pipeline, fixtures, cell.platform, cell.preset);

    if (args.writeBaseline) {
      const thresholds = deriveThresholds(current);
      updatedCells.push({ ...cell, baseline: current, thresholds });
      printCellMetrics("new baseline:", current);
      continue;
    }

    if (!cell.baseline || !cell.thresholds) {
      failures.push({
        cell: cell.name,
        message: "cell has no baseline — run with --write to generate",
      });
      continue;
    }

    printCellMetrics("current:", current);
    printCellMetrics("baseline:", cell.baseline);
    const cellFailures = evaluateCell(cell.name, current, cell.baseline, cell.thresholds);
    failures.push(...cellFailures);
  }

  if (args.writeBaseline) {
    const next: ReliabilityMatrix = {
      generatedAt: new Date().toISOString(),
      cells: updatedCells,
    };
    await writeFile(matrixPath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`\nWrote matrix baselines: ${matrixPath}`);
    return;
  }

  if (failures.length > 0) {
    console.error("\nReliability gate FAILED:");
    for (const failure of failures) {
      console.error(`  [${failure.cell}] ${failure.message}`);
    }
    process.exit(1);
  }

  console.log(`\nReliability gate PASSED (${matrix.cells.length} cells).`);
}

async function runSingle(args: CliArgs): Promise<void> {
  const resolvedTranscripts = args.transcripts.map((p) => resolve(p));
  const pipeline = createPipeline(args.platform);
  const current = await computeMetrics(pipeline, resolvedTranscripts, args.platform, args.preset);

  if (args.writeBaseline) {
    const baseline: ReliabilityBaseline = {
      generatedAt: new Date().toISOString(),
      dataset: args.transcripts,
      platform: args.platform,
      preset: args.preset,
      baseline: current,
      thresholds: deriveThresholds(current),
    };
    await writeFile(resolve(args.baselinePath), `${JSON.stringify(baseline, null, 2)}\n`);
    printCellMetrics("Reliability baseline written from current metrics:", current);
    console.log(`\nWrote baseline: ${resolve(args.baselinePath)}`);
    return;
  }

  const baselineRaw = await readFile(resolve(args.baselinePath), "utf8");
  const baseline = JSON.parse(baselineRaw) as ReliabilityBaseline;
  const cellName = `${baseline.preset ?? "default"}/${baseline.platform}`;
  const failures = evaluateCell(cellName, current, baseline.baseline, baseline.thresholds);

  printCellMetrics("current:", current);
  printCellMetrics("baseline:", baseline.baseline);

  if (failures.length > 0) {
    console.error("\nReliability gate FAILED:");
    for (const failure of failures) {
      console.error(`  [${failure.cell}] ${failure.message}`);
    }
    process.exit(1);
  }

  console.log("\nReliability gate PASSED.");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "matrix") {
    await runMatrix(args);
  } else {
    await runSingle(args);
  }
}

main().catch((err) => {
  console.error("Reliability gate fatal error:", err);
  process.exit(1);
});
