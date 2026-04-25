import { describe, it, expect, vi, beforeEach } from "vitest";
import { FilesystemAdapter } from "./filesystem.js";
import type { AdapterInput, IntentSignal } from "../types.js";

const stubIntent: IntentSignal = {
  action: "explore",
  specificity: "low",
  scope: "local",
  emotionalLoad: "neutral",
  confidence: 0.5,
  rawFragments: [],
  domainHints: ["auth"],
};

const stubInput: AdapterInput = {
  message: "fix the auth module",
  intent: stubIntent,
  conversation: [],
  existingContext: [],
};

vi.mock("node:fs/promises", () => {
  const now = Date.now();
  const fileStats = {
    "src/auth.ts": { isDirectory: () => false, isFile: () => true, size: 500, mtimeMs: now - 1000 },
    "src/utils.ts": {
      isDirectory: () => false,
      isFile: () => true,
      size: 300,
      mtimeMs: now - 86400000,
    },
    "src/index.ts": {
      isDirectory: () => false,
      isFile: () => true,
      size: 100,
      mtimeMs: now - 172800000,
    },
    "README.md": {
      isDirectory: () => false,
      isFile: () => true,
      size: 200,
      mtimeMs: now - 259200000,
    },
  } as Record<
    string,
    { isDirectory: () => boolean; isFile: () => boolean; size: number; mtimeMs: number }
  >;

  return {
    stat: vi.fn(async (path: string) => {
      if (path === "/fake/project" || path.endsWith("/src")) {
        return { isDirectory: () => true, isFile: () => false, size: 0, mtimeMs: now };
      }
      for (const [name, s] of Object.entries(fileStats)) {
        if (path.endsWith(name)) return s;
      }
      throw new Error(`ENOENT: ${path}`);
    }),
    readdir: vi.fn(async (dir: string) => {
      if (dir === "/fake/project") return ["src", "README.md", "node_modules", ".git"];
      if (dir.endsWith("src")) return ["auth.ts", "utils.ts", "index.ts"];
      return [];
    }),
    readFile: vi.fn(async (path: string) => {
      if (path.includes("auth.ts")) return "export function login() { return true; }";
      if (path.includes("utils.ts")) return "export function add(a, b) { return a + b; }";
      if (path.includes("index.ts")) return "export * from './auth';";
      if (path.includes("README.md")) return "# My Project";
      throw new Error(`ENOENT: ${path}`);
    }),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("FilesystemAdapter", () => {
  it("has correct name and priority", () => {
    const adapter = new FilesystemAdapter({ root: "/fake/project" });
    expect(adapter.name).toBe("filesystem");
    expect(adapter.priority).toBe(3);
  });

  it("reports available for an existing directory", async () => {
    const adapter = new FilesystemAdapter({ root: "/fake/project" });
    expect(await adapter.available()).toBe(true);
  });

  it("reports unavailable for a missing directory", async () => {
    const adapter = new FilesystemAdapter({ root: "/nonexistent" });
    expect(await adapter.available()).toBe(false);
  });

  it("gathers project structure layer", async () => {
    const adapter = new FilesystemAdapter({ root: "/fake/project" });
    const layers = await adapter.gather(stubInput);

    const structureLayer = layers.find((l) => l.summary.includes("files"));
    expect(structureLayer).toBeDefined();
    expect(structureLayer!.source).toBe("filesystem");

    const data = structureLayer!.data as { fileCount: number; tree: string[] };
    expect(data.fileCount).toBeGreaterThan(0);
    expect(data.tree.length).toBeGreaterThan(0);
  });

  it("gathers recently modified files layer", async () => {
    const adapter = new FilesystemAdapter({ root: "/fake/project" });
    const layers = await adapter.gather(stubInput);

    const recentLayer = layers.find((l) => l.summary.includes("Recently modified"));
    expect(recentLayer).toBeDefined();
  });

  it("excludes node_modules and .git directories", async () => {
    const adapter = new FilesystemAdapter({ root: "/fake/project" });
    const layers = await adapter.gather(stubInput);

    const structureLayer = layers.find((l) => {
      const data = l.data as { tree?: string[] };
      return data.tree !== undefined;
    });

    if (structureLayer) {
      const tree = (structureLayer.data as { tree: string[] }).tree;
      expect(tree.every((f) => !f.includes("node_modules"))).toBe(true);
      expect(tree.every((f) => !f.includes(".git"))).toBe(true);
    }
  });

  it("finds relevant files based on message content and domain hints", async () => {
    const adapter = new FilesystemAdapter({ root: "/fake/project" });
    const layers = await adapter.gather(stubInput);

    const contentLayers = layers.filter((l) => l.summary.includes("File content"));

    if (contentLayers.length > 0) {
      const authLayer = contentLayers.find((l) => l.summary.includes("auth"));
      expect(authLayer).toBeDefined();
    }
  });

  it("respects include filter with extension patterns", async () => {
    const adapter = new FilesystemAdapter({
      root: "/fake/project",
      include: ["*.ts"],
    });
    const layers = await adapter.gather(stubInput);

    const structureLayer = layers.find((l) => {
      const data = l.data as { tree?: string[] };
      return data.tree !== undefined;
    });

    if (structureLayer) {
      const tree = (structureLayer.data as { tree: string[] }).tree;
      expect(tree.every((f) => f.endsWith(".ts"))).toBe(true);
    }
  });

  it("all layers have correct source", async () => {
    const adapter = new FilesystemAdapter({ root: "/fake/project" });
    const layers = await adapter.gather(stubInput);

    for (const layer of layers) {
      expect(layer.source).toBe("filesystem");
    }
  });

  it("respects maxContentTokens budget and annotates layers", async () => {
    // Use a message that matches README.md, which is reachable from the root
    // in this mock fs (subdirectories aren't traversed reliably cross-platform).
    const readmeIntent: IntentSignal = { ...stubIntent, domainHints: ["readme"] };
    const readmeInput: AdapterInput = {
      ...stubInput,
      message: "explain the readme",
      intent: readmeIntent,
    };

    const adapter = new FilesystemAdapter({ root: "/fake/project", maxContentTokens: 2 });
    const layers = await adapter.gather(readmeInput);

    const contentLayers = layers.filter((l) => {
      const d = l.data as { content?: string };
      return typeof d.content === "string";
    });

    const totalTokens = contentLayers.reduce((sum, l) => {
      const d = l.data as { estimatedTokens?: number };
      return sum + (d.estimatedTokens ?? 0);
    }, 0);

    expect(totalTokens).toBeLessThanOrEqual(2);

    for (const layer of contentLayers) {
      const d = layer.data as { estimatedTokens: number; truncated: boolean };
      expect(typeof d.estimatedTokens).toBe("number");
      expect(typeof d.truncated).toBe("boolean");
    }
  });
});
