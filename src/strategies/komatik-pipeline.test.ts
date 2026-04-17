import { describe, it, expect, vi } from "vitest";
import { KomatikPipelineStrategy } from "./komatik-pipeline.js";
import type { ContextLayer, Gap, IntentSignal } from "../types.js";

function makeGap(description: string, critical = false): Gap {
  return { id: "test-gap", description, critical, resolution: null };
}

function makeContextLayer(
  source: string,
  data: Record<string, unknown> = {},
  summary = "test context",
): ContextLayer {
  return { source, priority: 1, timestamp: Date.now(), data, summary };
}

describe("KomatikPipelineStrategy", () => {
  it("has correct name", () => {
    const strategy = new KomatikPipelineStrategy();
    expect(strategy.name).toBe("komatik-pipeline");
  });

  describe("classifyIntent — domain detection", () => {
    it("detects ecommerce domain", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent(
        "Build an online store with a shopping cart and checkout",
        [],
      );
      expect(intent.domainHints).toContain("ecommerce");
      expect(intent.confidence).toBeGreaterThan(0.3);
    });

    it("detects saas domain", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent(
        "Create a multi-tenant SaaS dashboard with subscription billing",
        [],
      );
      expect(intent.domainHints).toContain("saas");
    });

    it("detects education domain", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent(
        "Build a learning tool with courses for students and classroom quizzes",
        [],
      );
      expect(intent.domainHints).toContain("education");
    });

    it("detects game domain", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent(
        "Create a multiplayer game with player scores and character levels",
        [],
      );
      expect(intent.domainHints).toContain("game");
    });

    it("detects mobile domain", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent(
        "Build a React Native mobile app for iOS and Android",
        [],
      );
      expect(intent.domainHints).toContain("mobile");
    });

    it("detects AI/ML domain", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent(
        "Build an AI-powered tool using LLM embeddings and vector search",
        [],
      );
      expect(intent.domainHints).toContain("ai_ml");
    });

    it("detects CLI domain", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent(
        "Build a command-line tool for automation scripts",
        [],
      );
      expect(intent.domainHints).toContain("cli");
    });

    it("detects climate domain", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent(
        "Build a carbon emissions tracker for sustainability reporting",
        [],
      );
      expect(intent.domainHints).toContain("climate");
    });

    it("falls back to unknown for unrecognized domains", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent("do something", []);
      expect(intent.domainHints).toContain("unknown");
    });
  });

  describe("classifyIntent — action detection", () => {
    it("detects build action", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent("Build a new landing page for the product", []);
      expect(intent.action).toBe("build");
    });

    it("detects fix action", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent(
        "Fix the broken login error on the dashboard",
        [],
      );
      expect(intent.action).toBe("fix");
    });

    it("detects explore action", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent(
        "I have an idea for a new feature, what if we add notifications",
        [],
      );
      expect(intent.action).toBe("explore");
    });

    it("detects design action", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent(
        "Design the architecture for the new microservice",
        [],
      );
      expect(intent.action).toBe("design");
    });
  });

  describe("classifyIntent — emotion detection", () => {
    it("detects frustrated emotion", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent("This is so frustrating!! Nothing works", []);
      expect(intent.emotionalLoad).toBe("frustrated");
    });

    it("detects excited emotion", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent("This is awesome, I love the new feature", []);
      expect(intent.emotionalLoad).toBe("excited");
    });

    it("detects uncertain emotion", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent(
        "Maybe we should try a different approach, I'm not sure",
        [],
      );
      expect(intent.emotionalLoad).toBe("uncertain");
    });

    it("defaults to neutral", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent("Add user authentication to the API", []);
      expect(intent.emotionalLoad).toBe("neutral");
    });
  });

  describe("classifyIntent — specificity and scope", () => {
    it("rates higher specificity for detailed messages with features and domain confidence", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intentVague = await strategy.classifyIntent("make an app", []);
      const intentDetailed = await strategy.classifyIntent(
        "Build an ecommerce store with authentication, payments, search, file uploads, and a dashboard. Must have role-based access and real-time notifications. Specifically needs Stripe checkout integration.",
        [],
      );
      expect(intentVague.specificity).toBe("low");
      expect(["medium", "high"]).toContain(intentDetailed.specificity);
    });

    it("rates low specificity for short vague messages", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent("make an app", []);
      expect(intent.specificity).toBe("low");
    });

    it("maps many features to cross-system scope", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent(
        "Build a platform with auth, payments, chat, search, dashboard, file uploads, scheduling, and email notifications",
        [],
      );
      expect(intent.scope).toBe("cross-system");
    });
  });

  describe("classifyIntent — conversation context", () => {
    it("incorporates conversation history into domain detection", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent("continue with that", [
        { role: "user", content: "I want to build an online store" },
        { role: "assistant", content: "I'll set up the ecommerce store" },
      ]);
      expect(intent.domainHints).toContain("ecommerce");
    });
  });

  describe("analyzeGaps", () => {
    it("flags missing project type for unknown domain", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent: IntentSignal = {
        action: "build",
        specificity: "low",
        scope: "local",
        emotionalLoad: "neutral",
        confidence: 0.3,
        rawFragments: [],
        domainHints: ["unknown"],
      };
      const gaps = await strategy.analyzeGaps(intent, [], "do something");
      const projectTypeGap = gaps.find((g) => g.description.includes("project type"));
      expect(projectTypeGap).toBeDefined();
      expect(projectTypeGap!.critical).toBe(true);
    });

    it("flags missing features for low-specificity messages", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent: IntentSignal = {
        action: "build",
        specificity: "low",
        scope: "local",
        emotionalLoad: "neutral",
        confidence: 0.5,
        rawFragments: [],
        domainHints: ["unknown"],
      };
      const gaps = await strategy.analyzeGaps(intent, [], "make a thing");
      const featureGap = gaps.find((g) => g.description.includes("features"));
      expect(featureGap).toBeDefined();
    });

    it("flags missing audience", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent: IntentSignal = {
        action: "build",
        specificity: "low",
        scope: "local",
        emotionalLoad: "neutral",
        confidence: 0.5,
        rawFragments: [],
        domainHints: ["saas"],
      };
      const gaps = await strategy.analyzeGaps(intent, [], "build a saas dashboard");
      const audienceGap = gaps.find((g) => g.description.includes("audience"));
      expect(audienceGap).toBeDefined();
      expect(audienceGap!.critical).toBe(false);
    });

    it("flags missing mission statement in Yggdrasil mode", async () => {
      const strategy = new KomatikPipelineStrategy({ yggdrasil: true });
      const intent: IntentSignal = {
        action: "build",
        specificity: "low",
        scope: "local",
        emotionalLoad: "neutral",
        confidence: 0.5,
        rawFragments: [],
        domainHints: ["climate"],
      };
      const gaps = await strategy.analyzeGaps(intent, [], "climate app");
      const missionGap = gaps.find((g) => g.description.includes("mission statement"));
      expect(missionGap).toBeDefined();
    });
  });

  describe("resolveGap", () => {
    it("fills project type from komatik-knowledge context", async () => {
      const strategy = new KomatikPipelineStrategy();
      const gap = makeGap("Missing project type — what kind of thing is this?", true);
      const context = [
        makeContextLayer("komatik-knowledge", {
          domainDefaults: { projectType: "Web App" },
        }),
      ];

      const resolution = await strategy.resolveGap(gap, context, 0.5);
      expect(resolution.type).toBe("filled");
      if (resolution.type === "filled") {
        expect(resolution.value).toBe("Web App");
      }
    });

    it("assumes non-critical gaps", async () => {
      const strategy = new KomatikPipelineStrategy();
      const gap = makeGap("Target platform not specified", false);
      const resolution = await strategy.resolveGap(gap, [], 0.5);
      expect(resolution.type).toBe("assumed");
      if (resolution.type === "assumed") {
        expect(resolution.assumption.correctable).toBe(true);
      }
    });

    it("requests clarification for critical gaps with low confidence", async () => {
      const strategy = new KomatikPipelineStrategy();
      const gap = makeGap("No specific features mentioned — what should it DO?", true);
      const resolution = await strategy.resolveGap(gap, [], 0.8);
      expect(resolution.type).toBe("needs-clarification");
      if (resolution.type === "needs-clarification") {
        expect(resolution.clarification.options.length).toBeGreaterThanOrEqual(2);
      }
    });

    it("provides appropriate options for project type clarification", async () => {
      const strategy = new KomatikPipelineStrategy();
      const gap = makeGap("Missing project type — what kind of thing is this?", true);
      const resolution = await strategy.resolveGap(gap, [], 0.9);
      if (resolution.type === "needs-clarification") {
        const labels = resolution.clarification.options.map((o) => o.label);
        expect(labels).toContain("Web App");
        expect(labels).toContain("Mobile App");
      }
    });
  });

  describe("compose — heuristic mode", () => {
    it("produces structured output with all sections", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent: IntentSignal = {
        action: "build",
        specificity: "medium",
        scope: "product",
        emotionalLoad: "neutral",
        confidence: 0.7,
        rawFragments: [],
        domainHints: ["ecommerce"],
      };
      const context = [makeContextLayer("test", {}, "Test context data")];
      const assumptions = [
        {
          id: "a1",
          claim: "Assuming web platform",
          basis: "Default",
          confidence: 0.7,
          source: "komatik-pipeline",
          correctable: true,
        },
      ];

      const output = await strategy.compose(
        "Build an online store with cart and checkout",
        intent,
        context,
        assumptions,
        [],
      );

      expect(output).toContain("[Original]:");
      expect(output).toContain("[Project]:");
      expect(output).toContain("[Domain]: ecommerce");
      expect(output).toContain("[Tech Stack]:");
      expect(output).toContain("[Detected Features]:");
      expect(output).toContain("[Context]:");
      expect(output).toContain("[Assumptions]:");
      expect(output).toContain("[Readiness]:");
    });

    it("includes Yggdrasil label in Yggdrasil mode", async () => {
      const strategy = new KomatikPipelineStrategy({ yggdrasil: true });
      const intent: IntentSignal = {
        action: "build",
        specificity: "medium",
        scope: "local",
        emotionalLoad: "neutral",
        confidence: 0.5,
        rawFragments: [],
        domainHints: ["climate"],
      };
      const output = await strategy.compose(
        "Build a carbon tracker to help reduce emissions",
        intent,
        [],
        [],
        [],
      );
      expect(output).toContain("[Yggdrasil]:");
      expect(output).toContain("Seedling");
    });

    it("infers tech stack from domain", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent: IntentSignal = {
        action: "build",
        specificity: "medium",
        scope: "local",
        emotionalLoad: "neutral",
        confidence: 0.7,
        rawFragments: [],
        domainHints: ["ecommerce"],
      };
      const output = await strategy.compose(
        "Build an ecommerce store with checkout and cart",
        intent,
        [],
        [],
        [],
      );
      expect(output).toContain("Next.js");
      expect(output).toContain("Supabase");
      expect(output).toContain("Stripe");
    });

    it("extracts project name from quoted text", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent: IntentSignal = {
        action: "build",
        specificity: "medium",
        scope: "local",
        emotionalLoad: "neutral",
        confidence: 0.5,
        rawFragments: [],
        domainHints: [],
      };
      const output = await strategy.compose(
        'Build "ShopFlow" — a modern ecommerce platform',
        intent,
        [],
        [],
        [],
      );
      expect(output).toContain("ShopFlow");
    });
  });

  describe("compose — LLM mode", () => {
    it("calls llmCall with prompt and system prompt", async () => {
      const llmCall = vi.fn().mockResolvedValue("LLM-generated output");
      const strategy = new KomatikPipelineStrategy({ llmCall });
      const intent: IntentSignal = {
        action: "build",
        specificity: "medium",
        scope: "local",
        emotionalLoad: "neutral",
        confidence: 0.5,
        rawFragments: [],
        domainHints: [],
      };
      const output = await strategy.compose("Build an online store", intent, [], [], []);

      expect(llmCall).toHaveBeenCalledOnce();
      expect(output).toBe("LLM-generated output");

      const [prompt, systemPrompt] = llmCall.mock.calls[0] as [string, string];
      expect(prompt).toContain("Build an online store");
      expect(systemPrompt).toContain("Undercurrent");
    });

    it("includes Yggdrasil context in LLM system prompt", async () => {
      const llmCall = vi.fn().mockResolvedValue("LLM output");
      const strategy = new KomatikPipelineStrategy({
        llmCall,
        yggdrasil: true,
      });
      const intent: IntentSignal = {
        action: "build",
        specificity: "medium",
        scope: "local",
        emotionalLoad: "neutral",
        confidence: 0.5,
        rawFragments: [],
        domainHints: [],
      };
      await strategy.compose("Build a climate tool", intent, [], [], []);

      const systemPrompt = llmCall.mock.calls[0]![1] as string;
      expect(systemPrompt).toContain("Yggdrasil");
    });
  });

  describe("external domain configs", () => {
    it("uses external domain configs for classification", async () => {
      const strategy = new KomatikPipelineStrategy({
        domainConfigs: [
          {
            domainId: "fintech",
            displayName: "Fintech",
            keywords: ["fintech", "banking", "trading"],
            defaultStack: ["Next.js", "Plaid"],
            confidenceKeywords: { fintech: 0.9 },
          },
        ],
      });
      const intent = await strategy.classifyIntent("Build a fintech banking trading platform", []);
      expect(intent.domainHints).toContain("fintech");
    });
  });

  describe("external feature catalog", () => {
    it("detects external catalog features", async () => {
      const strategy = new KomatikPipelineStrategy({
        featureCatalog: [
          {
            id: "biometric",
            name: "Biometric Auth",
            description: "Fingerprint and face ID authentication",
            baseHours: 20,
            keywords: ["biometric", "fingerprint", "face id"],
            category: "Security",
          },
        ],
      });
      const intent = await strategy.classifyIntent(
        "Build an app with biometric fingerprint login",
        [],
      );
      expect(intent.domainHints).toContain("biometric auth");
    });
  });

  describe("feature detection", () => {
    it("detects authentication feature", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent(
        "Build an app with user login and registration",
        [],
      );
      expect(intent.domainHints.some((h) => h === "authentication")).toBe(true);
    });

    it("detects payments feature", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent(
        "Build a store with Stripe checkout and billing",
        [],
      );
      expect(intent.domainHints.some((h) => h === "payments")).toBe(true);
    });

    it("detects dashboard feature", async () => {
      const strategy = new KomatikPipelineStrategy();
      const intent = await strategy.classifyIntent(
        "Build an analytics dashboard with charts and metrics",
        [],
      );
      expect(intent.domainHints.some((h) => h === "dashboard & analytics")).toBe(true);
    });
  });
});
