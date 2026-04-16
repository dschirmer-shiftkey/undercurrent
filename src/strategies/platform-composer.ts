import type {
  Assumption,
  ContextLayer,
  Gap,
  IntentSignal,
  TargetPlatform,
} from "../types.js";

export interface ComposeInput {
  message: string;
  intent: IntentSignal;
  context: ContextLayer[];
  assumptions: Assumption[];
  resolvedGaps: Gap[];
  platform: TargetPlatform;
}

/**
 * Platform-aware composition. Formats the enriched output differently
 * depending on where it will be consumed. The strategy calls this
 * instead of doing its own formatting when platform awareness is needed.
 */
export function composeForPlatform(input: ComposeInput): string {
  switch (input.platform) {
    case "cursor":
      return composeCursor(input);
    case "claude":
      return composeClaude(input);
    case "api":
      return composeApi(input);
    case "mcp":
      return composeMcp(input);
    case "chatgpt":
      return composeChatGpt(input);
    case "generic":
    default:
      return composeGeneric(input);
  }
}

function composeCursor(input: ComposeInput): string {
  const parts: string[] = [];

  parts.push(`<user_request>${input.message}</user_request>`);

  if (input.intent.domainHints.length > 0) {
    parts.push(`<domain>${input.intent.domainHints.join(", ")}</domain>`);
  }

  const prefLayer = input.context.find((c) => c.source === "komatik-preferences");
  if (prefLayer) {
    parts.push(`<user_preferences>${prefLayer.summary}</user_preferences>`);
  }

  const memoryLayer = input.context.find((c) => c.source === "komatik-memory");
  if (memoryLayer) {
    parts.push(`<session_memory>${memoryLayer.summary}</session_memory>`);
  }

  const nonMetaContext = input.context.filter(
    (c) =>
      c.source !== "komatik-preferences" &&
      c.source !== "komatik-memory",
  );
  if (nonMetaContext.length > 0) {
    const contextLines = nonMetaContext.map((l) => `  ${l.source}: ${l.summary}`);
    parts.push(`<context>\n${contextLines.join("\n")}\n</context>`);
  }

  if (input.assumptions.length > 0) {
    const assumptionLines = input.assumptions.map(
      (a) => `  - ${a.claim} (confidence: ${(a.confidence * 100).toFixed(0)}%)`,
    );
    parts.push(`<assumptions>\n${assumptionLines.join("\n")}\n</assumptions>`);
  }

  const filled = input.resolvedGaps.filter((g) => g.resolution?.type === "filled");
  if (filled.length > 0) {
    const filledLines = filled.map((g) => {
      const r = g.resolution as { value: string; source: string };
      return `  - ${g.description} → ${r.value} (from ${r.source})`;
    });
    parts.push(`<auto_resolved>\n${filledLines.join("\n")}\n</auto_resolved>`);
  }

  return parts.join("\n\n");
}

function composeClaude(input: ComposeInput): string {
  const parts: string[] = [];

  parts.push(`<request>\n${input.message}\n</request>`);

  parts.push(
    `<intent action="${input.intent.action}" specificity="${input.intent.specificity}" ` +
    `scope="${input.intent.scope}" emotion="${input.intent.emotionalLoad}" />`,
  );

  const prefLayer = input.context.find((c) => c.source === "komatik-preferences");
  const memoryLayer = input.context.find((c) => c.source === "komatik-memory");
  const identityLayer = input.context.find((c) => c.source === "komatik-identity");
  const outcomeLayer = input.context.find((c) => c.source === "komatik-outcomes");

  if (identityLayer || prefLayer) {
    const userParts: string[] = [];
    if (identityLayer) userParts.push(identityLayer.summary);
    if (prefLayer) userParts.push(prefLayer.summary);
    parts.push(`<user_profile>\n${userParts.join("\n")}\n</user_profile>`);
  }

  if (memoryLayer) {
    parts.push(`<memory>\n${memoryLayer.summary}\n</memory>`);
  }

  if (outcomeLayer) {
    parts.push(`<learning>\n${outcomeLayer.summary}\n</learning>`);
  }

  const projectContext = input.context.filter(
    (c) =>
      !["komatik-preferences", "komatik-memory", "komatik-identity", "komatik-outcomes"].includes(c.source),
  );
  if (projectContext.length > 0) {
    const lines = projectContext.map((l) => `- [${l.source}]: ${l.summary}`);
    parts.push(`<project_context>\n${lines.join("\n")}\n</project_context>`);
  }

  if (input.assumptions.length > 0) {
    const lines = input.assumptions.map(
      (a) => `- ${a.claim} (${(a.confidence * 100).toFixed(0)}% confidence, basis: ${a.basis})`,
    );
    parts.push(`<assumptions>\n${lines.join("\n")}\n</assumptions>`);
  }

  return parts.join("\n\n");
}

function composeApi(input: ComposeInput): string {
  const payload = {
    original: input.message,
    intent: {
      action: input.intent.action,
      specificity: input.intent.specificity,
      scope: input.intent.scope,
      emotion: input.intent.emotionalLoad,
      confidence: input.intent.confidence,
      domains: input.intent.domainHints,
    },
    context: input.context.map((c) => ({
      source: c.source,
      summary: c.summary,
      data: c.data,
    })),
    assumptions: input.assumptions.map((a) => ({
      claim: a.claim,
      confidence: a.confidence,
      basis: a.basis,
      correctable: a.correctable,
    })),
    resolvedGaps: input.resolvedGaps
      .filter((g) => g.resolution !== null)
      .map((g) => ({
        description: g.description,
        critical: g.critical,
        resolution: g.resolution,
      })),
  };

  return JSON.stringify(payload, null, 2);
}

function composeMcp(input: ComposeInput): string {
  const parts: string[] = [];

  parts.push(input.message);
  parts.push("");
  parts.push("---");
  parts.push("Undercurrent Context:");

  for (const layer of input.context) {
    parts.push(`  [${layer.source}] ${layer.summary}`);
  }

  if (input.assumptions.length > 0) {
    parts.push("");
    parts.push("Assumptions:");
    for (const a of input.assumptions) {
      parts.push(`  - ${a.claim} (${(a.confidence * 100).toFixed(0)}%)`);
    }
  }

  return parts.join("\n");
}

function composeChatGpt(input: ComposeInput): string {
  const parts: string[] = [];

  parts.push(`**Request**: ${input.message}`);
  parts.push("");

  if (input.intent.domainHints.length > 0) {
    parts.push(`**Domain**: ${input.intent.domainHints.join(", ")}`);
  }

  parts.push(
    `**Intent**: ${input.intent.action} (${input.intent.specificity} specificity, ${input.intent.scope} scope)`,
  );

  if (input.context.length > 0) {
    parts.push("");
    parts.push("**Context**:");
    for (const layer of input.context) {
      parts.push(`- *${layer.source}*: ${layer.summary}`);
    }
  }

  if (input.assumptions.length > 0) {
    parts.push("");
    parts.push("**Assumptions made**:");
    for (const a of input.assumptions) {
      parts.push(`- ${a.claim} (${(a.confidence * 100).toFixed(0)}% confidence)`);
    }
  }

  return parts.join("\n");
}

function composeGeneric(input: ComposeInput): string {
  const parts: string[] = [];

  parts.push(`[Original]: ${input.message}`);

  parts.push(
    `[Intent]: ${input.intent.action} (${input.intent.specificity} specificity, ${input.intent.scope} scope)`,
  );

  if (input.intent.domainHints.length > 0) {
    parts.push(`[Domain]: ${input.intent.domainHints.join(", ")}`);
  }

  if (input.context.length > 0) {
    parts.push("[Context]:");
    for (const layer of input.context) {
      parts.push(`  - ${layer.source}: ${layer.summary}`);
    }
  }

  if (input.assumptions.length > 0) {
    parts.push("[Assumptions]:");
    for (const a of input.assumptions) {
      parts.push(
        `  - ${a.claim} (confidence: ${(a.confidence * 100).toFixed(0)}%, basis: ${a.basis})`,
      );
    }
  }

  const filled = input.resolvedGaps.filter((g) => g.resolution?.type === "filled");
  if (filled.length > 0) {
    parts.push("[Auto-resolved]:");
    for (const gap of filled) {
      const r = gap.resolution as { value: string; source: string };
      parts.push(`  - ${gap.description} → ${r.value} (from ${r.source})`);
    }
  }

  return parts.join("\n");
}
