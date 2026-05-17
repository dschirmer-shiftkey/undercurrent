import { parseTranscript } from "./transcript-parser.js";
import { runPilotSimulation } from "../komatik/pilot-simulator.js";
import type { PilotSimulationMessage } from "../komatik/pilot-simulator.js";
import type { GovernancePreset, TargetPlatform } from "../types.js";

interface CliArgs {
  transcript: string;
  sourceApp: string;
  userId: string;
  preset?: GovernancePreset;
  platform: TargetPlatform;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let transcript = "fixtures/replay/reliability-ci.jsonl";
  let sourceApp = "platform";
  let userId = "sim-user-1";
  let preset: GovernancePreset | undefined;
  let platform: TargetPlatform = "generic";
  let verbose = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--transcript" && argv[i + 1]) transcript = argv[++i]!;
    else if (arg === "--source-app" && argv[i + 1]) sourceApp = argv[++i]!;
    else if (arg === "--user-id" && argv[i + 1]) userId = argv[++i]!;
    else if (arg === "--preset" && argv[i + 1]) preset = argv[++i]! as GovernancePreset;
    else if (arg === "--platform" && argv[i + 1]) platform = argv[++i]! as TargetPlatform;
    else if (arg === "--verbose") verbose = true;
  }

  return { transcript, sourceApp, userId, preset, platform, verbose };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const entries = await parseTranscript(args.transcript);
  const messages: PilotSimulationMessage[] = entries.map((entry) => ({
    text: entry.rawMessage,
    history: entry.conversationSoFar,
  }));

  console.log(
    `\nRunning pilot simulation: ${messages.length} messages, source-app=${args.sourceApp}, preset=${args.preset ?? "default"}, platform=${args.platform}\n`,
  );

  const result = await runPilotSimulation({
    messages,
    sourceApp: args.sourceApp,
    userId: args.userId,
    preset: args.preset,
    targetPlatform: args.platform,
  });

  if (args.verbose) {
    console.log("Per-request telemetry:");
    console.log("  #  message                                              depth     mult   intvtns  modelMs  verdict");
    for (let i = 0; i < result.events.length; i++) {
      const ev = result.events[i]!;
      const depth = result.enrichments[i]!.metadata.enrichmentDepth.padEnd(8);
      const verdict = result.outcomes[i]?.accepted ? "accept" : "reject";
      const msg = truncate(result.enrichments[i]!.originalMessage, 52).padEnd(52);
      console.log(
        `  ${String(i + 1).padStart(2)}  ${msg}  ${depth}  ${ev.tokenMultiplier.toFixed(2).padStart(5)}  ${String(ev.governanceInterventions).padStart(7)}  ${String(ev.modelLatencyMs).padStart(7)}  ${verdict}`,
      );
    }
    console.log();
  }

  console.log("ROI summary:");
  console.log(`  Total requests:           ${result.roi.totalRequests}`);
  console.log(`  Acceptance rate:          ${(result.roi.acceptanceRate * 100).toFixed(1)}%`);
  console.log(`  Avg total latency:        ${result.roi.avgTotalLatencyMs}ms`);
  console.log(`  Avg enrichment latency:   ${result.roi.avgEnrichmentLatencyMs}ms`);
  console.log(`  Avg model latency:        ${result.roi.avgModelLatencyMs}ms`);
  console.log(`  Avg token multiplier:     ${result.roi.avgTokenMultiplier}x`);
  console.log(`  Avg token overhead:       ${result.roi.avgTokenOverhead} tokens`);
  console.log(`  Avg governance intvtns:   ${result.roi.avgGovernanceInterventions}`);

  const writes = result.writes.enrichment_outcomes;
  if (writes) {
    console.log(`\nFeedback loop persisted:`);
    console.log(`  enrichment_outcomes inserts (telemetry rows): ${writes.inserts.length}`);
    console.log(`  enrichment_outcomes updates (verdicts):       ${writes.updates.length}`);
  }
}

main().catch((err) => {
  console.error("Pilot simulator fatal error:", err);
  process.exit(1);
});
