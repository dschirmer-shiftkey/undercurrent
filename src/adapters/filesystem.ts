import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import type { AdapterInput, ContextAdapter, ContextLayer } from "../types.js";
import { estimateTokens } from "../engine/session-monitor.js";

interface FilesystemAdapterOptions {
  root: string;
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
  maxFileSize?: number;
  /** Total token cap across all file-content layers in a single gather() call. Default 5000. */
  maxContentTokens?: number;
  /** Model identifier — passed through to estimateTokens for accurate per-model budgeting. */
  model?: string;
}

interface FileEntry {
  path: string;
  relativePath: string;
  size: number;
  modifiedAt: number;
  extension: string;
}

/**
 * Gathers context from the local filesystem — project structure,
 * recently modified files, and file contents relevant to the user's intent.
 */
export class FilesystemAdapter implements ContextAdapter {
  readonly name = "filesystem";
  readonly priority = 3;

  private readonly root: string;
  private readonly include: string[];
  private readonly exclude: string[];
  private readonly maxFiles: number;
  private readonly maxFileSize: number;
  private readonly maxContentTokens: number;
  private readonly model: string | undefined;

  constructor(options: FilesystemAdapterOptions) {
    this.root = options.root;
    this.include = options.include ?? ["*"];
    this.exclude = options.exclude ?? [
      "node_modules",
      ".git",
      "dist",
      "build",
      ".next",
      "__pycache__",
      ".venv",
      "coverage",
    ];
    this.maxFiles = options.maxFiles ?? 20;
    this.maxFileSize = options.maxFileSize ?? 50_000;
    this.maxContentTokens = options.maxContentTokens ?? 5000;
    this.model = options.model;
  }

  async available(): Promise<boolean> {
    try {
      await stat(this.root);
      return true;
    } catch {
      return false;
    }
  }

  async gather(input: AdapterInput): Promise<ContextLayer[]> {
    const layers: ContextLayer[] = [];

    const structure = await this.getProjectStructure();
    if (structure.length > 0) {
      layers.push({
        source: this.name,
        priority: this.priority,
        timestamp: Date.now(),
        data: {
          fileCount: structure.length,
          extensions: this.countExtensions(structure),
          tree: structure.map((f) => f.relativePath),
        },
        summary: `Project has ${structure.length} files. Top types: ${this.topExtensions(structure)}`,
      });
    }

    const recentFiles = await this.getRecentlyModified(structure);
    if (recentFiles.length > 0) {
      layers.push({
        source: this.name,
        priority: this.priority,
        timestamp: Date.now(),
        data: {
          recentFiles: recentFiles.map((f) => ({
            path: f.relativePath,
            modifiedAt: f.modifiedAt,
          })),
        },
        summary: `Recently modified: ${recentFiles.map((f) => f.relativePath).join(", ")}`,
      });
    }

    const relevant = await this.findRelevantFiles(structure, input);
    let tokensUsed = 0;
    for (const file of relevant.slice(0, 5)) {
      if (tokensUsed >= this.maxContentTokens) break;
      try {
        const content = await readFile(file.path, "utf-8");
        if (content.length > this.maxFileSize) continue;

        const remaining = this.maxContentTokens - tokensUsed;
        const fileTokens = estimateTokens(content, this.model);
        let included = content;
        let truncated = false;
        if (fileTokens > remaining) {
          const ratio = remaining / fileTokens;
          included = content.slice(0, Math.max(0, Math.floor(content.length * ratio)));
          truncated = true;
        }
        const includedTokens = estimateTokens(included, this.model);
        tokensUsed += includedTokens;

        layers.push({
          source: this.name,
          priority: this.priority + 1,
          timestamp: Date.now(),
          data: {
            filePath: file.relativePath,
            content: included,
            size: included.length,
            originalSize: content.length,
            truncated,
            estimatedTokens: includedTokens,
          },
          summary: truncated
            ? `File content (truncated): ${file.relativePath} (${included.length}/${content.length} chars, ~${includedTokens} tokens)`
            : `File content: ${file.relativePath} (${content.length} chars, ~${includedTokens} tokens)`,
        });
      } catch {
        // unreadable file, skip
      }
    }

    return layers;
  }

  private async getProjectStructure(): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];
    await this.walkDir(this.root, entries, 0);
    return entries.slice(0, this.maxFiles * 10);
  }

  private async walkDir(dir: string, entries: FileEntry[], depth: number): Promise<void> {
    if (depth > 6) return;

    let items: string[];
    try {
      items = await readdir(dir);
    } catch {
      return;
    }

    for (const item of items) {
      if (this.exclude.some((ex) => item === ex || item.startsWith("."))) {
        continue;
      }

      const fullPath = join(dir, item);
      try {
        const s = await stat(fullPath);
        const relPath = relative(this.root, fullPath);

        if (s.isDirectory()) {
          await this.walkDir(fullPath, entries, depth + 1);
        } else if (s.isFile() && this.matchesInclude(item)) {
          entries.push({
            path: fullPath,
            relativePath: relPath,
            size: s.size,
            modifiedAt: s.mtimeMs,
            extension: extname(item),
          });
        }
      } catch {
        continue;
      }
    }
  }

  private matchesInclude(filename: string): boolean {
    if (this.include.length === 1 && this.include[0] === "*") return true;
    const ext = extname(filename);
    return this.include.some((pattern) => {
      if (pattern.startsWith("*.")) return ext === pattern.slice(1);
      if (pattern === "*") return true;
      return filename === pattern;
    });
  }

  private async getRecentlyModified(files: FileEntry[]): Promise<FileEntry[]> {
    return [...files].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 10);
  }

  private findRelevantFiles(files: FileEntry[], input: AdapterInput): FileEntry[] {
    const messageWords = new Set(
      input.message
        .toLowerCase()
        .split(/[\s,.\-_/\\]+/)
        .filter((w) => w.length > 2),
    );

    const domainHints = new Set(input.intent.domainHints.map((h) => h.toLowerCase()));

    return files
      .map((file) => {
        let score = 0;
        const pathLower = file.relativePath.toLowerCase();

        for (const word of messageWords) {
          if (pathLower.includes(word)) score += 2;
        }
        for (const hint of domainHints) {
          if (pathLower.includes(hint)) score += 3;
        }

        const hoursSinceModified = (Date.now() - file.modifiedAt) / (1000 * 60 * 60);
        if (hoursSinceModified < 1) score += 3;
        else if (hoursSinceModified < 24) score += 1;

        return { file, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.file);
  }

  private countExtensions(files: FileEntry[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const f of files) {
      const ext = f.extension || "(none)";
      counts[ext] = (counts[ext] ?? 0) + 1;
    }
    return counts;
  }

  private topExtensions(files: FileEntry[]): string {
    const counts = this.countExtensions(files);
    return Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 4)
      .map(([ext, count]) => `${ext}(${count})`)
      .join(", ");
  }
}
