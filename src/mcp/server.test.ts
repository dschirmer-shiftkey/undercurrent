import { describe, it, expect } from "vitest";
import { createUndercurrentMcpServer } from "./server.js";
import { createMockClient } from "../komatik/testing.js";
import type {
  KomatikQueryResult,
  KomatikWriteClient,
  KomatikWriteFilterBuilder,
  KomatikWriteQueryBuilder,
} from "../komatik/client.js";

type RegisteredTool = {
  handler: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{ content: Array<{ text: string }> }>;
};
type RegisteredResource = {
  readCallback: (uri: URL, extra: unknown) => Promise<{ contents: Array<{ text: string }> }>;
};
type RegisteredPrompt = {
  callback: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{ messages: Array<{ role: string; content: { text: string } }> }>;
};

interface McpServerInternals {
  _registeredTools: Record<string, RegisteredTool>;
  _registeredResources: Record<string, RegisteredResource>;
  _registeredPrompts: Record<string, RegisteredPrompt>;
}

function getInternals(server: unknown): McpServerInternals {
  return server as unknown as McpServerInternals;
}

const EXTRA = {} as unknown;

interface ToolCacheRow {
  user_id: string;
  workspace_id?: string;
  session_id?: string;
  tool_slug: string;
  request_hash: string;
  request_summary: string;
  content_hash: string;
  content_size_bytes: number;
  content_token_estimate: number;
  result_text: string | null;
  memory_tier: "session" | "workspace";
  hit_count: number;
  created_at: string;
  expires_at: string;
}

function buildMockWriteClient(rows: ToolCacheRow[] = []): KomatikWriteClient {
  return {
    from(table: string): KomatikWriteQueryBuilder {
      return {
        select(): KomatikWriteFilterBuilder {
          return createResolvedFilterBuilder([]);
        },
        insert(data: Record<string, unknown> | Record<string, unknown>[]): KomatikWriteFilterBuilder {
          if (table === "tool_result_cache") {
            const records = Array.isArray(data) ? data : [data];
            for (const record of records) {
              rows.push({
                user_id: String(record.user_id),
                workspace_id:
                  typeof record.workspace_id === "string" ? record.workspace_id : undefined,
                session_id: typeof record.session_id === "string" ? record.session_id : undefined,
                tool_slug: String(record.tool_slug),
                request_hash: String(record.request_hash),
                request_summary: String(record.request_summary),
                content_hash: String(record.content_hash),
                content_size_bytes: Number(record.content_size_bytes),
                content_token_estimate: Number(record.content_token_estimate),
                result_text: typeof record.result_text === "string" ? record.result_text : null,
                memory_tier:
                  record.memory_tier === "workspace" || record.memory_tier === "session"
                    ? record.memory_tier
                    : "session",
                hit_count: 0,
                created_at: new Date().toISOString(),
                expires_at: String(record.expires_at),
              });
            }
          }
          return createResolvedFilterBuilder([]);
        },
        upsert(): KomatikWriteFilterBuilder {
          return createResolvedFilterBuilder([]);
        },
        delete(): KomatikWriteFilterBuilder {
          return createResolvedFilterBuilder([]);
        },
        update(): KomatikWriteFilterBuilder {
          return createResolvedFilterBuilder([]);
        },
      };
    },
    rpc(
      functionName: string,
      params?: Record<string, unknown>,
    ): PromiseLike<KomatikQueryResult<Record<string, unknown>[]>> {
      if (functionName !== "lookup_tool_result_cache") {
        return Promise.resolve({
          data: null,
          error: { message: `Unexpected RPC: ${functionName}` },
        });
      }
      const candidate = rows
        .filter(
          (row) =>
            row.user_id === params?.p_user_id &&
            row.tool_slug === params?.p_tool_slug &&
            row.request_hash === params?.p_request_hash &&
            new Date(row.expires_at).getTime() > Date.now() &&
            (!params?.p_memory_tier || row.memory_tier === params.p_memory_tier),
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

      if (!candidate) {
        return Promise.resolve({ data: [], error: null });
      }

      candidate.hit_count += 1;
      return Promise.resolve({
        data: [
          {
            content_hash: candidate.content_hash,
            content_size_bytes: candidate.content_size_bytes,
            content_token_estimate: candidate.content_token_estimate,
            result_text: candidate.result_text,
            hit_count: candidate.hit_count,
            memory_tier: candidate.memory_tier,
            created_at: candidate.created_at,
          },
        ],
        error: null,
      });
    },
  };
}

function createResolvedFilterBuilder(
  rows: Record<string, unknown>[],
): KomatikWriteFilterBuilder {
  const result: KomatikQueryResult<Record<string, unknown>[]> = { data: rows, error: null };
  const builder: KomatikWriteFilterBuilder = {
    eq(): KomatikWriteFilterBuilder {
      return builder;
    },
    neq(): KomatikWriteFilterBuilder {
      return builder;
    },
    in(): KomatikWriteFilterBuilder {
      return builder;
    },
    lt(): KomatikWriteFilterBuilder {
      return builder;
    },
    order(): KomatikWriteFilterBuilder {
      return builder;
    },
    limit(): KomatikWriteFilterBuilder {
      return builder;
    },
    single(): PromiseLike<KomatikQueryResult<Record<string, unknown>>> {
      return Promise.resolve({
        data: rows[0] ?? null,
        error: rows[0] ? null : { message: "No rows found" },
      });
    },
    then<TResult1 = KomatikQueryResult<Record<string, unknown>[]>, TResult2 = never>(
      onfulfilled?:
        | ((value: KomatikQueryResult<Record<string, unknown>[]>) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve(result).then(onfulfilled, onrejected);
    },
  };
  return builder;
}

function parseToolPayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function buildMockConfig() {
  const client = createMockClient({
    komatik_profiles: [
      {
        id: "user-1",
        email: "dev@komatik.xyz",
        display_name: "Alex Dev",
        primary_role: "founder",
        products_used: ["triage", "floe", "forge"],
        onboarding_complete: true,
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2026-04-01T00:00:00Z",
      },
    ],
    user_product_events: [
      {
        id: "evt-1",
        user_id: "user-1",
        product: "triage",
        event_type: "intake_submitted",
        metadata: { project: "api-overhaul" },
        created_at: "2026-04-10T00:00:00Z",
      },
      {
        id: "evt-2",
        user_id: "user-1",
        product: "floe",
        event_type: "scan_completed",
        metadata: { findings: 3 },
        created_at: "2026-04-12T00:00:00Z",
      },
    ],
    crm_activities: [
      {
        id: "act-1",
        contact_id: "contact-1",
        type: "meeting",
        description: "Quarterly review",
        created_at: "2026-04-08T00:00:00Z",
      },
    ],
    triage_intakes: [
      {
        id: "intake-1",
        user_id: "user-1",
        title: "API Performance Overhaul",
        project_type: "optimization",
        urgency: "high",
        status: "active",
        description: "Response times exceeding 2s on /api/products",
        created_at: "2026-04-05T00:00:00Z",
      },
    ],
    floe_scans: [
      {
        id: "scan-1",
        user_id: "user-1",
        repository_url: "https://github.com/komatik/platform",
        tier: "deep",
        status: "completed",
        findings_count: 3,
        critical_count: 1,
        created_at: "2026-04-12T00:00:00Z",
      },
    ],
    forge_usage: [
      {
        id: "usage-1",
        user_id: "user-1",
        tool_id: "tool-a",
        invocation_count: 42,
        last_used_at: "2026-04-14T00:00:00Z",
      },
    ],
    forge_tools: [
      {
        id: "tool-a",
        name: "Code Analyzer",
        slug: "code-analyzer",
        category: "development",
        author_id: "user-1",
        status: "published",
        pricing_model: "free",
        install_count: 150,
        created_at: "2026-02-01T00:00:00Z",
      },
    ],
  });

  return { client, userId: "user-1" };
}

function buildEmptyConfig() {
  const client = createMockClient({});
  return { client, userId: "user-1" };
}

describe("createUndercurrentMcpServer", () => {
  it("creates a server instance", () => {
    const server = createUndercurrentMcpServer(buildMockConfig());
    expect(server).toBeDefined();
    expect(server.server).toBeDefined();
  });
});

describe("enrich tool", () => {
  it("enriches a message with Komatik user context", async () => {
    const server = createUndercurrentMcpServer(buildMockConfig());
    const tool = getInternals(server)._registeredTools["enrich"]!;

    const result = await tool.handler({ message: "help me fix the slow API endpoints" }, EXTRA);

    const text = result.content[0]!.text;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.enrichedMessage).toBeDefined();
    expect(parsed.intent).toBeDefined();
    expect(parsed.metadata).toBeDefined();

    const enriched = parsed.enrichedMessage as string;
    expect(enriched).toContain("fix");
  });

  it("includes komatik context in enrichment", async () => {
    const server = createUndercurrentMcpServer(buildMockConfig());
    const tool = getInternals(server)._registeredTools["enrich"]!;

    const result = await tool.handler({ message: "what projects am I working on" }, EXTRA);

    const text = result.content[0]!.text;
    const parsed = JSON.parse(text) as { context: Array<{ source: string; summary: string }> };
    const sources = parsed.context.map((c) => c.source);
    expect(sources).toContain("komatik-identity");
  });
});

describe("get_context tool", () => {
  it("returns context layers from all adapters", async () => {
    const server = createUndercurrentMcpServer(buildMockConfig());
    const tool = getInternals(server)._registeredTools["get_context"]!;

    const result = await tool.handler({}, EXTRA);

    const text = result.content[0]!.text;
    const parsed = JSON.parse(text) as {
      userId: string;
      layers: Array<{ source: string; summary: string }>;
    };

    expect(parsed.userId).toBe("user-1");
    expect(parsed.layers.length).toBeGreaterThan(0);

    const sources = parsed.layers.map((l) => l.source);
    expect(sources).toContain("komatik-identity");
    expect(sources).toContain("komatik-history");
    expect(sources).toContain("komatik-projects");
    expect(sources).toContain("komatik-marketplace");
  });

  it("returns profile summary in identity layer", async () => {
    const server = createUndercurrentMcpServer(buildMockConfig());
    const tool = getInternals(server)._registeredTools["get_context"]!;

    const result = await tool.handler({}, EXTRA);

    const text = result.content[0]!.text;
    const parsed = JSON.parse(text) as { layers: Array<{ source: string; summary: string }> };
    const identityLayer = parsed.layers.find((l) => l.source === "komatik-identity");
    expect(identityLayer).toBeDefined();
    expect(identityLayer!.summary).toContain("Alex Dev");
    expect(identityLayer!.summary).toContain("founder");
  });

  it("gracefully handles empty data", async () => {
    const server = createUndercurrentMcpServer(buildEmptyConfig());
    const tool = getInternals(server)._registeredTools["get_context"]!;

    const result = await tool.handler({}, EXTRA);

    const text = result.content[0]!.text;
    const parsed = JSON.parse(text) as { layers: unknown[] };
    expect(parsed.layers).toEqual([]);
  });
});

describe("digest_tool_result tool", () => {
  it("returns firstSeen and inserts a new cache row", async () => {
    const rows: ToolCacheRow[] = [];
    const server = createUndercurrentMcpServer({
      ...buildMockConfig(),
      writeClient: buildMockWriteClient(rows),
    });
    const tool = getInternals(server)._registeredTools["digest_tool_result"]!;

    const result = await tool.handler(
      {
        toolSlug: "read_file",
        requestSummary: "read package.json",
        requestKey: { path: "package.json" },
        result: '{"name":"undercurrent"}',
      },
      EXTRA,
    );

    const parsed = parseToolPayload(result);
    expect(parsed.firstSeen).toBe(true);
    expect(parsed.cached).toBe(false);
    expect(parsed.result).toBe('{"name":"undercurrent"}');
    expect(rows.length).toBe(1);
    expect(rows[0]!.result_text).toBe('{"name":"undercurrent"}');
  });

  it("returns a cache reference for repeated identical content", async () => {
    const rows: ToolCacheRow[] = [];
    const writeClient = buildMockWriteClient(rows);
    const server = createUndercurrentMcpServer({ ...buildMockConfig(), writeClient });
    const tool = getInternals(server)._registeredTools["digest_tool_result"]!;
    const args = {
      toolSlug: "read_file",
      requestSummary: "read package.json",
      requestKey: { path: "package.json" },
      result: '{"name":"undercurrent"}',
    };

    await tool.handler(args, EXTRA);
    const result = await tool.handler(args, EXTRA);

    const parsed = parseToolPayload(result);
    expect(parsed.cached).toBe(true);
    expect(parsed.ref).toBeDefined();
    expect(parsed.note).toContain("tokens elided");
    expect(parsed.hitCount).toBe(2);
    expect(rows.length).toBe(1);
  });

  it("returns fresh content and flags drift when the same request changes", async () => {
    const rows: ToolCacheRow[] = [];
    const writeClient = buildMockWriteClient(rows);
    const server = createUndercurrentMcpServer({ ...buildMockConfig(), writeClient });
    const tool = getInternals(server)._registeredTools["digest_tool_result"]!;

    await tool.handler(
      {
        toolSlug: "read_file",
        requestSummary: "read src/index.ts",
        requestKey: { path: "src/index.ts" },
        result: "export const version = '0.3.1';",
      },
      EXTRA,
    );
    const result = await tool.handler(
      {
        toolSlug: "read_file",
        requestSummary: "read src/index.ts",
        requestKey: { path: "src/index.ts" },
        result: "export const version = '0.4.1';",
      },
      EXTRA,
    );

    const parsed = parseToolPayload(result);
    expect(parsed.drifted).toBe(true);
    expect(parsed.result).toBe("export const version = '0.4.1';");
    expect(rows.length).toBe(2);
  });

  it("passes through unchanged when no write client is configured", async () => {
    const server = createUndercurrentMcpServer(buildMockConfig());
    const tool = getInternals(server)._registeredTools["digest_tool_result"]!;

    const result = await tool.handler(
      {
        toolSlug: "read_file",
        requestSummary: "read package.json",
        requestKey: { path: "package.json" },
        result: "fresh content",
      },
      EXTRA,
    );

    const parsed = parseToolPayload(result);
    expect(parsed.firstSeen).toBe(true);
    expect(parsed.result).toBe("fresh content");
    expect(parsed.meta).toEqual({ reason: "no_write_client_configured" });
  });

  it("canonicalizes object request keys", async () => {
    const rows: ToolCacheRow[] = [];
    const writeClient = buildMockWriteClient(rows);
    const server = createUndercurrentMcpServer({ ...buildMockConfig(), writeClient });
    const tool = getInternals(server)._registeredTools["digest_tool_result"]!;

    await tool.handler(
      {
        toolSlug: "search_files",
        requestSummary: "search TODO",
        requestKey: { pattern: "TODO", glob: "*.ts" },
        result: "src/index.ts:1:TODO",
      },
      EXTRA,
    );
    const result = await tool.handler(
      {
        toolSlug: "search_files",
        requestSummary: "search TODO",
        requestKey: { glob: "*.ts", pattern: "TODO" },
        result: "src/index.ts:1:TODO",
      },
      EXTRA,
    );

    const parsed = parseToolPayload(result);
    expect(parsed.cached).toBe(true);
    expect(rows.length).toBe(1);
  });

  it("stores oversized results as ref-only", async () => {
    const rows: ToolCacheRow[] = [];
    const server = createUndercurrentMcpServer({
      ...buildMockConfig(),
      writeClient: buildMockWriteClient(rows),
    });
    const tool = getInternals(server)._registeredTools["digest_tool_result"]!;
    const largeResult = "x".repeat(100_001);

    const result = await tool.handler(
      {
        toolSlug: "read_file",
        requestSummary: "read large file",
        requestKey: { path: "large.txt" },
        result: largeResult,
      },
      EXTRA,
    );

    const parsed = parseToolPayload(result);
    expect(parsed.firstSeen).toBe(true);
    expect(rows[0]!.result_text).toBeNull();
    expect(rows[0]!.content_size_bytes).toBe(100_001);
  });
});

describe("resources", () => {
  it("registers 7 resources", () => {
    const server = createUndercurrentMcpServer(buildMockConfig());
    const resources = getInternals(server)._registeredResources;

    const keys = Object.keys(resources);
    expect(keys.length).toBe(7);
    expect(resources["komatik://user/profile"]).toBeDefined();
    expect(resources["komatik://user/history"]).toBeDefined();
    expect(resources["komatik://user/projects"]).toBeDefined();
    expect(resources["komatik://user/tools"]).toBeDefined();
    expect(resources["komatik://user/preferences"]).toBeDefined();
    expect(resources["komatik://user/memory"]).toBeDefined();
    expect(resources["komatik://user/outcomes"]).toBeDefined();
  });

  it("profile resource returns user identity", async () => {
    const server = createUndercurrentMcpServer(buildMockConfig());
    const resource = getInternals(server)._registeredResources["komatik://user/profile"]!;

    const result = await resource.readCallback(new URL("komatik://user/profile"), EXTRA);
    const text = result.contents[0]!.text;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.summary).toContain("Alex Dev");
  });

  it("projects resource returns active work", async () => {
    const server = createUndercurrentMcpServer(buildMockConfig());
    const resource = getInternals(server)._registeredResources["komatik://user/projects"]!;

    const result = await resource.readCallback(new URL("komatik://user/projects"), EXTRA);
    const text = result.contents[0]!.text;
    const parsed = JSON.parse(text) as Array<{ source: string; summary: string }>;
    expect(parsed.length).toBeGreaterThan(0);
    const sources = parsed.map((p) => p.source);
    expect(sources).toContain("komatik-projects");
  });
});

describe("prompts", () => {
  it("registers enrich-message prompt", () => {
    const server = createUndercurrentMcpServer(buildMockConfig());
    const prompts = getInternals(server)._registeredPrompts;
    expect(prompts["enrich-message"]).toBeDefined();
  });

  it("enrich-message returns context-loaded system prompt", async () => {
    const server = createUndercurrentMcpServer(buildMockConfig());
    const prompt = getInternals(server)._registeredPrompts["enrich-message"]!;

    const result = await prompt.callback({}, EXTRA);
    expect(result.messages.length).toBe(2);
    expect(result.messages[0]!.role).toBe("user");

    const systemText = result.messages[0]!.content.text;
    expect(systemText).toContain("Komatik ecosystem user");
    expect(systemText).toContain("Alex Dev");
  });

  it("enrich-message appends user message when provided", async () => {
    const server = createUndercurrentMcpServer(buildMockConfig());
    const prompt = getInternals(server)._registeredPrompts["enrich-message"]!;

    const result = await prompt.callback({ message: "How do I deploy?" }, EXTRA);
    expect(result.messages.length).toBe(3);
    expect(result.messages[2]!.content.text).toBe("How do I deploy?");
  });

  it("handles empty context gracefully in prompt", async () => {
    const server = createUndercurrentMcpServer(buildEmptyConfig());
    const prompt = getInternals(server)._registeredPrompts["enrich-message"]!;

    const result = await prompt.callback({}, EXTRA);
    const systemText = result.messages[0]!.content.text;
    expect(systemText).toContain("No Komatik context available");
  });
});
