import type { EnrichedPrompt } from "../types.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const MAGENTA = "\x1b[35m";
const RED = "\x1b[31m";
const BLUE = "\x1b[34m";

function c(color: string, text: string): string {
  return `${color}${text}${RESET}`;
}

export function formatResult(result: EnrichedPrompt, verbose: boolean): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(c(BOLD + CYAN, "═══ Undercurrent Pipeline Output ═══"));
  lines.push("");

  // Intent
  lines.push(c(BOLD + YELLOW, "▸ Intent"));
  const i = result.intent;
  lines.push(
    `  Action: ${c(BOLD, i.action)}  Specificity: ${c(BOLD, i.specificity)}  ` +
    `Scope: ${c(BOLD, i.scope)}  Emotion: ${c(BOLD, i.emotionalLoad)}`
  );
  lines.push(`  Confidence: ${c(BOLD, (i.confidence * 100).toFixed(0) + "%")}`);
  if (i.domainHints.length > 0) {
    lines.push(`  Domains: ${c(MAGENTA, i.domainHints.join(", "))}`);
  }
  if (i.rawFragments.length > 0) {
    lines.push(`  Fragments: ${c(DIM, i.rawFragments.join(", "))}`);
  }

  // Depth
  lines.push("");
  lines.push(c(BOLD + YELLOW, "▸ Enrichment Depth"));
  const depth = result.metadata.enrichmentDepth;
  const depthColor = depth === "none" ? DIM : depth === "deep" ? RED : depth === "standard" ? GREEN : YELLOW;
  lines.push(`  ${c(BOLD + depthColor, depth.toUpperCase())} (strategy: ${result.metadata.strategyUsed}, platform: ${result.metadata.targetPlatform})`);

  if (depth === "none") {
    lines.push(`  ${c(DIM, "→ Passthrough — message forwarded unchanged")}`);
    lines.push("");
    lines.push(c(DIM, `  Completed in ${result.metadata.processingTimeMs.toFixed(1)}ms`));
    lines.push("");
    return lines.join("\n");
  }

  // Context
  lines.push("");
  lines.push(c(BOLD + YELLOW, `▸ Context (${result.context.length} layers)`));
  if (result.context.length === 0) {
    lines.push(`  ${c(DIM, "(no context gathered)")}`);
  } else {
    for (const layer of result.context) {
      lines.push(`  ${c(BLUE, `[${layer.source}]`)} ${layer.summary}`);
      if (verbose) {
        const dataStr = JSON.stringify(layer.data, null, 2)
          .split("\n")
          .map((l) => `    ${c(DIM, l)}`)
          .join("\n");
        lines.push(dataStr);
      }
    }
  }

  // Adapter timings
  const timings = result.metadata.adapterTimings;
  if (Object.keys(timings).length > 0) {
    const timingStr = Object.entries(timings)
      .map(([name, ms]) => `${name}: ${(ms as number).toFixed(0)}ms`)
      .join(", ");
    lines.push(`  ${c(DIM, `Timings: ${timingStr}`)}`);
  }

  // Gaps
  lines.push("");
  lines.push(c(BOLD + YELLOW, `▸ Gaps (${result.gaps.length} identified)`));
  if (result.gaps.length === 0) {
    lines.push(`  ${c(DIM, "(no gaps detected)")}`);
  } else {
    for (const gap of result.gaps) {
      const critical = gap.critical ? c(RED, " [CRITICAL]") : "";
      const resolution = gap.resolution;
      let resStr = c(DIM, "unresolved");
      if (resolution?.type === "filled") {
        resStr = c(GREEN, `filled → ${resolution.value.slice(0, 80)} (from ${resolution.source})`);
      } else if (resolution?.type === "assumed") {
        resStr = c(YELLOW, `assumed (${(resolution.assumption.confidence * 100).toFixed(0)}%): ${resolution.assumption.claim}`);
      } else if (resolution?.type === "needs-clarification") {
        resStr = c(RED, `needs clarification: ${resolution.clarification.question}`);
      }
      lines.push(`  ${gap.description}${critical}`);
      lines.push(`    → ${resStr}`);
    }
  }

  // Assumptions
  if (result.assumptions.length > 0) {
    lines.push("");
    lines.push(c(BOLD + YELLOW, `▸ Assumptions (${result.assumptions.length})`));
    for (const a of result.assumptions) {
      lines.push(`  ${c(YELLOW, "⚠")} ${a.claim}`);
      lines.push(`    ${c(DIM, `Confidence: ${(a.confidence * 100).toFixed(0)}% — Basis: ${a.basis}`)}`);
    }
  }

  // Clarifications
  if (result.clarifications.length > 0) {
    lines.push("");
    lines.push(c(BOLD + YELLOW, `▸ Clarifications (${result.clarifications.length})`));
    for (const cl of result.clarifications) {
      lines.push(`  ${c(RED, "?")} ${cl.question}`);
      for (const opt of cl.options) {
        const def = opt.isDefault ? c(GREEN, " (default)") : "";
        lines.push(`    - ${opt.label}${def}`);
      }
    }
  }

  // Enriched Message
  lines.push("");
  lines.push(c(BOLD + YELLOW, "▸ Enriched Message"));
  lines.push(c(DIM, "─".repeat(60)));
  lines.push(result.enrichedMessage);
  lines.push(c(DIM, "─".repeat(60)));

  // Metadata
  lines.push("");
  lines.push(c(DIM, `Completed in ${result.metadata.processingTimeMs.toFixed(1)}ms | Pipeline v${result.metadata.pipelineVersion}`));
  lines.push("");

  return lines.join("\n");
}

export function formatCompactRow(
  index: number,
  message: string,
  result: EnrichedPrompt,
): string {
  const msg = message.length > 50 ? message.slice(0, 47) + "..." : message.padEnd(50);
  const depth = result.metadata.enrichmentDepth.padEnd(8);
  const intent = result.intent.action.padEnd(7);
  const spec = result.intent.specificity.padEnd(6);
  const ctx = String(result.context.length).padStart(3);
  const gaps = String(result.gaps.length).padStart(3);
  const assumptions = String(result.assumptions.length).padStart(3);
  const ms = result.metadata.processingTimeMs.toFixed(0).padStart(5);

  return `${String(index + 1).padStart(3)}  ${msg}  ${depth}  ${intent}  ${spec}  ${ctx}  ${gaps}  ${assumptions}  ${ms}ms`;
}

export function formatCompactHeader(): string {
  const header =
    "  #  Message".padEnd(57) +
    "Depth     Intent   Spec    Ctx  Gap  Asm   Time";
  const separator = "─".repeat(header.length);
  return `${header}\n${separator}`;
}
