import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Undercurrent } from "../index.js";
import { DefaultStrategy } from "../strategies/default.js";
import { KomatikIdentityAdapter } from "../komatik/identity-adapter.js";
import { KomatikHistoryAdapter } from "../komatik/history-adapter.js";
import { KomatikProjectAdapter } from "../komatik/project-adapter.js";
import { KomatikMarketplaceAdapter } from "../komatik/marketplace-adapter.js";
import { KomatikPreferenceAdapter } from "../komatik/preference-adapter.js";
import { KomatikOutcomeAdapter } from "../komatik/outcome-adapter.js";
import { KomatikMemoryAdapter } from "../komatik/memory-adapter.js";
import type { KomatikDataClient, KomatikWriteClient } from "../komatik/client.js";
import type { ContextLayer, ConversationTurn, TargetPlatform } from "../types.js";

export interface McpServerConfig {
  client: KomatikDataClient;
  userId: string;
  writeClient?: KomatikWriteClient;
}

/**
 * Creates an MCP server that exposes Undercurrent's enrichment pipeline
 * and Komatik user context to external tools via the MCP protocol.
 */
export function createUndercurrentMcpServer(config: McpServerConfig): McpServer {
  const { client, userId, writeClient } = config;

  const adapterOptions = { client, userId };

  const identityAdapter = new KomatikIdentityAdapter(adapterOptions);
  const preferenceAdapter = new KomatikPreferenceAdapter(adapterOptions);
  const memoryAdapter = new KomatikMemoryAdapter(adapterOptions);
  const historyAdapter = new KomatikHistoryAdapter(adapterOptions);
  const outcomeAdapter = new KomatikOutcomeAdapter(adapterOptions);
  const projectAdapter = new KomatikProjectAdapter(adapterOptions);
  const marketplaceAdapter = new KomatikMarketplaceAdapter(adapterOptions);

  const undercurrent = new Undercurrent({
    adapters: [
      identityAdapter,
      preferenceAdapter,
      memoryAdapter,
      historyAdapter,
      outcomeAdapter,
      projectAdapter,
      marketplaceAdapter,
    ],
    strategy: new DefaultStrategy(),
    targetPlatform: "mcp",
    suggestions: {
      enabled: true,
      writer: writeClient,
      userId,
    },
  });

  const server = new McpServer(
    { name: "undercurrent", version: "0.2.0" },
    { capabilities: { logging: {} } },
  );

  registerTools(server, undercurrent);
  registerResources(
    server,
    identityAdapter,
    preferenceAdapter,
    memoryAdapter,
    historyAdapter,
    outcomeAdapter,
    projectAdapter,
    marketplaceAdapter,
  );
  registerPrompts(
    server,
    identityAdapter,
    preferenceAdapter,
    memoryAdapter,
    historyAdapter,
    outcomeAdapter,
    projectAdapter,
    marketplaceAdapter,
  );

  return server;
}

function registerTools(server: McpServer, undercurrent: Undercurrent): void {
  server.registerTool(
    "enrich",
    {
      title: "Enrich Prompt",
      description:
        "Context engineering pipeline: runs a message through Undercurrent's 4-stage " +
        "enrichment (classify → harvest → analyze → compose) with full Komatik user " +
        "context. Returns the enriched prompt, intent classification, assumptions made, " +
        "gaps identified, and processing metadata.",
      inputSchema: {
        message: z.string().describe("The raw user message to enrich"),
        conversation: z
          .array(
            z.object({
              role: z.enum(["user", "assistant", "system"]),
              content: z.string(),
            }),
          )
          .optional()
          .describe("Prior conversation turns for context"),
        platform: z
          .enum(["cursor", "claude", "chatgpt", "api", "mcp", "generic"])
          .optional()
          .describe("Target platform for output formatting (defaults to mcp)"),
      },
    },
    async (args) => {
      const conversation: ConversationTurn[] | undefined = args.conversation?.map((t) => ({
        role: t.role,
        content: t.content,
      }));

      const result = await undercurrent.enrich({
        message: args.message,
        conversation,
        enrichmentContext: { source: "mcp-external" },
        targetPlatform: (args.platform as TargetPlatform | undefined) ?? "mcp",
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                enrichedMessage: result.enrichedMessage,
                intent: result.intent,
                context: result.context.map((c) => ({
                  source: c.source,
                  summary: c.summary,
                })),
                assumptions: result.assumptions.map((a) => ({
                  claim: a.claim,
                  confidence: a.confidence,
                  basis: a.basis,
                })),
                clarifications: result.clarifications.map((c) => ({
                  question: c.question,
                  reason: c.reason,
                })),
                gaps: result.gaps
                  .filter((g) => g.resolution?.type !== "filled")
                  .map((g) => ({
                    description: g.description,
                    critical: g.critical,
                  })),
                metadata: result.metadata,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_context",
    {
      title: "Get User Context",
      description:
        "Fetch the authenticated user's full Komatik context from all 7 adapters " +
        "(identity, preferences, memory, history, outcomes, projects, marketplace) " +
        "without running the enrichment pipeline. Returns raw context layers.",
    },
    async () => {
      const adapters = undercurrent.adapters;
      const layers: ContextLayer[] = [];

      const dummyInput = {
        message: "",
        intent: {
          action: "explore" as const,
          specificity: "low" as const,
          scope: "product" as const,
          emotionalLoad: "neutral" as const,
          confidence: 1,
          rawFragments: [],
          domainHints: [],
        },
        conversation: [],
        existingContext: [],
      };

      const results = await Promise.allSettled(
        adapters.map(async (adapter) => {
          const ok = await adapter.available();
          if (!ok) return [];
          return adapter.gather(dummyInput);
        }),
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          layers.push(...result.value);
        }
      }

      layers.sort((a, b) => a.priority - b.priority);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                userId: (layers[0]?.data as Record<string, unknown>)?.userId ?? "unknown",
                layers: layers.map((l) => ({
                  source: l.source,
                  priority: l.priority,
                  summary: l.summary,
                  data: l.data,
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "suggest_followups",
    {
      title: "Suggest Follow-up Prompts",
      description:
        "Experimental post-response reflection. Given the user's original message and " +
        "the agent's response, returns 3-5 auto-complete prompt suggestions (categorized " +
        "as continue / amend / stop) to render under the user's text input.",
      inputSchema: {
        originalMessage: z.string().describe("The user's most recent message"),
        agentResponse: z.string().describe("The agent's response to analyze"),
        conversation: z
          .array(
            z.object({
              role: z.enum(["user", "assistant", "system"]),
              content: z.string(),
            }),
          )
          .optional()
          .describe("Prior conversation turns for topic-shift detection"),
        platform: z
          .enum(["cursor", "claude", "chatgpt", "api", "mcp", "generic"])
          .optional()
          .describe("Target platform hint"),
      },
    },
    async (args) => {
      const conversation: ConversationTurn[] = (args.conversation ?? []).map((t) => ({
        role: t.role,
        content: t.content,
      }));

      const result = await undercurrent.suggestFollowups({
        originalMessage: args.originalMessage,
        agentResponse: args.agentResponse,
        conversation,
        targetPlatform: (args.platform as TargetPlatform | undefined) ?? "mcp",
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    "record_suggestion_feedback",
    {
      title: "Record Suggestion Feedback",
      description:
        "Log whether a follow-up suggestion was accepted, dismissed, or edited. " +
        "Feeds the enrichment_outcomes table so future scoring improves. No-op if " +
        "the MCP server was not configured with a write client.",
      inputSchema: {
        suggestionId: z.string().describe("The id returned by suggest_followups"),
        outcome: z.enum(["accepted", "dismissed", "edited"]),
        editedPromptText: z
          .string()
          .optional()
          .describe("If the user edited the suggestion before sending, the final text"),
        sessionId: z.string().optional(),
        platform: z.enum(["cursor", "claude", "chatgpt", "api", "mcp", "generic"]).optional(),
      },
    },
    async (args) => {
      await undercurrent.recordSuggestionFeedback({
        suggestionId: args.suggestionId,
        outcome: args.outcome,
        editedPromptText: args.editedPromptText,
        sessionId: args.sessionId,
        platform: args.platform as TargetPlatform | undefined,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
      };
    },
  );
}

function registerResources(
  server: McpServer,
  identity: KomatikIdentityAdapter,
  preferences: KomatikPreferenceAdapter,
  memory: KomatikMemoryAdapter,
  history: KomatikHistoryAdapter,
  outcomes: KomatikOutcomeAdapter,
  project: KomatikProjectAdapter,
  marketplace: KomatikMarketplaceAdapter,
): void {
  const dummyInput = {
    message: "",
    intent: {
      action: "explore" as const,
      specificity: "low" as const,
      scope: "product" as const,
      emotionalLoad: "neutral" as const,
      confidence: 1,
      rawFragments: [],
      domainHints: [],
    },
    conversation: [],
    existingContext: [],
  };

  server.registerResource(
    "user-profile",
    "komatik://user/profile",
    {
      title: "Komatik User Profile",
      description: "The authenticated user's identity, role, products used, and onboarding status.",
      mimeType: "application/json",
    },
    async () => {
      const layers = await identity.gather(dummyInput);
      const data = layers[0] ?? { summary: "No profile data available", data: {} };
      return {
        contents: [
          {
            uri: "komatik://user/profile",
            text: JSON.stringify({ summary: data.summary, ...data.data }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "user-history",
    "komatik://user/history",
    {
      title: "Komatik User History",
      description: "Recent product events, CRM activity, and behavioral trajectory.",
      mimeType: "application/json",
    },
    async () => {
      const layers = await history.gather(dummyInput);
      const combined = layers.map((l) => ({ source: l.source, summary: l.summary, data: l.data }));
      return {
        contents: [
          {
            uri: "komatik://user/history",
            text: JSON.stringify(combined, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "user-projects",
    "komatik://user/projects",
    {
      title: "Komatik User Projects",
      description: "Active triage intakes, Floe security scans, and ongoing diagnostic work.",
      mimeType: "application/json",
    },
    async () => {
      const layers = await project.gather(dummyInput);
      const combined = layers.map((l) => ({ source: l.source, summary: l.summary, data: l.data }));
      return {
        contents: [
          {
            uri: "komatik://user/projects",
            text: JSON.stringify(combined, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "user-tools",
    "komatik://user/tools",
    {
      title: "Komatik User Tools",
      description: "Forge marketplace tools used and authored by the user.",
      mimeType: "application/json",
    },
    async () => {
      const layers = await marketplace.gather(dummyInput);
      const combined = layers.map((l) => ({ source: l.source, summary: l.summary, data: l.data }));
      return {
        contents: [
          {
            uri: "komatik://user/tools",
            text: JSON.stringify(combined, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "user-preferences",
    "komatik://user/preferences",
    {
      title: "Komatik User Preferences",
      description:
        "The user's persistent tone, style, code conventions, and response format preferences.",
      mimeType: "application/json",
    },
    async () => {
      const layers = await preferences.gather(dummyInput);
      const data = layers[0] ?? { summary: "No preferences configured", data: {} };
      return {
        contents: [
          {
            uri: "komatik://user/preferences",
            text: JSON.stringify({ summary: data.summary, ...data.data }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "user-memory",
    "komatik://user/memory",
    {
      title: "Komatik Session Memory",
      description:
        "Cross-session persistent context: decisions, active work, unresolved items, and learned preferences.",
      mimeType: "application/json",
    },
    async () => {
      const layers = await memory.gather(dummyInput);
      const data = layers[0] ?? { summary: "No session memories", data: {} };
      return {
        contents: [
          {
            uri: "komatik://user/memory",
            text: JSON.stringify({ summary: data.summary, ...data.data }, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "user-outcomes",
    "komatik://user/outcomes",
    {
      title: "Komatik Enrichment Outcomes",
      description:
        "Feedback loop data: how the user responded to past enrichments (accepted, rejected, revised).",
      mimeType: "application/json",
    },
    async () => {
      const layers = await outcomes.gather(dummyInput);
      const data = layers[0] ?? { summary: "No enrichment outcomes recorded", data: {} };
      return {
        contents: [
          {
            uri: "komatik://user/outcomes",
            text: JSON.stringify({ summary: data.summary, ...data.data }, null, 2),
          },
        ],
      };
    },
  );
}

function registerPrompts(
  server: McpServer,
  identity: KomatikIdentityAdapter,
  preferences: KomatikPreferenceAdapter,
  memory: KomatikMemoryAdapter,
  history: KomatikHistoryAdapter,
  outcomes: KomatikOutcomeAdapter,
  project: KomatikProjectAdapter,
  marketplace: KomatikMarketplaceAdapter,
): void {
  const dummyInput = {
    message: "",
    intent: {
      action: "explore" as const,
      specificity: "low" as const,
      scope: "product" as const,
      emotionalLoad: "neutral" as const,
      confidence: 1,
      rawFragments: [],
      domainHints: [],
    },
    conversation: [],
    existingContext: [],
  };

  server.registerPrompt(
    "enrich-message",
    {
      title: "Enrich Message with Komatik Context",
      description:
        "System prompt template pre-loaded with the user's full Komatik context " +
        "(identity, history, projects, marketplace). Append this to any conversation " +
        "to give the AI complete awareness of who the user is.",
      argsSchema: {
        message: z.string().optional().describe("Optional user message to include"),
      },
    },
    async (args) => {
      const adapters = [identity, preferences, memory, history, outcomes, project, marketplace];
      const layers: ContextLayer[] = [];

      const results = await Promise.allSettled(
        adapters.map(async (a) => {
          const ok = await a.available();
          if (!ok) return [];
          return a.gather(dummyInput);
        }),
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          layers.push(...result.value);
        }
      }

      layers.sort((a, b) => a.priority - b.priority);

      const contextBlock =
        layers.length > 0
          ? layers.map((l) => `- [${l.source}]: ${l.summary}`).join("\n")
          : "No Komatik context available.";

      const systemContent =
        "You are assisting a Komatik ecosystem user. Here is their context:\n\n" +
        contextBlock +
        "\n\nUse this context to personalize your responses. " +
        "Reference their role, active projects, and product experience where relevant. " +
        "Do not ask for information that is already available in the context above.";

      const messages: Array<{
        role: "user" | "assistant";
        content: { type: "text"; text: string };
      }> = [
        { role: "user" as const, content: { type: "text" as const, text: systemContent } },
        {
          role: "assistant" as const,
          content: {
            type: "text" as const,
            text: "Understood. I have the user's Komatik context and will use it to personalize my responses.",
          },
        },
      ];

      if (args.message) {
        messages.push({
          role: "user" as const,
          content: { type: "text" as const, text: args.message },
        });
      }

      return { messages };
    },
  );
}
