import { describe, it, expect } from "vitest";
import { createUndercurrentMcpServer } from "./server.js";
import { createMockClient } from "../komatik/testing.js";

type RegisteredTool = {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;
};
type RegisteredResource = {
  readCallback: (uri: URL, extra: unknown) => Promise<{ contents: Array<{ text: string }> }>;
};
type RegisteredPrompt = {
  callback: (args: Record<string, unknown>, extra: unknown) => Promise<{ messages: Array<{ role: string; content: { text: string } }> }>;
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
    const parsed = JSON.parse(text) as { userId: string; layers: Array<{ source: string; summary: string }> };

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
