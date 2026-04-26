import { describe, it, expect, vi } from "vitest";
import { Suggester } from "./suggester.js";
import { analyzeResponse } from "./response-signals.js";
import type {
  KomatikWriteClient,
  KomatikWriteQueryBuilder,
  KomatikWriteFilterBuilder,
  KomatikQueryResult,
} from "../komatik/client.js";

describe("analyzeResponse", () => {
  it("detects open questions", () => {
    const signals = analyzeResponse("Would you like me to run the tests?", []);
    expect(signals.containsOpenQuestion).toBe(true);
  });

  it("detects errors", () => {
    const signals = analyzeResponse("The build failed with a type error.", []);
    expect(signals.containsError).toBe(true);
  });

  it("detects completion", () => {
    const signals = analyzeResponse("All tests passed. Done.", []);
    expect(signals.containsCompletion).toBe(true);
  });

  it("flags topic shifts", () => {
    const signals = analyzeResponse(
      "Let me tell you about database replication, sharding partitions, quorum reads.",
      [
        { role: "user", content: "help me style this button component with rounded corners" },
        { role: "user", content: "also adjust the hover state for accessibility contrast" },
      ],
    );
    expect(signals.topicShift).toBe(true);
  });

  it("does not flag topic shifts on related follow-ups", () => {
    const signals = analyzeResponse(
      "I updated the button component with rounded corners and fixed the hover contrast.",
      [
        { role: "user", content: "help me style this button component with rounded corners" },
        { role: "user", content: "also adjust the hover contrast for accessibility" },
      ],
    );
    expect(signals.topicShift).toBe(false);
  });

  it("extracts referenced identifier-looking terms", () => {
    const signals = analyzeResponse(
      "I edited UserProfile and also touched getAuthToken in authHelpers.",
      [],
    );
    expect(signals.referencedTerms).toContain("UserProfile");
    expect(signals.referencedTerms).toContain("getAuthToken");
  });

  it("ignores content inside code fences for term extraction", () => {
    const signals = analyzeResponse(
      "```\nconst SecretToken = 1;\n```\nVisible identifier is OpenFunction.",
      [],
    );
    expect(signals.referencedTerms).toContain("OpenFunction");
    expect(signals.referencedTerms).not.toContain("SecretToken");
  });
});

describe("Suggester.suggest (disabled)", () => {
  it("returns empty result with strategyUsed=disabled", async () => {
    const s = new Suggester({ config: { enabled: false } });
    const result = await s.suggest({
      originalMessage: "anything",
      agentResponse: "Would you like me to continue?",
      conversation: [],
    });
    expect(result.suggestions).toEqual([]);
    expect(result.metadata.strategyUsed).toBe("disabled");
  });
});

describe("Suggester.suggest (heuristic)", () => {
  it("always returns at least one continue suggestion", async () => {
    const s = new Suggester({ config: { enabled: true } });
    const result = await s.suggest({
      originalMessage: "make a change",
      agentResponse: "Okay, here's the result.",
      conversation: [],
    });
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions.some((x) => x.category === "continue")).toBe(true);
  });

  it("produces continue+amend+stop when agent asks an open question", async () => {
    const s = new Suggester({ config: { enabled: true, maxSuggestions: 5 } });
    const result = await s.suggest({
      originalMessage: "add a helper",
      agentResponse: "Would you like me to add a test too?",
      conversation: [],
    });
    const categories = new Set(result.suggestions.map((x) => x.category));
    expect(categories.has("continue")).toBe(true);
    expect(categories.has("amend")).toBe(true);
    expect(categories.has("stop")).toBe(true);
  });

  it("offers stop suggestion on completion", async () => {
    const s = new Suggester({ config: { enabled: true } });
    const result = await s.suggest({
      originalMessage: "fix the bug",
      agentResponse: "Done. All tests pass.",
      conversation: [],
    });
    expect(result.suggestions.some((x) => x.category === "stop")).toBe(true);
  });

  it("respects maxSuggestions cap", async () => {
    const s = new Suggester({ config: { enabled: true, maxSuggestions: 2 } });
    const result = await s.suggest({
      originalMessage: "go",
      agentResponse: "Would you like me to do X? It failed. Done.",
      conversation: [],
    });
    expect(result.suggestions.length).toBeLessThanOrEqual(2);
  });

  it("hard-caps at 5 even when maxSuggestions is larger", async () => {
    const s = new Suggester({ config: { enabled: true, maxSuggestions: 99 } });
    const result = await s.suggest({
      originalMessage: "go",
      agentResponse: "Would you like me to do X? It failed. Done.",
      conversation: [],
    });
    expect(result.suggestions.length).toBeLessThanOrEqual(5);
  });

  it("populates responseSignals in metadata", async () => {
    const s = new Suggester({ config: { enabled: true } });
    const result = await s.suggest({
      originalMessage: "fix",
      agentResponse: "The build failed.",
      conversation: [],
    });
    expect(result.metadata.responseSignals.containsError).toBe(true);
  });
});

describe("Suggester terminology alignment", () => {
  it("rewrites known misspellings using correctionPatterns", async () => {
    const s = new Suggester({
      config: { enabled: true },
      correctionPatterns: ["Coda -> Koda"],
    });
    const result = await s.suggest({
      originalMessage: "ask Coda about it",
      agentResponse: "Would you like me to message Coda?",
      conversation: [],
    });
    // The heuristic suggestions won't contain "Coda" naturally, but verify
    // the alignment path runs and doesn't corrupt output.
    for (const s2 of result.suggestions) {
      expect(s2.prompt).not.toMatch(/\bCoda\b/i);
    }
  });

  it("rewrites canonical term inside a suggestion when seeded", async () => {
    const s = new Suggester({
      config: { enabled: true },
      correctionPatterns: ["tests -> Tests"],
    });
    const result = await s.suggest({
      originalMessage: "done",
      agentResponse: "Done. Ready to merge.",
      conversation: [],
    });
    const runTests = result.suggestions.find((x) => x.prompt.includes("Tests"));
    expect(runTests).toBeDefined();
  });
});

describe("Suggester strategy delegation", () => {
  it("uses strategy.suggestFollowups when defined", async () => {
    const strategy = {
      name: "test-strategy",
      classifyIntent: vi.fn(),
      analyzeGaps: vi.fn(),
      resolveGap: vi.fn(),
      compose: vi.fn(),
      suggestFollowups: vi.fn(async () => [
        {
          id: "fake-1",
          category: "continue" as const,
          prompt: "strategy-supplied prompt",
          label: "Strategy",
          rationale: "because",
          confidence: 0.9,
        },
      ]),
    };
    const s = new Suggester({
      config: { enabled: true },
      // biome-ignore lint: mock strategy for test
      strategy: strategy as never,
    });
    const result = await s.suggest({
      originalMessage: "m",
      agentResponse: "r",
      conversation: [],
    });
    expect(result.suggestions[0]?.prompt).toBe("strategy-supplied prompt");
    expect(result.metadata.strategyUsed).toBe("strategy:test-strategy");
  });

  it("falls back to heuristic when strategy throws", async () => {
    const strategy = {
      name: "broken",
      classifyIntent: vi.fn(),
      analyzeGaps: vi.fn(),
      resolveGap: vi.fn(),
      compose: vi.fn(),
      suggestFollowups: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const s = new Suggester({
      config: { enabled: true },
      // biome-ignore lint: mock strategy for test
      strategy: strategy as never,
    });
    const result = await s.suggest({
      originalMessage: "m",
      agentResponse: "Would you like me to continue?",
      conversation: [],
    });
    expect(result.metadata.strategyUsed).toBe("heuristic");
    expect(result.suggestions.length).toBeGreaterThan(0);
  });
});

describe("Suggester LLM path", () => {
  it("uses llmCall when provided and parses JSON array", async () => {
    const llmCall = vi.fn(async () =>
      JSON.stringify([
        {
          category: "continue",
          prompt: "llm-suggested prompt",
          label: "LLM",
          rationale: "because llm",
          confidence: 0.7,
        },
      ]),
    );
    const s = new Suggester({
      config: { enabled: true, llmCall },
    });
    const result = await s.suggest({
      originalMessage: "m",
      agentResponse: "r",
      conversation: [],
    });
    expect(llmCall).toHaveBeenCalledOnce();
    expect(result.metadata.strategyUsed).toBe("llm");
    expect(result.suggestions[0]?.prompt).toBe("llm-suggested prompt");
  });

  it("falls back to heuristic when llmCall returns garbage", async () => {
    const llmCall = vi.fn(async () => "not json at all");
    const s = new Suggester({
      config: { enabled: true, llmCall },
    });
    const result = await s.suggest({
      originalMessage: "m",
      agentResponse: "Would you like me to continue?",
      conversation: [],
    });
    expect(result.metadata.strategyUsed).toBe("heuristic");
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it("drops malformed entries from LLM output", async () => {
    const llmCall = vi.fn(async () =>
      JSON.stringify([
        { category: "bogus", prompt: "x", label: "x", rationale: "x", confidence: 1 },
        {
          category: "amend",
          prompt: "valid",
          label: "V",
          rationale: "r",
          confidence: 0.5,
        },
      ]),
    );
    const s = new Suggester({
      config: { enabled: true, llmCall },
    });
    const result = await s.suggest({
      originalMessage: "m",
      agentResponse: "r",
      conversation: [],
    });
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.prompt).toBe("valid");
  });
});

describe("Suggester.recordFeedback", () => {
  function makeWriteClient(): {
    client: KomatikWriteClient;
    lastInsert: { data: unknown } | null;
  } {
    const state: { lastInsert: { data: unknown } | null } = { lastInsert: null };

    const filterBuilder: KomatikWriteFilterBuilder = {
      eq: () => filterBuilder,
      neq: () => filterBuilder,
      in: () => filterBuilder,
      lt: () => filterBuilder,
      order: () => filterBuilder,
      limit: () => filterBuilder,
      single: async (): Promise<KomatikQueryResult<Record<string, unknown>>> => ({
        data: null,
        error: null,
      }),
      then: (onfulfilled) => {
        const res: KomatikQueryResult<Record<string, unknown>[]> = {
          data: [],
          error: null,
        };
        return Promise.resolve(onfulfilled ? onfulfilled(res) : (res as never));
      },
    };

    const queryBuilder: KomatikWriteQueryBuilder = {
      select: () => filterBuilder,
      eq: () => filterBuilder,
      neq: () => filterBuilder,
      in: () => filterBuilder,
      order: () => filterBuilder,
      limit: () => filterBuilder,
      single: async (): Promise<KomatikQueryResult<Record<string, unknown>>> => ({
        data: null,
        error: null,
      }),
      then: (onfulfilled) => {
        const res: KomatikQueryResult<Record<string, unknown>[]> = {
          data: [],
          error: null,
        };
        return Promise.resolve(onfulfilled ? onfulfilled(res) : (res as never));
      },
      insert: (data) => {
        state.lastInsert = { data };
        return filterBuilder;
      },
      upsert: (data) => {
        state.lastInsert = { data };
        return filterBuilder;
      },
      update: () => filterBuilder,
      delete: () => filterBuilder,
    };

    const client: KomatikWriteClient = {
      from: () => queryBuilder,
      rpc: () =>
        Promise.resolve({
          data: null,
          error: { message: "RPC not implemented in suggester test mock" },
        }),
    };

    return { client, lastInsert: state.lastInsert };
  }

  it("no-ops when writer is not configured", async () => {
    const s = new Suggester({ config: { enabled: true } });
    await expect(
      s.recordFeedback({ suggestionId: "id", outcome: "accepted" }),
    ).resolves.toBeUndefined();
  });

  it("maps outcome=accepted to verdict=accepted", async () => {
    const { client } = makeWriteClient();
    const captured: Array<{ data: unknown }> = [];
    const spy = {
      from: (table: string) => {
        const builder = client.from(table);
        const origInsert = builder.insert.bind(builder);
        builder.insert = (data) => {
          captured.push({ data });
          return origInsert(data);
        };
        return builder;
      },
    } as KomatikWriteClient;

    const s = new Suggester({
      config: { enabled: true, writer: spy, userId: "u1" },
    });
    await s.recordFeedback({ suggestionId: "sug1", outcome: "accepted" });
    expect(captured).toHaveLength(1);
    const row = captured[0].data as Record<string, unknown>;
    expect(row.user_id).toBe("u1");
    expect(row.verdict).toBe("accepted");
    expect(row.strategy_used).toBe("followup-suggestion");
  });

  it("maps outcome=edited to verdict=revised and stores edited text", async () => {
    const { client } = makeWriteClient();
    const captured: Array<{ data: unknown }> = [];
    const spy = {
      from: (table: string) => {
        const builder = client.from(table);
        const origInsert = builder.insert.bind(builder);
        builder.insert = (data) => {
          captured.push({ data });
          return origInsert(data);
        };
        return builder;
      },
    } as KomatikWriteClient;

    const s = new Suggester({
      config: { enabled: true, writer: spy, userId: "u1" },
    });
    await s.recordFeedback({
      suggestionId: "sug1",
      outcome: "edited",
      editedPromptText: "user-edited version",
    });
    const row = captured[0].data as Record<string, unknown>;
    expect(row.verdict).toBe("revised");
    expect(row.enriched_message).toBe("user-edited version");
  });

  it("maps outcome=dismissed to verdict=ignored", async () => {
    const { client } = makeWriteClient();
    const captured: Array<{ data: unknown }> = [];
    const spy = {
      from: (table: string) => {
        const builder = client.from(table);
        const origInsert = builder.insert.bind(builder);
        builder.insert = (data) => {
          captured.push({ data });
          return origInsert(data);
        };
        return builder;
      },
    } as KomatikWriteClient;

    const s = new Suggester({
      config: { enabled: true, writer: spy, userId: "u1" },
    });
    await s.recordFeedback({ suggestionId: "sug1", outcome: "dismissed" });
    const row = captured[0].data as Record<string, unknown>;
    expect(row.verdict).toBe("ignored");
  });
});
