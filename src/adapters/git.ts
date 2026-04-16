import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { AdapterInput, ContextAdapter, ContextLayer } from "../types.js";

const execAsync = promisify(exec);

interface GitAdapterOptions {
  cwd?: string;
  maxCommits?: number;
}

interface GitCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

/**
 * Gathers context from git — branch state, recent commits, staged changes,
 * and working tree modifications. Tells the enrichment engine what the
 * developer has been working on and what's in-flight.
 */
export class GitAdapter implements ContextAdapter {
  readonly name = "git";
  readonly priority = 2;

  private readonly cwd: string;
  private readonly maxCommits: number;

  constructor(options?: GitAdapterOptions) {
    this.cwd = options?.cwd ?? process.cwd();
    this.maxCommits = options?.maxCommits ?? 15;
  }

  async available(): Promise<boolean> {
    try {
      await this.git("rev-parse --is-inside-work-tree");
      return true;
    } catch {
      return false;
    }
  }

  async gather(_input: AdapterInput): Promise<ContextLayer[]> {
    const layers: ContextLayer[] = [];

    const [branch, status, recentCommits, diff] = await Promise.allSettled([
      this.getCurrentBranch(),
      this.getStatus(),
      this.getRecentCommits(),
      this.getDiffSummary(),
    ]);

    const branchName =
      branch.status === "fulfilled" ? branch.value : "unknown";
    const statusLines =
      status.status === "fulfilled" ? status.value : [];
    const commits =
      recentCommits.status === "fulfilled" ? recentCommits.value : [];
    const diffStat =
      diff.status === "fulfilled" ? diff.value : "";

    layers.push({
      source: this.name,
      priority: this.priority,
      timestamp: Date.now(),
      data: {
        branch: branchName,
        status: statusLines,
        modifiedFiles: statusLines.filter((l) => l.startsWith(" M") || l.startsWith("M ")),
        untrackedFiles: statusLines.filter((l) => l.startsWith("??")),
        stagedFiles: statusLines.filter(
          (l) => l.startsWith("A ") || l.startsWith("M ") || l.startsWith("R "),
        ),
      },
      summary: `On branch ${branchName}. ${statusLines.length} changes in working tree.`,
    });

    if (commits.length > 0) {
      layers.push({
        source: this.name,
        priority: this.priority,
        timestamp: Date.now(),
        data: { commits },
        summary: `Last ${commits.length} commits: ${commits.slice(0, 3).map((c) => c.subject).join("; ")}`,
      });
    }

    if (diffStat) {
      layers.push({
        source: this.name,
        priority: this.priority,
        timestamp: Date.now(),
        data: { diffStat },
        summary: `Uncommitted changes: ${diffStat.split("\n").slice(-1)[0] ?? "none"}`,
      });
    }

    return layers;
  }

  private async getCurrentBranch(): Promise<string> {
    const result = await this.git("rev-parse --abbrev-ref HEAD");
    return result.trim();
  }

  private async getStatus(): Promise<string[]> {
    const result = await this.git("status --porcelain");
    return result
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  private async getRecentCommits(): Promise<GitCommit[]> {
    const format = "%H|%s|%an|%ai";
    const result = await this.git(
      `log --oneline --format="${format}" -${this.maxCommits}`,
    );
    return result
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, subject, author, date] = line.split("|");
        return {
          hash: hash?.slice(0, 8) ?? "",
          subject: subject ?? "",
          author: author ?? "",
          date: date ?? "",
        };
      });
  }

  private async getDiffSummary(): Promise<string> {
    const result = await this.git("diff --stat");
    return result.trim();
  }

  private async git(command: string): Promise<string> {
    const { stdout } = await execAsync(`git ${command}`, {
      cwd: this.cwd,
      timeout: 5000,
    });
    return stdout;
  }
}
