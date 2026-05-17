import {
  runAcceptanceHarness,
  type HarnessConfig,
  type HarnessMessage,
} from "../komatik/acceptance-harness.js";

const WORKLOAD: HarnessMessage[] = [
  // Coding
  { text: "Fix the auth crash in src/auth/login.ts when the token is missing.", domain: "debugging" },
  { text: "Refactor the billing proration logic to support split ledgers.", domain: "coding" },
  { text: "Add a regression test for the null-token edge case.", domain: "coding" },
  { text: "Trace why the prebuild orchestrator returns 422 on Spring matrix runs.", domain: "debugging" },
  // Planning
  { text: "Plan the v3 migration timeline for Q3 — phases, owners, risk.", domain: "planning" },
  { text: "Architect the new Komatik sandbox so each user has isolated storage.", domain: "planning" },
  // Analysis
  { text: "Analyze last week's deploy metrics and find the regressions.", domain: "analysis" },
  { text: "Compare model acceptance rates across nextjs vs spring projects.", domain: "analysis" },
  // Creative
  { text: "Draft a launch blog post about the new IDE auto-routing feature.", domain: "creative" },
  { text: "Write microcopy for the resume banner when a project session re-opens.", domain: "creative" },
  // Conversation
  { text: "Thanks, ship it.", domain: "conversation" },
  { text: "Looks good — merge when CI is green.", domain: "conversation" },
];

const CONFIGS: HarnessConfig[] = [
  { name: "fixed-budget", tierBias: "budget" },
  { name: "fixed-balanced", tierBias: "balanced" },
  { name: "fixed-premier", tierBias: "premier" },
];

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}

async function main(): Promise<void> {
  const seedArg = process.argv.indexOf("--seed");
  const seed = seedArg >= 0 && process.argv[seedArg + 1] ? Number(process.argv[seedArg + 1]) : 42;

  console.log(`\nAcceptance harness — ${WORKLOAD.length} messages × ${CONFIGS.length} configs (seed=${seed})\n`);

  const comparison = await runAcceptanceHarness({
    workload: WORKLOAD,
    configs: CONFIGS,
    seed,
  });

  // Per-config table
  console.log(`  ${pad("config", 18)}  ${pad("accept", 7)}  ${pad("avgLat", 7)}  ${pad("avgMult", 7)}  ${pad("cost", 9)}  model picks`);
  console.log(`  ${"─".repeat(18)}  ${"─".repeat(7)}  ${"─".repeat(7)}  ${"─".repeat(7)}  ${"─".repeat(9)}  ${"─".repeat(40)}`);
  for (const r of comparison.results) {
    const models = Object.entries(r.modelHistogram)
      .sort((a, b) => b[1] - a[1])
      .map(([m, n]) => `${m}×${n}`)
      .join(", ");
    console.log(
      `  ${pad(r.config.name, 18)}  ${pad(pct(r.acceptanceRate), 7)}  ${pad(fmt(r.avgLatencyMs, 0) + "ms", 7)}  ${pad(fmt(r.avgTokenMultiplier) + "x", 7)}  $${pad(fmt(r.totalCost, 6), 8)}  ${models}`,
    );
  }
  console.log("");

  // Winners
  console.log("  Winners:");
  console.log(`    by acceptance: ${comparison.winners.byAcceptance}`);
  console.log(`    by latency:    ${comparison.winners.byLatency}`);
  console.log(`    by cost:       ${comparison.winners.byCost}`);
  console.log("");

  // Spreads
  console.log("  Spread across configs (max - min):");
  console.log(`    acceptance: ${pct(comparison.spreads.acceptance)}`);
  console.log(`    latency:    ${fmt(comparison.spreads.latency, 0)}ms`);
  console.log(`    cost:       $${fmt(comparison.spreads.cost, 6)}`);
  console.log("");

  console.log("  Honest framing:");
  console.log("    Acceptance rates above are derived from a simulated per-(model, domain)");
  console.log("    probability table — NOT real production data. This harness is a methodology;");
  console.log("    re-run it against actual user acceptance signals to draw a real conclusion.");
  console.log("    What's proven today: end-to-end wiring works and the comparison metrics");
  console.log("    surface the right signal for an evidence-based tier-UI swap decision.");
}

main().catch((err) => {
  console.error("Acceptance harness fatal:", err);
  process.exit(1);
});
