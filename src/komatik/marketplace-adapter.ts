import type { AdapterInput, ContextAdapter, ContextLayer } from "../types.js";
import type { KomatikAdapterOptions, KomatikDataClient } from "./client.js";
import type { ForgeTool, ForgeUsage } from "./types.js";

/**
 * Queries forge_usage and forge_tools for the authenticated user.
 * Returns context about their marketplace activity: which MCP tools
 * they use most, whether they've authored tools, and usage patterns.
 */
export class KomatikMarketplaceAdapter implements ContextAdapter {
  readonly name = "komatik-marketplace";
  readonly priority = 3;

  private readonly client: KomatikDataClient;
  private readonly userId: string;
  private readonly maxUsageRecords: number;

  constructor(options: KomatikAdapterOptions & { maxUsageRecords?: number }) {
    this.client = options.client;
    this.userId = options.userId;
    this.maxUsageRecords = options.maxUsageRecords ?? 50;
  }

  async available(): Promise<boolean> {
    return Boolean(this.userId);
  }

  async gather(_input: AdapterInput): Promise<ContextLayer[]> {
    const layers: ContextLayer[] = [];

    const [usageResult, toolsResult] = await Promise.allSettled([
      this.fetchUsage(),
      this.fetchAuthoredTools(),
    ]);

    const usage = usageResult.status === "fulfilled" ? usageResult.value : [];
    const tools = toolsResult.status === "fulfilled" ? toolsResult.value : [];

    if (usage.length > 0 || tools.length > 0) {
      layers.push({
        source: this.name,
        priority: this.priority,
        timestamp: Date.now(),
        data: {
          forgeUsage: usage,
          forgeToolsAuthored: tools,
        },
        summary: this.summarize(usage, tools),
      });
    }

    return layers;
  }

  private async fetchUsage(): Promise<ForgeUsage[]> {
    const { data, error } = await this.client
      .from("forge_usage")
      .select("*")
      .eq("consumer_id", this.userId)
      .order("created_at", { ascending: false })
      .limit(this.maxUsageRecords);

    if (error || !data) return [];
    return data as unknown as ForgeUsage[];
  }

  private async fetchAuthoredTools(): Promise<ForgeTool[]> {
    const { data, error } = await this.client
      .from("forge_tools")
      .select("*")
      .eq("author_id", this.userId)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error || !data) return [];
    return data as unknown as ForgeTool[];
  }

  private summarize(usage: ForgeUsage[], tools: ForgeTool[]): string {
    const parts: string[] = [];

    if (usage.length > 0) {
      const toolUsageCounts = new Map<string, number>();
      for (const u of usage) {
        toolUsageCounts.set(u.tool_id, (toolUsageCounts.get(u.tool_id) ?? 0) + 1);
      }

      const uniqueTools = toolUsageCounts.size;
      const successRate =
        usage.length > 0
          ? ((usage.filter((u) => u.success).length / usage.length) * 100).toFixed(0)
          : "0";

      parts.push(
        `Used ${uniqueTools} Forge tool(s) (${usage.length} calls, ${successRate}% success)`,
      );
    }

    if (tools.length > 0) {
      const activeTools = tools.filter((t) => t.status === "active");
      const toolNames = tools
        .slice(0, 3)
        .map((t) => t.name)
        .join(", ");
      parts.push(`Authored ${tools.length} tool(s) (${activeTools.length} active): ${toolNames}`);
    }

    return parts.join(". ") || "No marketplace activity.";
  }
}
