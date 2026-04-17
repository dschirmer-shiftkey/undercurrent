import { readFile } from "node:fs/promises";
import type { ConversationTurn } from "../types.js";

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface TranscriptLine {
  role: "user" | "assistant";
  message: {
    content: ContentBlock[];
  };
}

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
  /<open_and_recently_viewed_files>[\s\S]*?<\/open_and_recently_viewed_files>/g,
  /<user_info>[\s\S]*?<\/user_info>/g,
  /<git_status>[\s\S]*?<\/git_status>/g,
  /<agent_transcripts>[\s\S]*?<\/agent_transcripts>/g,
  /<rules>[\s\S]*?<\/rules>/g,
  /<agent_skills>[\s\S]*?<\/agent_skills>/g,
];

function stripSystemTags(text: string): string {
  let result = text;
  for (const pattern of TAG_STRIP_PATTERNS) {
    result = result.replace(pattern, "");
  }
  return result.trim();
}

function extractText(content: ContentBlock[]): string | null {
  const textBlocks = content.filter((b) => b.type === "text" && b.text);
  if (textBlocks.length === 0) return null;
  return textBlocks.map((b) => b.text!).join("\n");
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

    if (!parsed.role || !parsed.message?.content) continue;

    const text = extractText(parsed.message.content);
    if (!text) continue;

    if (parsed.role === "user") {
      const cleaned = stripSystemTags(text);
      if (cleaned.length === 0) continue;

      entries.push({
        index: userMessageIndex++,
        rawMessage: cleaned,
        conversationSoFar: [...conversation],
      });

      conversation.push({ role: "user", content: cleaned });
    } else if (parsed.role === "assistant") {
      const assistantText = text.slice(0, 2000);
      conversation.push({ role: "assistant", content: assistantText });
    }
  }

  return entries;
}

export async function discoverTranscripts(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const paths: string[] = [];

  const subdirs = await readdir(dir, { withFileTypes: true });
  for (const entry of subdirs) {
    if (entry.isDirectory()) {
      const subPath = join(dir, entry.name);
      const files = await readdir(subPath);
      for (const f of files) {
        if (f.endsWith(".jsonl")) {
          paths.push(join(subPath, f));
        }
      }
    } else if (entry.name.endsWith(".jsonl")) {
      paths.push(join(dir, entry.name));
    }
  }

  return paths;
}
