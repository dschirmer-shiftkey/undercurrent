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

    describe("classifies acknowledgments (real transcript samples)", () => {
      const ackCases = [
        "thanks",
        "thank you",
        "thanks!",
        "looks great thank you!",
        "please",
        "ok",
        "okay",
        "perfect",
        "nice",
        "awesome",
        "cool",
        "got it",
        "makes sense",
        "sounds good",
        "looks good",
      ];
      for (const msg of ackCases) {
        it(`treats "${msg}" as acknowledge`, async () => {
          const intent = await strategy.classifyIntent(msg, []);
          expect(intent.action).toBe("acknowledge");
        });
      }
    });

    describe("classifies status pastes as 'report'", () => {
      it("treats a real CI status paste as report (from Komatik transcript #29)", async () => {
        const msg = `All green.

Build & Type-Check Platform: pass (4m18s)
CI Gate: pass
Every other check: pass or skipped (as expected for path-scoped jobs)
PR #864 is now CI-clean. That means:

Our fix works — the SDK loads gracefully at runtime and the type annotations compile clean.
Once #864 merges to dev, PR #863 (and any other PRs touching platform/web/**) will also pass CI.`;
        const intent = await strategy.classifyIntent(msg, []);
        expect(intent.action).toBe("report");
      });

      it("treats a stack-trace paste as report", async () => {
        const msg = `TypeError: Cannot read property 'id' of undefined
    at handleSubmit (src/auth/login.ts:42:15)
    at processRequest (src/api/middleware.ts:88:9)
    at async run (src/server.ts:120:5)`;
        const intent = await strategy.classifyIntent(msg, []);
        expect(intent.action).toBe("report");
      });

      it("treats a test-run summary as report", async () => {
        const msg = `Test Files  29 passed (29)
Tests      346 passed (346)
Duration   1.05s

All green. Ready to merge #847.`;
        const intent = await strategy.classifyIntent(msg, []);
        expect(intent.action).toBe("report");
      });
    });

    describe("does NOT classify status-shaped input as report when a question is present", () => {
      it("paste + trailing question is NOT a report", async () => {
        const msg = `TypeError: Cannot read property 'id' of undefined
    at handleSubmit (src/auth/login.ts:42:15)
    at processRequest (src/api/middleware.ts:88:9)

How do I fix this?`;
        const intent = await strategy.classifyIntent(msg, []);
        expect(intent.action).not.toBe("report");
      });

      it("paste + 'can you help' is NOT a report", async () => {
        const msg = `Build failed
Step 3: pass
Step 4: fail (timeout after 5m0s)

Can you look at why step 4 is timing out?`;
        const intent = await strategy.classifyIntent(msg, []);
        expect(intent.action).not.toBe("report");
      });

      it("single-line 'All green' is NOT a report (too short)", async () => {
        const intent = await strategy.classifyIntent("All green", []);
        expect(intent.action).not.toBe("report");
      });
    });

    describe("typo-tolerant action classification", () => {
      const typoCases: Array<{ msg: string; expected: Action }> = [
        { msg: "udpate the login form", expected: "build" },
        { msg: "imlement a new button", expected: "build" },
        { msg: "refactr the auth module", expected: "build" },
        { msg: "confgure the deploy step", expected: "build" },
        { msg: "migreate the users table", expected: "build" },
        { msg: "the header is destoryed", expected: "fix" },
        { msg: "explian how the pipeline works", expected: "explore" },
        { msg: "describ the flow for me", expected: "explore" },
        { msg: "we need to chose between two paths", expected: "decide" },
      ];
      for (const { msg, expected } of typoCases) {
        it(`classifies "${msg}" as ${expected}`, async () => {
          const intent = await strategy.classifyIntent(msg, []);
          expect(intent.action).toBe(expected);
        });
      }
    });

    describe("fuzzy matcher does NOT overreach", () => {
      it("does not falsely match short English words to action verbs", async () => {
        const intent = await strategy.classifyIntent("this is the thing", []);
        expect(intent.action).not.toBe("build");
        expect(intent.action).not.toBe("fix");
      });

      it("exact action match still routes via pattern, not fuzzy", async () => {
        const intent = await strategy.classifyIntent("update the config", []);
        expect(intent.action).toBe("build");
      });
    });

    describe("does NOT classify as acknowledge when real intent is present", () => {
      const nonAckCases: Array<[string, string]> = [
        ["please fix the login bug", "fix"],
        ["thanks, now build the dashboard", "build"],
        ["ok can you look at the router?", "explore"],
        ["nice, now refactor the auth middleware", "build"],
        ["perfect — now can we merge the PR?", "build"],
      ];
      for (const [msg, expected] of nonAckCases) {
        it(`treats "${msg}" as ${expected}, not acknowledge`, async () => {
          const intent = await strategy.classifyIntent(msg, []);
          expect(intent.action).toBe(expected);
        });
      }
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

    it("classifies refactor/update/optimize/remove as build action", async () => {
      const cases = [
        { msg: "refactor the auth module to use JWT tokens", expected: "build" },
        { msg: "update the styles to use the new design system", expected: "build" },
        { msg: "optimize the database query in the user service", expected: "build" },
        { msg: "remove the old authentication middleware", expected: "build" },
        { msg: "deploy the staging branch to production", expected: "build" },
        { msg: "migrate the users table to the new schema", expected: "build" },
        { msg: "rename the component from UserCard to ProfileCard", expected: "build" },
      ];
      for (const { msg, expected } of cases) {
        const intent = await strategy.classifyIntent(msg, []);
        expect(intent.action, `"${msg}" should classify as ${expected}`).toBe(expected);
      }
    });

    it("boosts specificity for named architectural components", async () => {
      const intent = await strategy.classifyIntent(
        "refactor the auth module to use JWT tokens instead of sessions",
        [],
      );
      expect(["medium", "high"]).toContain(intent.specificity);
    });

    it("boosts specificity for feature enumerations", async () => {
      const intent = await strategy.classifyIntent(
        "Build a user registration form with email verification, password strength meter, and social login",
        [],
      );
      expect(["medium", "high"]).toContain(intent.specificity);
    });

    it("detects 'what we discussed' as temporal reference", async () => {
      const intent = await strategy.classifyIntent(
        "Can you update the styles to match what we discussed?",
        [],
      );
      expect(intent.rawFragments).toEqual(expect.arrayContaining(["what we discussed"]));
      expect(intent.domainHints).toContain("memory");
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

    it("flags 'what we discussed' as temporal reference", async () => {
      const intent = await strategy.classifyIntent(
        "Can you update the styles to match what we discussed?",
        [],
      );
      const gaps = await strategy.analyzeGaps(
        intent,
        [],
        "Can you update the styles to match what we discussed?",
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

    describe("selection-reference detection", () => {
      const selectionCases = [
        "option a please",
        "A+B",
        "bundle A+B in one migration",
        "all of the above",
        "both",
        "items 1-5",
        "okay option b, let's proceed",
        "let's go with option 2",
        "the first one",
      ];
      for (const msg of selectionCases) {
        it(`fires selection gap when no memory context: "${msg}"`, async () => {
          const intent = await strategy.classifyIntent(msg, []);
          const gaps = await strategy.analyzeGaps(intent, [], msg);
          const selectionGap = gaps.find((g) => g.description.includes("Selection references"));
          expect(selectionGap).toBeDefined();
          expect(selectionGap!.critical).toBe(true);
        });
      }

      it("suppresses selection gap when memory context is present", async () => {
        const memoryLayer: ContextLayer = {
          source: "komatik-memory",
          priority: 0,
          timestamp: Date.now(),
          data: {},
          summary: "Prior turn offered options A, B, C for migration strategy",
        };
        const intent = await strategy.classifyIntent("A+B", []);
        const gaps = await strategy.analyzeGaps(intent, [memoryLayer], "A+B");
        const selectionGap = gaps.find((g) => g.description.includes("Selection references"));
        expect(selectionGap).toBeUndefined();
      });

      it("suppresses file and scope gaps when selection is detected", async () => {
        const intent = await strategy.classifyIntent("option a please", []);
        const gaps = await strategy.analyzeGaps(intent, [], "option a please");
        const fileGap = gaps.find((g) => g.description.includes("file"));
        const scopeGap = gaps.find((g) => g.description.includes("Scope"));
        expect(fileGap).toBeUndefined();
        expect(scopeGap).toBeUndefined();
      });

      it("does NOT treat mid-message 'first' or 'both' as selection", async () => {
        const intent = await strategy.classifyIntent(
          "this is the first time we try both sides together",
          [],
        );
        const gaps = await strategy.analyzeGaps(
          intent,
          [],
          "this is the first time we try both sides together",
        );
        const selectionGap = gaps.find((g) => g.description.includes("Selection references"));
        expect(selectionGap).toBeUndefined();
      });

      it("captures selection tokens in rawFragments", async () => {
        const intent = await strategy.classifyIntent("bundle A+B in one migration", []);
        expect(intent.rawFragments.some((f) => f.includes("a+b"))).toBe(true);
      });
    });

    describe("context-aware gap suppression", () => {
      it("suppresses file gap when conversation layer names files", async () => {
        const conversationLayer: ContextLayer = {
          source: "conversation",
          priority: 0,
          timestamp: Date.now(),
          data: {
            terminology: { "src/auth/middleware.ts": 3 },
          },
          summary: "Recent discussion touched src/auth/middleware.ts",
        };
        const intent = await strategy.classifyIntent("fix the broken login", []);
        const gaps = await strategy.analyzeGaps(
          intent,
          [conversationLayer],
          "fix the broken login",
        );
        const fileGap = gaps.find((g) => g.description.includes("file"));
        expect(fileGap).toBeUndefined();
      });

      it("suppresses scope gap for unknown scope when conversation has decisions", async () => {
        const conversationLayer: ContextLayer = {
          source: "conversation",
          priority: 0,
          timestamp: Date.now(),
          data: {
            decisions: ["let's go with JWT for auth"],
          },
          summary: "Active decisions recorded",
        };
        const intent = {
          action: "build" as const,
          specificity: "low" as const,
          scope: "unknown" as const,
          emotionalLoad: "neutral" as const,
          confidence: 0.5,
          rawFragments: [],
          domainHints: [],
        };
        const gaps = await strategy.analyzeGaps(
          intent,
          [conversationLayer],
          "build the next part",
        );
        const scopeGap = gaps.find((g) => g.description.includes("Scope"));
        expect(scopeGap).toBeUndefined();
      });

      it("still fires scope gap for cross-system even with conversation context", async () => {
        const conversationLayer: ContextLayer = {
          source: "conversation",
          priority: 0,
          timestamp: Date.now(),
          data: {
            topics: "Topic trajectory: auth → database",
          },
          summary: "Discussion progressed",
        };
        const intent = {
          action: "build" as const,
          specificity: "low" as const,
          scope: "cross-system" as const,
          emotionalLoad: "neutral" as const,
          confidence: 0.5,
          rawFragments: [],
          domainHints: [],
        };
        const gaps = await strategy.analyzeGaps(
          intent,
          [conversationLayer],
          "refactor the entire system",
        );
        const scopeGap = gaps.find((g) => g.description.includes("Scope"));
        expect(scopeGap).toBeDefined();
      });

      it("raises vague-reference threshold when conversation context exists", async () => {
        const conversationLayer: ContextLayer = {
          source: "conversation",
          priority: 0,
          timestamp: Date.now(),
          data: {
            topics: "Topic trajectory: testing",
          },
          summary: "Prior discussion about tests",
        };
        const intent = await strategy.classifyIntent("update it to match that", []);
        const gaps = await strategy.analyzeGaps(
          intent,
          [conversationLayer],
          "update it to match that",
        );
        const vagueGap = gaps.find((g) => g.description.toLowerCase().includes("ambiguous"));
        expect(vagueGap).toBeUndefined();
      });
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
