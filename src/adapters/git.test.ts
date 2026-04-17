import { describe, it, expect, vi } from "vitest";
import { GitAdapter } from "./git.js";
import type { AdapterInput, IntentSignal } from "../types.js";

const stubIntent: IntentSignal = {
  action: "fix",
  specificity: "medium",
  scope: "local",
  emotionalLoad: "neutral",
  confidence: 0.7,
  rawFragments: [],
  domainHints: [],
};

const stubInput: AdapterInput = {
  message: "fix the login bug",
  intent: stubIntent,
  conversation: [],
  existingContext: [],
};

function createMockAdapter(gitOutputs: Record<string, string | Error> = {}): GitAdapter {
  const defaults: Record<string, string> = {
    "rev-parse --is-inside-work-tree": "true\n",
    "rev-parse --abbrev-ref HEAD": "feat/auth-flow\n",
    "status --porcelain": " M src/auth.ts\n?? temp.log\nA  new-file.ts\nM  modified.ts\n",
    'log --oneline --format="%H|%s|%an|%ai" -15':
      "abc12345|fix login redirect|David|2026-04-17 10:00:00\ndef67890|add auth tests|David|2026-04-16 15:00:00\n",
    "diff --stat": " src/auth.ts | 10 +++++-----\n 1 file changed, 5 insertions(+), 5 deletions(-)",
  };

  const adapter = new GitAdapter({ cwd: "/fake/repo" });

  const mockGit = vi.fn(async (command: string): Promise<string> => {
    for (const [key, value] of Object.entries(gitOutputs)) {
      if (command.includes(key)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    for (const [key, value] of Object.entries(defaults)) {
      if (command.includes(key)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    return "";
  });

  (adapter as unknown as { git: typeof mockGit }).git = mockGit;
  return adapter;
}

describe("GitAdapter", () => {
  it("has correct name and priority", () => {
    const adapter = new GitAdapter();
    expect(adapter.name).toBe("git");
    expect(adapter.priority).toBe(2);
  });

  it("reports available when inside a git repo", async () => {
    const adapter = createMockAdapter();
    expect(await adapter.available()).toBe(true);
  });

  it("reports unavailable when not inside a git repo", async () => {
    const adapter = createMockAdapter({
      "rev-parse --is-inside-work-tree": new Error("not a git repo"),
    });
    expect(await adapter.available()).toBe(false);
  });

  it("gathers branch layer with status categorization", async () => {
    const adapter = createMockAdapter();
    const layers = await adapter.gather(stubInput);

    const branchLayer = layers.find((l) => l.summary.includes("On branch"));
    expect(branchLayer).toBeDefined();
    expect(branchLayer!.summary).toContain("feat/auth-flow");

    const data = branchLayer!.data as {
      branch: string;
      status: string[];
      modifiedFiles: string[];
      untrackedFiles: string[];
      stagedFiles: string[];
    };
    expect(data.branch).toBe("feat/auth-flow");
    expect(data.modifiedFiles.length).toBeGreaterThan(0);
    expect(data.untrackedFiles.length).toBeGreaterThan(0);
    expect(data.stagedFiles.length).toBeGreaterThan(0);
  });

  it("gathers commits layer with parsed commit data", async () => {
    const adapter = createMockAdapter();
    const layers = await adapter.gather(stubInput);

    const commitLayer = layers.find((l) => l.summary.includes("Last"));
    expect(commitLayer).toBeDefined();

    const commits = (
      commitLayer!.data as { commits: Array<{ hash: string; subject: string; author: string }> }
    ).commits;
    expect(commits.length).toBe(2);
    expect(commits[0]!.subject).toBe("fix login redirect");
    expect(commits[0]!.author).toBe("David");
  });

  it("gathers diff layer with stat summary", async () => {
    const adapter = createMockAdapter();
    const layers = await adapter.gather(stubInput);

    const diffLayer = layers.find((l) => l.summary.includes("Uncommitted changes"));
    expect(diffLayer).toBeDefined();
    expect((diffLayer!.data as { diffStat: string }).diffStat).toContain("src/auth.ts");
  });

  it("handles partial git failures gracefully", async () => {
    const adapter = createMockAdapter({
      "log --oneline": new Error("git log failed"),
      "diff --stat": new Error("git diff failed"),
    });

    const layers = await adapter.gather(stubInput);

    const branchLayer = layers.find((l) => l.summary.includes("On branch"));
    expect(branchLayer).toBeDefined();

    const commitLayer = layers.find((l) => l.summary.includes("Last"));
    expect(commitLayer).toBeUndefined();
    const diffLayer = layers.find((l) => l.summary.includes("Uncommitted changes"));
    expect(diffLayer).toBeUndefined();
  });

  it("skips diff layer when no uncommitted changes", async () => {
    const adapter = createMockAdapter({
      "diff --stat": "",
    });
    const layers = await adapter.gather(stubInput);

    const diffLayer = layers.find((l) => l.summary.includes("Uncommitted changes"));
    expect(diffLayer).toBeUndefined();
  });

  it("skips commits layer when no recent commits", async () => {
    const adapter = createMockAdapter({
      "log --oneline": "",
    });
    const layers = await adapter.gather(stubInput);

    const commitLayer = layers.find((l) => l.summary.includes("Last"));
    expect(commitLayer).toBeUndefined();
  });

  it("all layers have correct source name", async () => {
    const adapter = createMockAdapter();
    const layers = await adapter.gather(stubInput);

    for (const layer of layers) {
      expect(layer.source).toBe("git");
    }
  });

  it("respects maxCommits option", () => {
    const adapter = new GitAdapter({ maxCommits: 5 });
    expect((adapter as unknown as { maxCommits: number }).maxCommits).toBe(5);
  });
});
