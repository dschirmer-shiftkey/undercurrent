import { resolve, basename, dirname } from "node:path";
import { writeFile } from "node:fs/promises";
import { Undercurrent } from "../index.js";
import { ConversationAdapter } from "../adapters/conversation.js";
import { GitAdapter } from "../adapters/git.js";
import { FilesystemAdapter } from "../adapters/filesystem.js";
import { DefaultStrategy } from "../strategies/default.js";
import { parseTranscript, discoverTranscripts } from "./transcript-parser.js";
import { formatCompactHeader, formatCompactRow, formatResult } from "./formatter.js";
import type { EnrichedPrompt, TargetPlatform } from "../types.js";

interface ReplayResult {
  index: number;
  message: string;
  result: EnrichedPrompt;
}

interface TranscriptReport {
  file: string;
  messageCount: number;
  results: ReplayResult[];
}

interface AggregateStats {
  totalMessages: number;
  depthDistribution: Record<string, number>;
  avgContextLayers: number;
  avgProcessingMs: number;
  totalGaps: number;
  totalAssumptions: number;
  totalClarifications: number;
  domainHintCounts: Record<string, number>;
  actionCounts: Record<string, number>;
  gapDescriptions: Record<string, number>;
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

async function replayTranscript(
  filePath: string,
  uc: Undercurrent,
  platform: TargetPlatform,
): Promise<TranscriptReport> {
  const entries = await parseTranscript(filePath);
  const results: ReplayResult[] = [];

  for (const entry of entries) {
    const result = await uc.enrich({
      message: entry.rawMessage,
      conversation: entry.conversationSoFar,
      targetPlatform: platform,
    });

    results.push({
      index: entry.index,
      message: entry.rawMessage,
      result,
    });
  }

  return {
    file: filePath,
    messageCount: entries.length,
    results,
  };
}

function computeStats(reports: TranscriptReport[]): AggregateStats {
  const stats: AggregateStats = {
    totalMessages: 0,
    depthDistribution: {},
    avgContextLayers: 0,
    avgProcessingMs: 0,
    totalGaps: 0,
    totalAssumptions: 0,
    totalClarifications: 0,
    domainHintCounts: {},
    actionCounts: {},
    gapDescriptions: {},
  };

  let totalCtx = 0;
  let totalMs = 0;

  for (const report of reports) {
    for (const { result } of report.results) {
      stats.totalMessages++;

      const depth = result.metadata.enrichmentDepth;
      stats.depthDistribution[depth] = (stats.depthDistribution[depth] ?? 0) + 1;

      totalCtx += result.context.length;
      totalMs += result.metadata.processingTimeMs;

      stats.totalGaps += result.gaps.length;
      stats.totalAssumptions += result.assumptions.length;
      stats.totalClarifications += result.clarifications.length;

      const action = result.intent.action;
      stats.actionCounts[action] = (stats.actionCounts[action] ?? 0) + 1;

      for (const hint of result.intent.domainHints) {
        stats.domainHintCounts[hint] = (stats.domainHintCounts[hint] ?? 0) + 1;
      }

      for (const gap of result.gaps) {
        const key = gap.description.slice(0, 60);
        stats.gapDescriptions[key] = (stats.gapDescriptions[key] ?? 0) + 1;
      }
    }
  }

  stats.avgContextLayers = stats.totalMessages > 0 ? totalCtx / stats.totalMessages : 0;
  stats.avgProcessingMs = stats.totalMessages > 0 ? totalMs / stats.totalMessages : 0;

  return stats;
}

function printReport(reports: TranscriptReport[], stats: AggregateStats, verbose: boolean): void {
  const BOLD = "\x1b[1m";
  const CYAN = "\x1b[36m";
  const YELLOW = "\x1b[33m";
  const GREEN = "\x1b[32m";
  const RED = "\x1b[31m";
  const DIM = "\x1b[2m";
  const RESET = "\x1b[0m";

  console.log(`\n${BOLD}${CYAN}═══ Undercurrent Transcript Replay Report ═══${RESET}\n`);

  for (const report of reports) {
    const name = basename(dirname(report.file));
    console.log(`${BOLD}${YELLOW}▸ Transcript: ${RESET}${name}`);
    console.log(`  ${DIM}File: ${report.file}${RESET}`);
    console.log(`  ${DIM}Messages: ${report.messageCount}${RESET}\n`);

    console.log(formatCompactHeader());
    for (const { index, message, result } of report.results) {
      console.log(formatCompactRow(index, message, result));
    }
    console.log("");

    if (verbose) {
      for (const { index, message, result } of report.results) {
        const preview = message.slice(0, 80).replace(/\n/g, " ");
        console.log(`${BOLD}── Message ${index + 1}: ${RESET}${preview}${message.length > 80 ? "..." : ""}`);
        console.log(formatResult(result, true));
      }
    }
  }

  // Aggregate stats
  console.log(`${BOLD}${CYAN}═══ Aggregate Statistics ═══${RESET}\n`);
  console.log(`  Total messages: ${BOLD}${stats.totalMessages}${RESET}`);
  console.log(`  Avg processing: ${BOLD}${stats.avgProcessingMs.toFixed(1)}ms${RESET}`);
  console.log(`  Avg context layers: ${BOLD}${stats.avgContextLayers.toFixed(1)}${RESET}`);
  console.log("");

  // Depth distribution
  console.log(`  ${BOLD}Depth distribution:${RESET}`);
  const depthOrder = ["none", "light", "standard", "deep"];
  for (const d of depthOrder) {
    const count = stats.depthDistribution[d] ?? 0;
    const pct = stats.totalMessages > 0 ? ((count / stats.totalMessages) * 100).toFixed(0) : "0";
    const bar = "█".repeat(Math.round(count / stats.totalMessages * 30));
    const color = d === "none" ? DIM : d === "deep" ? RED : d === "standard" ? GREEN : YELLOW;
    console.log(`    ${color}${d.padEnd(10)}${RESET} ${String(count).padStart(3)} (${pct.padStart(3)}%) ${color}${bar}${RESET}`);
  }
  console.log("");

  // Action distribution
  console.log(`  ${BOLD}Intent actions:${RESET}`);
  const sortedActions = Object.entries(stats.actionCounts).sort(([, a], [, b]) => b - a);
  for (const [action, count] of sortedActions) {
    console.log(`    ${action.padEnd(10)} ${String(count).padStart(3)}`);
  }
  console.log("");

  // Domain hints
  if (Object.keys(stats.domainHintCounts).length > 0) {
    console.log(`  ${BOLD}Domain hints detected:${RESET}`);
    const sortedDomains = Object.entries(stats.domainHintCounts).sort(([, a], [, b]) => b - a);
    for (const [domain, count] of sortedDomains) {
      console.log(`    ${domain.padEnd(15)} ${String(count).padStart(3)}`);
    }
    console.log("");
  }

  // Gap types
  if (stats.totalGaps > 0) {
    console.log(`  ${BOLD}Gaps (${stats.totalGaps} total, ${stats.totalAssumptions} assumed, ${stats.totalClarifications} clarifications):${RESET}`);
    const sortedGaps = Object.entries(stats.gapDescriptions).sort(([, a], [, b]) => b - a);
    for (const [desc, count] of sortedGaps) {
      console.log(`    ${String(count).padStart(3)}x  ${desc}`);
    }
    console.log("");
  }

  // Interesting cases
  const allResults = reports.flatMap((r) => r.results);

  const deepMessages = allResults.filter((r) => r.result.metadata.enrichmentDepth === "deep");
  if (deepMessages.length > 0) {
    console.log(`  ${BOLD}${RED}Interesting: ${deepMessages.length} message(s) triggered DEEP enrichment:${RESET}`);
    for (const { index, message } of deepMessages) {
      const preview = message.slice(0, 80).replace(/\n/g, " ");
      console.log(`    #${index + 1}: "${preview}${message.length > 80 ? "..." : ""}"`);
    }
    console.log("");
  }

  const assumedMessages = allResults.filter((r) => r.result.assumptions.length > 0);
  if (assumedMessages.length > 0) {
    console.log(`  ${BOLD}${YELLOW}Interesting: ${assumedMessages.length} message(s) required assumptions:${RESET}`);
    for (const { index, message, result } of assumedMessages) {
      const preview = message.slice(0, 60).replace(/\n/g, " ");
      console.log(`    #${index + 1}: "${preview}${message.length > 60 ? "..." : ""}" → ${result.assumptions.length} assumption(s)`);
    }
    console.log("");
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let platform: TargetPlatform = "generic";
  let outputPath: string | null = null;
  let verbose = false;
  const filePaths: string[] = [];

  for (let idx = 0; idx < args.length; idx++) {
    const arg = args[idx]!;
    if (arg === "--platform" && args[idx + 1]) {
      platform = args[++idx]! as TargetPlatform;
    } else if (arg === "--output" && args[idx + 1]) {
      outputPath = args[++idx]!;
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (!arg.startsWith("--")) {
      filePaths.push(arg);
    }
  }

  if (filePaths.length === 0) {
    const transcriptDir = resolve(process.cwd(), "../.cursor/projects/c-Users-david-Projects-undercurrent/agent-transcripts");
    try {
      const discovered = await discoverTranscripts(transcriptDir);
      if (discovered.length === 0) {
        console.error("No transcript files found. Pass a path: npm run replay -- <path.jsonl>");
        process.exit(1);
      }
      console.log(`Discovered ${discovered.length} transcript(s) in agent-transcripts/`);
      filePaths.push(...discovered);
    } catch {
      console.error("No transcript files found. Pass a path: npm run replay -- <path.jsonl>");
      console.error("Usage: npm run replay -- [--platform generic] [--verbose] [--output report.json] <file.jsonl ...>");
      process.exit(1);
    }
  }

  const uc = createPipeline(platform);
  const reports: TranscriptReport[] = [];

  for (const fp of filePaths) {
    const absPath = resolve(fp);
    console.log(`Replaying: ${absPath}`);
    try {
      const report = await replayTranscript(absPath, uc, platform);
      reports.push(report);
      console.log(`  → ${report.messageCount} messages processed`);
    } catch (err) {
      console.error(`  ✗ Failed: ${(err as Error).message}`);
    }
  }

  if (reports.length === 0) {
    console.error("No transcripts were successfully processed.");
    process.exit(1);
  }

  const stats = computeStats(reports);
  printReport(reports, stats, verbose);

  if (outputPath) {
    const jsonReport = {
      generatedAt: new Date().toISOString(),
      platform,
      stats,
      transcripts: reports.map((r) => ({
        file: r.file,
        messageCount: r.messageCount,
        results: r.results.map(({ index, message, result }) => ({
          index,
          message: message.slice(0, 200),
          intent: result.intent,
          depth: result.metadata.enrichmentDepth,
          contextLayers: result.context.length,
          gaps: result.gaps.length,
          assumptions: result.assumptions.length,
          clarifications: result.clarifications.length,
          processingMs: result.metadata.processingTimeMs,
          enrichedMessage: result.enrichedMessage,
        })),
      })),
    };

    await writeFile(outputPath, JSON.stringify(jsonReport, null, 2));
    console.log(`\nJSON report written to: ${outputPath}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
