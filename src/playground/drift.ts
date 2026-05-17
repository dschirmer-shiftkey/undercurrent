import { DriftMonitor } from "../engine/drift-monitor.js";
import { parseTranscript } from "./transcript-parser.js";
import type { ConversationTurn } from "../types.js";

interface CliArgs {
  transcripts: string[];
  verbose: boolean;
  showRegistry: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const transcripts: string[] = [];
  let verbose = false;
  let showRegistry = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--transcript" && argv[i + 1]) transcripts.push(argv[++i]!);
    else if (arg === "--verbose") verbose = true;
    else if (arg === "--registry") showRegistry = true;
    else if (!arg.startsWith("--")) transcripts.push(arg);
  }

  if (transcripts.length === 0) {
    transcripts.push("fixtures/replay/drift-detection.jsonl");
  }
  return { transcripts, verbose, showRegistry };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function renderBar(score: number, width = 20): string {
  const filled = Math.round((score / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  for (const transcript of args.transcripts) {
    console.log(`\n── ${transcript} ──`);
    const entries = await parseTranscript(transcript);
    // Reconstruct full turn order (user + assistant) so canonical first-seen
    // tracking reflects the entire conversation, not just user turns.
    const allTurns: ConversationTurn[] = [];
    for (const entry of entries) {
      // conversationSoFar contains the assistant context as of this user turn;
      // we want each turn once, in order. Append rawMessage as the user turn.
      for (const t of entry.conversationSoFar) {
        if (!allTurns.some((p) => p.content === t.content && p.role === t.role)) {
          allTurns.push(t);
        }
      }
      allTurns.push({ role: "user", content: entry.rawMessage });
    }

    const monitor = new DriftMonitor();
    const report = monitor.analyze(allTurns);
    const g = report.gauge;

    console.log(
      `  ${allTurns.length} turns processed | ${report.events.length} drift events (${report.rewrites} rewrite, ${report.flags} flag)`,
    );
    console.log(
      `  by kind: case=${report.byKind.case}  suffix=${report.byKind.suffix}  typo=${report.byKind.typo}  path=${report.byKind.path}`,
    );
    console.log("");
    console.log(`  ┌─ DRIFT GAUGE ──────────────────────────────────────────`);
    console.log(`  │ Level:    ${g.level.padEnd(10)}  ${renderBar(g.score)} ${g.score}/100`);
    console.log(`  │ Trend:    ${g.trend}`);
    console.log(`  │ Recent:   ${g.recentEvents} event(s) in last window (asOfTurn=${g.asOfTurn})`);
    console.log(`  │ Refresh:  ${g.refreshRecommended ? "RECOMMENDED — refresh canonical context" : "not yet"}`);
    console.log(`  │ Reason:   ${g.reasoning}`);
    console.log(`  └────────────────────────────────────────────────────────`);

    if (report.events.length > 0) {
      console.log("\n  Drift events:");
      console.log("    turn  kind     action    observed → canonical");
      for (const event of report.events) {
        const arrow = event.action === "rewrite" ? "→" : "?";
        console.log(
          `    ${String(event.observedTurn).padStart(4)}  ${event.kind.padEnd(7)}  ${event.action.padEnd(8)}  ${truncate(event.observed, 36).padEnd(36)} ${arrow} ${event.canonical}`,
        );
        if (args.verbose) {
          console.log(`          ${event.reasoning}`);
        }
      }
    }

    if (args.showRegistry) {
      console.log("\n  Canonical registry:");
      const entries = [...report.registry.entries()]
        .filter(([, v]) => v.firstSeenTurn >= 0)
        .sort((a, b) => a[1].firstSeenTurn - b[1].firstSeenTurn);
      for (const [key, entry] of entries) {
        console.log(
          `    turn ${String(entry.firstSeenTurn).padStart(3)}  ×${String(entry.occurrences).padStart(2)}  ${entry.canonical}${entry.canonical !== key ? `  (key=${key})` : ""}`,
        );
      }
    }
  }
}

main().catch((err) => {
  console.error("DriftMonitor CLI fatal:", err);
  process.exit(1);
});
