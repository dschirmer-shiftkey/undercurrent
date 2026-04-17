import { describe, it, expect, vi } from "vitest";
import { Compactor } from "./compactor.js";
import type { ConversationTurn, SessionState } from "../types.js";

function makeSessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: "test-session-123",
    startedAt: Date.now() - 30 * 60 * 1000,
    messageCount: 10,
    estimatedTokens: 5000,
    tokenBudget: 100_000,
    topicShiftCount: 1,
    health: "degrading",
    lastCheckpoint: null,
    decisionsThisSession: ["Use PostgreSQL", "ESM-only modules"],
    activeWorkItems: ["implement auth flow"],
    unresolvedItems: ["CORS issue on staging"],
    ...overrides,
  };
}

function makeConversation(count: number): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (let i = 0; i < count; i++) {
    turns.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Turn ${i}: ${i % 2 === 0 ? "Let's work on the payment system using `stripe-sdk`" : "I'll implement the payment system with `stripe-sdk`. Let's go with TypeScript."}`,
      timestamp: Date.now() - (count - i) * 60_000,
    });
  }
  return turns;
}

describe("Compactor", () => {
  describe("heuristicCompact", () => {
    it("produces a CompactionResult with session decisions", () => {
      const compactor = new Compactor();
      const conversation = makeConversation(20);
      const state = makeSessionState();

      const result = compactor.heuristicCompact(conversation, state);

      expect(result.decisions).toContain("Use PostgreSQL");
      expect(result.decisions).toContain("ESM-only modules");
      expect(result.summary).toContain("decision");
    });

    it("includes active work from session state", () => {
      const compactor = new Compactor();
      const conversation = makeConversation(10);
      const state = makeSessionState({ activeWorkItems: ["build the API", "write tests"] });

      const result = compactor.heuristicCompact(conversation, state);

      expect(result.activeWork).toContain("build the API");
      expect(result.activeWork).toContain("write tests");
    });

    it("includes unresolved items from session state", () => {
      const compactor = new Compactor();
      const conversation = makeConversation(10);
      const state = makeSessionState({ unresolvedItems: ["CORS bug", "missing env var"] });

      const result = compactor.heuristicCompact(conversation, state);

      expect(result.unresolved).toContain("CORS bug");
      expect(result.unresolved).toContain("missing env var");
    });

    it("keeps recent exchanges", () => {
      const compactor = new Compactor();
      const conversation = makeConversation(20);
      const state = makeSessionState();

      const result = compactor.heuristicCompact(conversation, state);

      expect(result.recentExchanges.length).toBeLessThanOrEqual(10);
      expect(result.recentExchanges.length).toBeGreaterThan(0);
    });

    it("extracts terminology from backtick-delimited terms", () => {
      const compactor = new Compactor();
      const conversation: ConversationTurn[] = [
        { role: "user", content: "The `SessionMonitor` needs to track `tokenBudget`" },
        { role: "assistant", content: "I'll update `SessionMonitor` to include `tokenBudget` tracking" },
        { role: "user", content: "Also check the `SessionMonitor` health" },
      ];
      const state = makeSessionState();

      const result = compactor.heuristicCompact(conversation, state);

      expect(result.terminology["SessionMonitor"]).toBeTruthy();
    });

    it("reports estimated tokens saved", () => {
      const compactor = new Compactor();
      const conversation = makeConversation(30);
      const state = makeSessionState();

      const result = compactor.heuristicCompact(conversation, state);

      expect(result.estimatedTokensSaved).toBeGreaterThanOrEqual(0);
    });

    it("handles empty conversation gracefully", () => {
      const compactor = new Compactor();
      const state = makeSessionState({ messageCount: 0 });

      const result = compactor.heuristicCompact([], state);

      expect(result.summary).toBeTruthy();
      expect(result.recentExchanges).toEqual([]);
    });

    it("deduplicates decisions from both state and conversation", () => {
      const compactor = new Compactor();
      const conversation: ConversationTurn[] = [
        { role: "user", content: "let's go with PostgreSQL for the database" },
        { role: "assistant", content: "Understood, using PostgreSQL." },
      ];
      const state = makeSessionState({
        decisionsThisSession: ["let's go with PostgreSQL for the database"],
      });

      const result = compactor.heuristicCompact(conversation, state);

      const pgDecisions = result.decisions.filter((d) =>
        d.toLowerCase().includes("postgresql"),
      );
      expect(pgDecisions.length).toBeLessThanOrEqual(2);
    });
  });

  describe("LLM-assisted compact", () => {
    it("uses llmCall when provided", async () => {
      const llmCall = vi.fn().mockResolvedValue(
        "SUMMARY: Session focused on auth implementation\n" +
        "DECISIONS:\n- Use JWT tokens\n- 24h expiry\n" +
        "ACTIVE_WORK:\n- Login endpoint\n" +
        "UNRESOLVED:\n- Token refresh logic\n" +
        "TERMINOLOGY:\nJWT = JSON Web Token\nauthMiddleware = Express auth middleware",
      );

      const compactor = new Compactor({ llmCall });
      const conversation = makeConversation(10);
      const state = makeSessionState();

      const result = await compactor.compact(conversation, state);

      expect(llmCall).toHaveBeenCalledOnce();
      expect(result.summary).toContain("auth");
      expect(result.decisions).toContain("Use JWT tokens");
      expect(result.activeWork).toContain("Login endpoint");
      expect(result.unresolved).toContain("Token refresh logic");
      expect(result.terminology["JWT"]).toBe("JSON Web Token");
    });

    it("falls back to heuristic when llmCall throws", async () => {
      const llmCall = vi.fn().mockRejectedValue(new Error("API error"));

      const compactor = new Compactor({ llmCall });
      const conversation = makeConversation(10);
      const state = makeSessionState();

      const result = await compactor.compact(conversation, state);

      expect(llmCall).toHaveBeenCalledOnce();
      expect(result.decisions).toContain("Use PostgreSQL");
    });
  });

  describe("compact method", () => {
    it("uses heuristic by default (no llmCall)", async () => {
      const compactor = new Compactor();
      const conversation = makeConversation(10);
      const state = makeSessionState();

      const result = await compactor.compact(conversation, state);

      expect(result.decisions).toContain("Use PostgreSQL");
    });
  });
});
