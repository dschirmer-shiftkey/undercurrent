import { describe, it, expect } from "vitest";
import { DefaultStrategy } from "./default.js";
import type { Gap, ContextLayer } from "../types.js";

describe("DefaultStrategy", () => {
  const strategy = new DefaultStrategy();

  describe("classifyIntent", () => {
    it("classifies build requests", async () => {
      const intent = await strategy.classifyIntent("build a new dashboard component", []);
      expect(intent.action).toBe("build");
    });

    it("classifies fix requests", async () => {
      const intent = await strategy.classifyIntent("fix the broken authentication flow", []);
      expect(intent.action).toBe("fix");
    });

    it("classifies explore requests", async () => {
      const intent = await strategy.classifyIntent("how does the payment webhook work?", []);
      expect(intent.action).toBe("explore");
    });

    it("classifies design requests", async () => {
      const intent = await strategy.classifyIntent(
        "design the architecture for the new caching layer",
        [],
      );
      expect(intent.action).toBe("design");
    });

    it("classifies vent/frustration", async () => {
      const intent = await strategy.classifyIntent(
        "ugh this is so frustrating and terrible, I hate it",
        [],
      );
      expect(intent.action).toBe("vent");
    });

    it("detects high specificity with file references", async () => {
      const intent = await strategy.classifyIntent(
        "fix the `handleSubmit` function in src/auth/login.ts on line 42 — it crashes on empty input",
        [],
      );
      expect(intent.specificity).toBe("high");
    });

    it("detects low specificity with vague language", async () => {
      const intent = await strategy.classifyIntent("something is off", []);
      expect(intent.specificity).toBe("low");
    });

    it("extracts domain hints from message content", async () => {
      const intent = await strategy.classifyIntent(
        "the stripe webhook endpoint is returning 500 errors when processing subscription events",
        [],
      );
      expect(intent.domainHints).toContain("payment");
      expect(intent.domainHints).toContain("api");
    });

    it("extracts code fragments from backticks", async () => {
      const intent = await strategy.classifyIntent(
        "the `UserService` class is missing a `validate` method",
        [],
      );
      expect(intent.rawFragments).toContain("UserService");
      expect(intent.rawFragments).toContain("validate");
    });

    it("classifies emotional load", async () => {
      const frustrated = await strategy.classifyIntent("ugh this is terrible!!", []);
      expect(frustrated.emotionalLoad).toBe("frustrated");

      const uncertain = await strategy.classifyIntent(
        "maybe we should try a different approach, not sure",
        [],
      );
      expect(uncertain.emotionalLoad).toBe("uncertain");

      const neutral = await strategy.classifyIntent("update the readme with the new api docs", []);
      expect(neutral.emotionalLoad).toBe("neutral");
    });

    it("classifies scope based on content", async () => {
      const atomic = await strategy.classifyIntent("fix config.ts", []);
      expect(atomic.scope).toBe("atomic");

      const product = await strategy.classifyIntent(
        "we need a new tool for managing the application",
        [],
      );
      expect(product.scope).toBe("product");
    });

    it("extracts temporal references as raw fragments", async () => {
      const intent = await strategy.classifyIntent(
        "use the same approach as last time to fix the auth",
        [],
      );
      expect(intent.rawFragments).toEqual(
        expect.arrayContaining(["same approach", "last time"]),
      );
    });

    it("adds memory domain hint for temporal references", async () => {
      const intent = await strategy.classifyIntent(
        "do it like before, same way as we discussed",
        [],
      );
      expect(intent.domainHints).toContain("memory");
    });

    it("does not add memory domain hint when no temporal references", async () => {
      const intent = await strategy.classifyIntent("build a new api endpoint for users", []);
      expect(intent.domainHints).not.toContain("memory");
    });
  });

  describe("analyzeGaps", () => {
    it("flags missing file reference for fix requests", async () => {
      const intent = await strategy.classifyIntent("fix the broken login", []);
      const gaps = await strategy.analyzeGaps(intent, [], "fix the broken login");

      const fileGap = gaps.find((g) => g.description.includes("file"));
      expect(fileGap).toBeDefined();
      expect(fileGap!.critical).toBe(true);
    });

    it("flags scope ambiguity for cross-system requests", async () => {
      const intent = await strategy.classifyIntent(
        "refactor the entire system architecture and infrastructure",
        [],
      );
      const gaps = await strategy.analyzeGaps(
        intent,
        [],
        "refactor the entire system architecture and infrastructure",
      );

      const scopeGap = gaps.find((g) => g.description.includes("Scope"));
      expect(scopeGap).toBeDefined();
    });

    it("flags missing options for decision requests", async () => {
      const intent = {
        action: "decide" as const,
        specificity: "medium" as const,
        scope: "local" as const,
        emotionalLoad: "neutral" as const,
        confidence: 0.6,
        rawFragments: [],
        domainHints: [],
      };

      const gaps = await strategy.analyzeGaps(
        intent,
        [],
        "I need to decide on the caching approach",
      );
      const decisionGap = gaps.find((g) => g.description.includes("options"));
      expect(decisionGap).toBeDefined();
      expect(decisionGap!.critical).toBe(true);
    });

    it("returns no gaps for high-specificity requests", async () => {
      const intent = await strategy.classifyIntent(
        "fix the `handleAuth` function in auth.ts on line 12 — it throws TypeError",
        [],
      );
      const gaps = await strategy.analyzeGaps(
        intent,
        [],
        "fix the `handleAuth` function in auth.ts on line 12 — it throws TypeError",
      );

      expect(gaps).toHaveLength(0);
    });

    it("flags temporal references when no memory context is available", async () => {
      const intent = await strategy.classifyIntent(
        "use the same approach as last time",
        [],
      );
      const gaps = await strategy.analyzeGaps(
        intent,
        [],
        "use the same approach as last time",
      );

      const temporal = gaps.find((g) => g.description.includes("Temporal reference"));
      expect(temporal).toBeDefined();
      expect(temporal!.critical).toBe(true);
    });

    it("does not flag temporal reference when memory context exists", async () => {
      const memoryLayer: ContextLayer = {
        source: "komatik-memory",
        priority: 0,
        timestamp: Date.now(),
        data: {},
        summary: "Active work: refactoring auth module",
      };
      const intent = await strategy.classifyIntent(
        "use the same approach as last time",
        [],
      );
      const gaps = await strategy.analyzeGaps(
        intent,
        [memoryLayer],
        "use the same approach as last time",
      );

      const temporal = gaps.find((g) => g.description.includes("Temporal reference"));
      expect(temporal).toBeUndefined();
    });

    it("flags vague references with single occurrence when no context", async () => {
      const intent = await strategy.classifyIntent("fix it", []);
      const gaps = await strategy.analyzeGaps(intent, [], "fix it");

      const vagueGap = gaps.find((g) =>
        g.description.includes("Ambiguous reference"),
      );
      expect(vagueGap).toBeDefined();
    });

    it("flags expanded vague terms like 'the stuff' and 'the other'", async () => {
      const intent = await strategy.classifyIntent(
        "make the stuff do the other",
        [],
      );
      const gaps = await strategy.analyzeGaps(
        intent,
        [],
        "make the stuff do the other",
      );

      const vagueGap = gaps.find((g) =>
        g.description.includes("ambiguous") || g.description.includes("Ambiguous"),
      );
      expect(vagueGap).toBeDefined();
    });

    it("flags ultra-terse messages as underspecified", async () => {
      const intent = await strategy.classifyIntent("add styles", []);
      const gaps = await strategy.analyzeGaps(intent, [], "add styles");

      const terseGap = gaps.find((g) =>
        g.description.includes("extremely terse"),
      );
      expect(terseGap).toBeDefined();
      expect(terseGap!.critical).toBe(false);
    });

    it("does not flag terse gap for messages >= 5 words", async () => {
      const msg = "add styles to the login page";
      const intent = await strategy.classifyIntent(msg, []);
      const gaps = await strategy.analyzeGaps(intent, [], msg);

      const terseGap = gaps.find((g) =>
        g.description.includes("extremely terse"),
      );
      expect(terseGap).toBeUndefined();
    });

    it("flags missing file reference for unknown action", async () => {
      const intent = {
        action: "unknown" as const,
        specificity: "low" as const,
        scope: "local" as const,
        emotionalLoad: "neutral" as const,
        confidence: 0.5,
        rawFragments: [],
        domainHints: [],
      };

      const gaps = await strategy.analyzeGaps(
        intent,
        [],
        "do the thing with the stuff",
      );

      const fileGap = gaps.find((g) => g.description.includes("file"));
      expect(fileGap).toBeDefined();
    });
  });

  describe("resolveGap", () => {
    const makeGap = (desc: string, critical = true): Gap => ({
      id: "test-gap",
      description: desc,
      critical,
      resolution: null,
    });

    it("fills gaps from matching context", async () => {
      const gap = makeGap("No specific file or location referenced");
      const context: ContextLayer[] = [
        {
          source: "git",
          priority: 1,
          timestamp: Date.now(),
          data: {},
          summary: "Recent changes in src/auth/login.ts — file modified with location markers",
        },
      ];

      const resolution = await strategy.resolveGap(gap, context, 0.6);
      expect(resolution.type).toBe("filled");
    });

    it("creates assumptions for non-critical gaps without context", async () => {
      const gap = makeGap("Multiple ambiguous references", false);
      const resolution = await strategy.resolveGap(gap, [], 0.6);

      expect(resolution.type).toBe("assumed");
      if (resolution.type === "assumed") {
        expect(resolution.assumption.correctable).toBe(true);
        expect(resolution.assumption.source).toBe("default-strategy");
      }
    });

    it("asks for clarification on critical gaps without context", async () => {
      const gap = makeGap("Scope boundaries unclear — which systems are in play", true);
      const resolution = await strategy.resolveGap(gap, [], 0.6);

      expect(resolution.type).toBe("needs-clarification");
      if (resolution.type === "needs-clarification") {
        expect(resolution.clarification.options.length).toBeGreaterThanOrEqual(2);
        expect(resolution.clarification.defaultOptionId).toBeTruthy();
      }
    });
  });

  describe("compose", () => {
    it("produces structured enriched output", async () => {
      const intent = await strategy.classifyIntent("build a new api endpoint for users", []);
      const result = await strategy.compose(
        "build a new api endpoint for users",
        intent,
        [],
        [],
        [],
      );

      expect(result).toContain("[Original]:");
      expect(result).toContain("[Intent]:");
      expect(result).toContain("build");
    });

    it("includes context summaries when available", async () => {
      const intent = await strategy.classifyIntent("check the deploy pipeline", []);
      const context: ContextLayer[] = [
        {
          source: "git",
          priority: 1,
          timestamp: Date.now(),
          data: {},
          summary: "On branch feature/deploy-fix with 2 pending commits",
        },
      ];

      const result = await strategy.compose("check the deploy pipeline", intent, context, [], []);
      expect(result).toContain("[Context]:");
      expect(result).toContain("feature/deploy-fix");
    });

    it("includes assumptions in output", async () => {
      const intent = await strategy.classifyIntent("fix it", []);
      const assumptions = [
        {
          id: "a-1",
          claim: "Referring to the most recently edited file",
          basis: "No file specified, defaulting to recent context",
          confidence: 0.65,
          source: "default-strategy",
          correctable: true,
        },
      ];

      const result = await strategy.compose("fix it", intent, [], assumptions, []);
      expect(result).toContain("[Assumptions]:");
      expect(result).toContain("most recently edited file");
    });
  });
});
