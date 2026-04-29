import { describe, it, expect } from "vitest";
import { SessionMonitor, estimateTokens } from "./session-monitor.js";

describe("SessionMonitor", () => {
  it("starts in cold-start state", () => {
    const monitor = new SessionMonitor();
    expect(monitor.getHealth()).toBe("cold-start");
    expect(monitor.getState().messageCount).toBe(0);
    expect(monitor.getState().sessionId).toBeTruthy();
  });

  it("transitions to healthy after first message with conversation", () => {
    const monitor = new SessionMonitor();
    const health = monitor.track("hello", [{ role: "user", content: "previous message" }]);
    expect(health).toBe("healthy");
  });

  it("stays cold-start on first message with no conversation", () => {
    const monitor = new SessionMonitor();
    const health = monitor.track("hello", []);
    expect(health).toBe("cold-start");
  });

  it("tracks message count", () => {
    const monitor = new SessionMonitor();
    monitor.track("one", [{ role: "user", content: "one" }]);
    monitor.track("two", [{ role: "user", content: "two" }]);
    monitor.track("three", [{ role: "user", content: "three" }]);
    expect(monitor.getState().messageCount).toBe(3);
  });

  it("accumulates estimated tokens", () => {
    const monitor = new SessionMonitor({ tokenBudget: 100_000 });
    monitor.track("a short message", [{ role: "user", content: "ctx" }]);
    expect(monitor.getState().estimatedTokens).toBeGreaterThan(0);
  });

  it("transitions to warm when token budget passes 40%", () => {
    const monitor = new SessionMonitor({ tokenBudget: 100 });
    const longMessage = "x".repeat(200);
    const health = monitor.track(longMessage, [{ role: "user", content: "ctx" }]);
    expect(health).toBe("warm");
  });

  it("transitions to degrading when token budget passes 65%", () => {
    const monitor = new SessionMonitor({ tokenBudget: 100 });
    const longMessage = "x".repeat(300);
    const health = monitor.track(longMessage, [{ role: "user", content: "ctx" }]);
    expect(health).toBe("degrading");
  });

  it("transitions to critical when token budget passes 85%", () => {
    const monitor = new SessionMonitor({ tokenBudget: 100 });
    const longMessage = "x".repeat(400);
    const health = monitor.track(longMessage, [{ role: "user", content: "ctx" }]);
    expect(health).toBe("critical");
  });

  it("detects topic shifts from unrelated messages", () => {
    const monitor = new SessionMonitor({ tokenBudget: 100_000 });
    monitor.track("implement the payment processing system with stripe integration", [
      { role: "user", content: "ctx" },
    ]);
    monitor.track("now let's work on the kubernetes deployment configuration", [
      { role: "user", content: "ctx" },
    ]);
    expect(monitor.getState().topicShiftCount).toBeGreaterThanOrEqual(1);
  });

  it("does not count topic shifts for related messages", () => {
    const monitor = new SessionMonitor({ tokenBudget: 100_000 });
    monitor.track("implement the payment system", [{ role: "user", content: "ctx" }]);
    monitor.track("add payment validation to the payment system", [
      { role: "user", content: "ctx" },
    ]);
    expect(monitor.getState().topicShiftCount).toBe(0);
  });

  it("extracts decision signals from user messages", () => {
    const monitor = new SessionMonitor();
    monitor.track("let's go with PostgreSQL for the database layer", [
      { role: "user", content: "ctx" },
    ]);
    expect(monitor.getState().decisionsThisSession.length).toBeGreaterThanOrEqual(1);
  });

  it("needsCheckpoint returns true after interval messages", () => {
    const monitor = new SessionMonitor({ checkpointInterval: 3 });
    monitor.track("one", [{ role: "user", content: "one" }]);
    expect(monitor.needsCheckpoint()).toBe(false);
    monitor.track("two", [{ role: "user", content: "two" }]);
    expect(monitor.needsCheckpoint()).toBe(false);
    monitor.track("three", [{ role: "user", content: "three" }]);
    expect(monitor.needsCheckpoint()).toBe(true);
  });

  it("markCheckpoint resets the checkpoint counter", () => {
    const monitor = new SessionMonitor({ checkpointInterval: 2 });
    monitor.track("one", [{ role: "user", content: "one" }]);
    monitor.track("two", [{ role: "user", content: "two" }]);
    expect(monitor.needsCheckpoint()).toBe(true);
    monitor.markCheckpoint();
    expect(monitor.needsCheckpoint()).toBe(false);
    monitor.track("three", [{ role: "user", content: "three" }]);
    expect(monitor.needsCheckpoint()).toBe(false);
    monitor.track("four", [{ role: "user", content: "four" }]);
    expect(monitor.needsCheckpoint()).toBe(true);
  });

  it("addDecision records to state", () => {
    const monitor = new SessionMonitor();
    monitor.addDecision("Use TypeScript strict mode");
    expect(monitor.getState().decisionsThisSession).toContain("Use TypeScript strict mode");
  });

  it("setActiveWork replaces work items", () => {
    const monitor = new SessionMonitor();
    monitor.setActiveWork(["implement auth", "write tests"]);
    expect(monitor.getState().activeWorkItems).toEqual(["implement auth", "write tests"]);
    monitor.setActiveWork(["deploy"]);
    expect(monitor.getState().activeWorkItems).toEqual(["deploy"]);
  });

  it("addUnresolved deduplicates items", () => {
    const monitor = new SessionMonitor();
    monitor.addUnresolved("fix the bug");
    monitor.addUnresolved("fix the bug");
    expect(monitor.getState().unresolvedItems).toEqual(["fix the bug"]);
  });

  it("resolveItem removes from unresolved", () => {
    const monitor = new SessionMonitor();
    monitor.addUnresolved("fix the bug");
    monitor.addUnresolved("update docs");
    monitor.resolveItem("fix the bug");
    expect(monitor.getState().unresolvedItems).toEqual(["update docs"]);
  });

  it("transitions to degrading on drift+age combo even below the token threshold", () => {
    const monitor = new SessionMonitor({ tokenBudget: 1_000_000 });
    // Force the session to look 31 minutes old.
    const state = monitor.getState() as { startedAt: number };
    (monitor as unknown as { state: { startedAt: number } }).state.startedAt =
      Date.now() - 31 * 60 * 1000;

    monitor.track("payment processing system with stripe integration", [
      { role: "user", content: "ctx" },
    ]);
    monitor.track("kubernetes deployment configuration manifests", [
      { role: "user", content: "ctx" },
    ]);
    monitor.track("rewrite the marketing site copy in french", [
      { role: "user", content: "ctx" },
    ]);
    monitor.track("debug the photo upload widget on mobile safari", [
      { role: "user", content: "ctx" },
    ]);

    expect(monitor.getState().topicShiftCount).toBeGreaterThanOrEqual(3);
    expect(monitor.getHealth()).toBe("degrading");
  });

  it("resetAfterCompaction reduces token count and recalculates health", () => {
    const monitor = new SessionMonitor({ tokenBudget: 1000 });
    const longMessage = "x".repeat(3500);
    monitor.track(longMessage, [{ role: "user", content: "ctx" }]);
    expect(monitor.getHealth()).toBe("critical");
    monitor.resetAfterCompaction(100);
    expect(monitor.getHealth()).toBe("healthy");
    expect(monitor.getState().estimatedTokens).toBe(100);
  });

  it("getState returns a copy, not a reference", () => {
    const monitor = new SessionMonitor();
    const state1 = monitor.getState();
    monitor.track("new message", [{ role: "user", content: "ctx" }]);
    const state2 = monitor.getState();
    expect(state1.messageCount).toBe(0);
    expect(state2.messageCount).toBe(1);
  });
});

describe("estimateTokens", () => {
  it("estimates based on character count / 4", () => {
    expect(estimateTokens("hello")).toBe(2);
    expect(estimateTokens("a".repeat(100))).toBe(25);
    expect(estimateTokens("")).toBe(0);
  });

  it("uses a smaller chars/token ratio for Claude models", () => {
    const text = "a".repeat(100);
    const generic = estimateTokens(text);
    const claude = estimateTokens(text, "claude-sonnet-4-6");
    expect(claude).toBeGreaterThan(generic);
  });

  it("falls back to default ratio for unknown models", () => {
    const text = "a".repeat(100);
    expect(estimateTokens(text, "some-unknown-model")).toBe(estimateTokens(text));
  });

  it("SessionMonitor uses configured model for accumulation", () => {
    const monitor = new SessionMonitor({ tokenBudget: 100_000, model: "claude-sonnet" });
    monitor.track("a".repeat(100), [{ role: "user", content: "ctx" }]);
    // 100 chars / 3.5 ≈ 29 tokens, plus the same for `enrichedMessage` (none here, so just 29)
    expect(monitor.getState().estimatedTokens).toBe(29);
  });
});
