import { readFile } from "node:fs/promises";
import type { ConversationTurn } from "../types.js";

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

interface CursorLine {
  role: "user" | "assistant";
  message: { content: ContentBlock[] };
}

interface ClaudeCodeLine {
  type: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: {
    role?: "user" | "assistant";
    content?: ContentBlock[] | string;
  };
}

type TranscriptLine = CursorLine | ClaudeCodeLine;

export interface ReplayEntry {
  index: number;
  rawMessage: string;
  conversationSoFar: ConversationTurn[];
}

const TAG_STRIP_PATTERNS = [
  /<user_query>\s*/g,
  /\s*<\/user_query>/g,
  /<attached_files>[\s\S]*?<\/attached_files>/g,
  /<system_reminder>[\s\S]*?<\/system_reminder>/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<open_and_recently_viewed_files>[\s\S]*?<\/open_and_recently_viewed_files>/g,
  /<user_info>[\s\S]*?<\/user_info>/g,
  /<git_status>[\s\S]*?<\/git_status>/g,
  /<agent_transcripts>[\s\S]*?<\/agent_transcripts>/g,
  /<rules>[\s\S]*?<\/rules>/g,
  /<agent_skills>[\s\S]*?<\/agent_skills>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g,
  /<bash-input>[\s\S]*?<\/bash-input>/g,
  /<bash-stdout>[\s\S]*?<\/bash-stdout>/g,
  /<bash-stderr>[\s\S]*?<\/bash-stderr>/g,
];

const SYNTHETIC_MARKERS = [
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
];

function stripSystemTags(text: string): string {
  let result = text;
  for (const pattern of TAG_STRIP_PATTERNS) {
    result = result.replace(pattern, "");
  }
  return result.trim();
}

function extractText(content: ContentBlock[] | string | undefined): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const textBlocks = content.filter((b) => b.type === "text" && typeof b.text === "string");
  if (textBlocks.length === 0) return null;
  return textBlocks.map((b) => b.text!).join("\n");
}

function normalizeLine(
  parsed: TranscriptLine,
): { role: "user" | "assistant"; text: string } | null {
  const cursorRole = (parsed as CursorLine).role;
  const ccType = (parsed as ClaudeCodeLine).type;

  if ((cursorRole === "user" || cursorRole === "assistant") && !ccType) {
    const text = extractText((parsed as CursorLine).message?.content);
    return text ? { role: cursorRole, text } : null;
  }

  if (ccType !== "user" && ccType !== "assistant") return null;
  const cc = parsed as ClaudeCodeLine;
  if (cc.isMeta || cc.isSidechain) return null;
  const role = cc.message?.role ?? (ccType as "user" | "assistant");
  const text = extractText(cc.message?.content);
  return text ? { role, text } : null;
}

function isRealUserMessage(cleaned: string): boolean {
  if (cleaned.length === 0) return false;
  if (SYNTHETIC_MARKERS.includes(cleaned)) return false;
  return true;
}

export async function parseTranscript(filePath: string): Promise<ReplayEntry[]> {
  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  const entries: ReplayEntry[] = [];
  const conversation: ConversationTurn[] = [];
  let userMessageIndex = 0;

  for (const line of lines) {
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }

    const normalized = normalizeLine(parsed);
    if (!normalized) continue;

    if (normalized.role === "user") {
      const cleaned = stripSystemTags(normalized.text);
      if (!isRealUserMessage(cleaned)) continue;

      entries.push({
        index: userMessageIndex++,
        rawMessage: cleaned,
        conversationSoFar: [...conversation],
      });

      conversation.push({ role: "user", content: cleaned });
    } else {
      const assistantText = normalized.text.slice(0, 2000);
      conversation.push({ role: "assistant", content: assistantText });
    }
  }

  return entries;
}

export async function discoverTranscripts(dir: string): Promise<string[]> {
  const { readdir, stat } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const paths: string[] = [];

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 2) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.name.endsWith(".jsonl")) {
        paths.push(full);
      }
    }
  }

  const root = await stat(dir).catch(() => null);
  if (!root) return paths;
  if (root.isFile() && dir.endsWith(".jsonl")) {
    paths.push(dir);
    return paths;
  }
  await walk(dir, 0);
  return paths;
}
