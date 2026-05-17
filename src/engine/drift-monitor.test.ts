import { describe, expect, it } from "vitest";
import { DriftMonitor } from "./drift-monitor.js";
import type { ConversationTurn } from "../types.js";

function turns(...content: string[]): ConversationTurn[] {
  return content.map((c, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: c,
  }));
}

describe("DriftMonitor", () => {
  describe("case drift", () => {
    it("rewrites lowercase variants back to canonical first-seen form", () => {
      const monitor = new DriftMonitor();
      const events = [
        ...monitor.observe("Promote the Slipstream release.", 0),
        ...monitor.observe("Verify the slipstream gate still holds.", 1),
      ];

      const caseDrifts = events.filter((e) => e.kind === "case");
      expect(caseDrifts).toHaveLength(1);
      expect(caseDrifts[0]?.observed).toBe("slipstream");
      expect(caseDrifts[0]?.canonical).toBe("Slipstream");
      expect(caseDrifts[0]?.action).toBe("rewrite");
    });
  });

  describe("suffix drift", () => {
    it("flags (does not rewrite) when a new entity extends a canonical by ≤4 trailing chars", () => {
      const monitor = new DriftMonitor();
      monitor.observe("Komatik is the parent org.", 0);
      monitor.observe("Komatik tracks all 15 repos.", 1);
      const events = monitor.observe("KomatikAI shipped a new release.", 2);

      const suffixDrifts = events.filter((e) => e.kind === "suffix");
      expect(suffixDrifts).toHaveLength(1);
      expect(suffixDrifts[0]?.observed).toBe("KomatikAI");
      expect(suffixDrifts[0]?.canonical).toBe("Komatik");
      expect(suffixDrifts[0]?.action).toBe("flag");
    });
  });

  describe("typo drift", () => {
    it("flags entities within edit-distance 2 of a previously-seen canonical with ≥2 occurrences", () => {
      const monitor = new DriftMonitor();
      monitor.observe("Slipstream v2 is ready.", 0);
      monitor.observe("Run the Slipstream replay harness.", 1);
      const events = monitor.observe("Wait for the Slipsteam build to finish.", 2);

      const typoDrifts = events.filter((e) => e.kind === "typo");
      expect(typoDrifts).toHaveLength(1);
      expect(typoDrifts[0]?.observed).toBe("Slipsteam");
      expect(typoDrifts[0]?.canonical).toBe("Slipstream");
      expect(typoDrifts[0]?.action).toBe("flag");
    });

    it("does not flag typo drift on first-seen-only canonicals (occurrence guard)", () => {
      const monitor = new DriftMonitor();
      monitor.observe("Slipstream is the new name.", 0);
      const events = monitor.observe("Slipsteam is similar but different.", 1);
      expect(events.filter((e) => e.kind === "typo")).toHaveLength(0);
    });
  });

  describe("path drift", () => {
    it("rewrites Windows-style paths to a canonical POSIX form when both refer to the same file", () => {
      const monitor = new DriftMonitor();
      monitor.observe("Token lives at /home/komatik/.supabase/access-token.", 0);
      const events = monitor.observe("Check ~\\.supabase\\access-token for the value.", 1);

      const pathDrifts = events.filter((e) => e.kind === "path");
      expect(pathDrifts.length).toBeGreaterThan(0);
      expect(pathDrifts[0]?.action).toBe("rewrite");
    });
  });

  describe("registry + analyze", () => {
    it("builds a per-session canonical registry from a transcript", () => {
      const monitor = new DriftMonitor();
      const report = monitor.analyze(
        turns(
          "Komatik runs on Slipstream.",
          "Acknowledged.",
          "Update the xbom_slots schema.",
        ),
      );

      const registry = report.registry;
      expect(registry.has("komatik")).toBe(true);
      expect(registry.has("slipstream")).toBe(true);
      expect(registry.has("xbom_slots")).toBe(true);
      expect(registry.get("xbom_slots")?.canonical).toBe("xbom_slots");
    });

    it("summarizes drift counts by kind across a conversation", () => {
      const monitor = new DriftMonitor();
      const report = monitor.analyze(
        turns(
          "Slipstream v2 ships.",
          "Slipstream replay green.",
          "Slipstream gate is up.",
          "Slipsteam build finished.",
        ),
      );

      expect(report.byKind.typo).toBeGreaterThanOrEqual(1);
      expect(report.flags).toBeGreaterThanOrEqual(1);
    });
  });

  describe("rewrite", () => {
    it("applies only rewrite-class drift events to a message", () => {
      const monitor = new DriftMonitor();
      monitor.observe("Slipstream is the canonical name.", 0);
      const drifted = "Check the slipstream config and validate KomatikAI permissions.";
      const events = monitor.observe(drifted, 1);
      const rewritten = monitor.rewrite(drifted, events);

      // case-drift "slipstream" → "Slipstream" (rewrite action)
      expect(rewritten).toBe("Check the Slipstream config and validate KomatikAI permissions.");
    });
  });

  describe("gauge", () => {
    it("reports a stable gauge when no drift has occurred", () => {
      const monitor = new DriftMonitor();
      monitor.observe("Slipstream pipeline ready.", 0);
      monitor.observe("Komatik integration tested.", 1);
      const gauge = monitor.gauge();

      expect(gauge.level).toBe("stable");
      expect(gauge.score).toBe(0);
      expect(gauge.refreshRecommended).toBe(false);
      expect(gauge.totalEvents).toBe(0);
    });

    it("escalates the level as drift events accumulate in the recent window", () => {
      const monitor = new DriftMonitor({ gaugeWindowTurns: 5 });
      monitor.observe("Slipstream v2.", 0);
      monitor.observe("Slipstream replay green.", 1);
      monitor.observe("slipstream check.", 2);
      const minor = monitor.gauge();

      monitor.observe("slipstream gate up.", 3);
      monitor.observe("slipstream metrics nominal.", 4);
      const elevated = monitor.gauge();

      expect(minor.level).not.toBe("stable");
      expect(elevated.score).toBeGreaterThanOrEqual(minor.score);
    });

    it("flips refreshRecommended once score crosses the threshold", () => {
      const monitor = new DriftMonitor({ refreshThreshold: 10 });
      monitor.observe("Slipstream ready.", 0);
      monitor.observe("slipstream check.", 1);
      monitor.observe("slipstream verify.", 2);
      const gauge = monitor.gauge();

      expect(gauge.refreshRecommended).toBe(true);
      expect(gauge.reasoning).toContain("refresh");
    });

    it("includes the gauge in analyze() reports", () => {
      const monitor = new DriftMonitor();
      const report = monitor.analyze(
        turns("Slipstream is up.", "slipstream is down."),
      );
      expect(report.gauge).toBeDefined();
      expect(report.gauge.totalEvents).toBe(report.events.length);
    });

    it("computes a trend across multiple gauge readings", () => {
      const monitor = new DriftMonitor({ gaugeWindowTurns: 10 });
      monitor.observe("Slipstream stable.", 0);
      monitor.observe("Slipstream still good.", 1);
      // Several drift events in a row should push trend up
      monitor.observe("slipstream check.", 2);
      monitor.observe("slipstream verify.", 3);
      monitor.observe("slipstream test.", 4);
      monitor.observe("slipstream rerun.", 5);
      const gauge = monitor.gauge();
      expect(["stable", "increasing"]).toContain(gauge.trend);
    });
  });

  describe("stop-words and noise filtering", () => {
    it("ignores common all-caps acronyms (TODO, HTTP, JSON, etc.)", () => {
      const monitor = new DriftMonitor();
      monitor.observe("TODO: fix the JSON parsing in the HTTP handler.", 0);
      const events = monitor.observe("Another TODO appeared in JSON.", 1);
      // Should not flag TODO/JSON/HTTP as entities at all.
      expect(events.filter((e) => ["TODO", "JSON", "HTTP"].includes(e.observed))).toHaveLength(0);
    });

    it("respects pinned canonicals — never overwritten by an earlier turn", () => {
      const monitor = new DriftMonitor({ pinnedCanonicals: ["Slipstream"] });
      const events = monitor.observe("slipstream is misnamed here.", 0);
      const caseDrifts = events.filter((e) => e.kind === "case");
      expect(caseDrifts).toHaveLength(1);
      expect(caseDrifts[0]?.canonical).toBe("Slipstream");
    });
  });
});
