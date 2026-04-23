import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { parseTranscript } from "./transcript-parser.js";

const FIXTURES = resolve(__dirname, "__fixtures__");

describe("parseTranscript", () => {
  it("parses Cursor-format transcripts and strips user_query tags", async () => {
    const entries = await parseTranscript(`${FIXTURES}/cursor-sample.jsonl`);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.rawMessage).toBe("fix the nav bug");
    expect(entries[1]!.rawMessage).toBe("also add a test");
    expect(entries[1]!.conversationSoFar).toHaveLength(2);
    expect(entries[1]!.conversationSoFar[0]!.role).toBe("user");
    expect(entries[1]!.conversationSoFar[1]!.role).toBe("assistant");
  });

  it("parses Claude Code-format transcripts", async () => {
    const entries = await parseTranscript(`${FIXTURES}/claude-code-sample.jsonl`);
    const messages = entries.map((e) => e.rawMessage);
    expect(messages).toEqual([
      "refactor the auth middleware",
      "also add rate limiting",
      "string-shaped content also works",
    ]);
  });

  it("skips queue-operation, summary, meta, sidechain, tool_result, and synthetic markers", async () => {
    const entries = await parseTranscript(`${FIXTURES}/claude-code-sample.jsonl`);
    const joined = entries.map((e) => e.rawMessage).join("\n");
    expect(joined).not.toContain("/loop");
    expect(joined).not.toContain("subagent internal");
    expect(joined).not.toContain("file contents here");
    expect(joined).not.toContain("[Request interrupted");
  });

  it("strips system-reminder tags from Claude Code messages", async () => {
    const entries = await parseTranscript(`${FIXTURES}/claude-code-sample.jsonl`);
    const rateLimitMsg = entries.find((e) => e.rawMessage.includes("rate limiting"));
    expect(rateLimitMsg).toBeDefined();
    expect(rateLimitMsg!.rawMessage).toBe("also add rate limiting");
  });

  it("builds conversationSoFar with assistant turns from Claude Code format", async () => {
    const entries = await parseTranscript(`${FIXTURES}/claude-code-sample.jsonl`);
    const second = entries[1]!;
    const assistantTurns = second.conversationSoFar.filter((t) => t.role === "assistant");
    expect(assistantTurns.length).toBeGreaterThan(0);
    expect(assistantTurns[0]!.content).toContain("Reading the middleware");
  });
});
