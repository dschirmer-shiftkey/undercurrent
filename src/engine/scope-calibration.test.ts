import { describe, it, expect } from "vitest";
import { Pipeline } from "./pipeline.js";
import { DefaultStrategy } from "../strategies/default.js";
import type { UndercurrentConfig } from "../types.js";

function createPipeline(): Pipeline {
  const config: UndercurrentConfig = {
    adapters: [],
    strategy: new DefaultStrategy(),
  };
  return new Pipeline(config);
}

describe("Graduated Scope Calibration", () => {
  const pipeline = createPipeline();

  it("returns 'none' for high-specificity atomic requests", async () => {
    const result = await pipeline.enrich({
      message: "fix the `validateInput` function on line 42 of src/auth/middleware.ts",
    });
    expect(result.metadata.enrichmentDepth).toBe("none");
    expect(result.enrichedMessage).toBe(result.originalMessage);
  });

  it("returns 'light' or 'standard' for high-specificity non-atomic requests", async () => {
    const result = await pipeline.enrich({
      message: "add a `createdAt` field to the user_profiles table in the schema migration file",
    });
    expect(["light", "standard"]).toContain(result.metadata.enrichmentDepth);
  });

  it("returns 'standard' for medium-specificity requests", async () => {
    const result = await pipeline.enrich({
      message: "check the security stuff in our project",
    });
    expect(["standard", "deep"]).toContain(result.metadata.enrichmentDepth);
  });

  it("returns 'deep' for vague cross-system requests", async () => {
    const result = await pipeline.enrich({
      message: "build the whole authentication system for our platform",
    });
    expect(result.metadata.enrichmentDepth).toBe("deep");
  });

  it("escalates depth when user is frustrated", async () => {
    const calmResult = await pipeline.enrich({
      message: "how does the deploy pipeline work",
    });
    const frustratedResult = await pipeline.enrich({
      message: "this terrible deploy pipeline is broken and I hate it!!",
    });
    const calmDepthOrder = ["none", "light", "standard", "deep"];
    const calmIdx = calmDepthOrder.indexOf(calmResult.metadata.enrichmentDepth);
    const frustratedIdx = calmDepthOrder.indexOf(frustratedResult.metadata.enrichmentDepth);
    expect(frustratedIdx).toBeGreaterThanOrEqual(calmIdx);
  });

  it("keeps depth low for very short simple messages", async () => {
    const result = await pipeline.enrich({
      message: "hello",
    });
    expect(["none", "light", "standard"]).toContain(result.metadata.enrichmentDepth);
  });

  it("status pastes bypass enrichment entirely", async () => {
    const pipeline = createPipeline();
    const result = await pipeline.enrich({
      message: `All green.

Build & Type-Check Platform: pass (4m18s)
CI Gate: pass
PR #864 is now CI-clean.

Our fix works — the SDK loads gracefully at runtime.`,
    });
    expect(result.metadata.enrichmentDepth).toBe("none");
    expect(result.enrichedMessage).toBe(result.originalMessage);
    expect(result.gaps).toHaveLength(0);
    expect(result.assumptions).toHaveLength(0);
  });

  describe("acknowledgments bypass enrichment entirely", () => {
    const ackMessages = [
      "thanks",
      "looks great thank you!",
      "please",
      "ok",
      "perfect",
      "sounds good",
    ];
    for (const msg of ackMessages) {
      it(`passthrough for "${msg}"`, async () => {
        const result = await pipeline.enrich({ message: msg });
        expect(result.metadata.enrichmentDepth).toBe("none");
        expect(result.enrichedMessage).toBe(result.originalMessage);
        expect(result.gaps).toHaveLength(0);
        expect(result.assumptions).toHaveLength(0);
      });
    }
  });

  it("includes targetPlatform in metadata", async () => {
    const result = await pipeline.enrich({
      message: "help me with the api",
      targetPlatform: "cursor",
    });
    expect(result.metadata.targetPlatform).toBe("cursor");
  });

  it("defaults to generic platform when not specified", async () => {
    const result = await pipeline.enrich({
      message: "help me",
    });
    expect(result.metadata.targetPlatform).toBe("generic");
  });
});
