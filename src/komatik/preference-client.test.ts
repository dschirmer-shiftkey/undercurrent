import { describe, it, expect } from "vitest";
import {
  KomatikPreferenceClient,
  DEFAULT_UNDERCURRENT_SETTINGS,
} from "./preference-client.js";
import { createMockClient, createMockWriteClient } from "./testing.js";

function makeClient(initialRows: Record<string, unknown>[] = []) {
  const client = createMockClient({ user_preferences: initialRows });
  const { client: writeClient, writes } = createMockWriteClient({ user_preferences: initialRows });
  return {
    pref: new KomatikPreferenceClient({ client, writeClient }),
    writes,
  };
}

describe("KomatikPreferenceClient", () => {
  describe("getUndercurrentSettings", () => {
    it("returns DEFAULT_UNDERCURRENT_SETTINGS when the user has no row", async () => {
      const { pref } = makeClient();
      expect(await pref.getUndercurrentSettings("u-1")).toEqual(DEFAULT_UNDERCURRENT_SETTINGS);
    });

    it("returns DEFAULT_UNDERCURRENT_SETTINGS when the undercurrent_settings bag is null", async () => {
      const { pref } = makeClient([{ user_id: "u-1", undercurrent_settings: null }]);
      expect(await pref.getUndercurrentSettings("u-1")).toEqual(DEFAULT_UNDERCURRENT_SETTINGS);
    });

    it("merges stored values over defaults, preserving real IDE keys", async () => {
      const { pref } = makeClient([
        {
          user_id: "u-1",
          undercurrent_settings: {
            enabled: true,
            enrichmentDepth: "deep",
            strategy: "llm",
            showEnrichmentDetails: false,
            autoTier: true,
            defaultTier: "premium",
          },
        },
      ]);
      const settings = await pref.getUndercurrentSettings("u-1");
      expect(settings).toEqual({
        enabled: true,
        enrichmentDepth: "deep",
        strategy: "llm",
        showEnrichmentDetails: false,
        autoTier: true,
        defaultTier: "premium",
      });
    });

    it("ignores invalid stored values (e.g., bad enrichmentDepth, deprecated tier names)", async () => {
      const { pref } = makeClient([
        {
          user_id: "u-1",
          undercurrent_settings: {
            enabled: true,
            enrichmentDepth: "ultra-deep",     // invalid
            strategy: "magic",                  // invalid
            defaultTier: "premier",             // invalid (legacy name)
          },
        },
      ]);
      const settings = await pref.getUndercurrentSettings("u-1");
      expect(settings.enabled).toBe(true);
      expect(settings.enrichmentDepth).toBe(DEFAULT_UNDERCURRENT_SETTINGS.enrichmentDepth);
      expect(settings.strategy).toBe(DEFAULT_UNDERCURRENT_SETTINGS.strategy);
      expect(settings.defaultTier).toBeUndefined();
    });
  });

  describe("updateUndercurrentSettings", () => {
    it("upserts a partial patch for a user with no existing settings", async () => {
      const { pref, writes } = makeClient();
      await pref.updateUndercurrentSettings("u-1", { enabled: true, autoTier: true });

      expect(writes.user_preferences?.upserts).toHaveLength(1);
      const upsert = writes.user_preferences!.upserts[0]!;
      expect(upsert.user_id).toBe("u-1");
      expect(upsert.undercurrent_settings).toEqual({ enabled: true, autoTier: true });
    });

    it("preserves other keys in the bag — forward-compat with IDE-only settings", async () => {
      const { pref, writes } = makeClient([
        {
          user_id: "u-1",
          undercurrent_settings: {
            enabled: true,
            enrichmentDepth: "standard",
            showEnrichmentDetails: false,
            future_ide_only_key: "preserved",
          },
        },
      ]);
      await pref.updateUndercurrentSettings("u-1", { autoTier: true });

      const upsert = writes.user_preferences!.upserts[0]!;
      expect(upsert.undercurrent_settings).toEqual({
        enabled: true,
        enrichmentDepth: "standard",
        showEnrichmentDetails: false,
        future_ide_only_key: "preserved",
        autoTier: true,
      });
    });

    it("skips undefined fields in the partial (no accidental overwrite to undefined)", async () => {
      const { pref, writes } = makeClient([
        { user_id: "u-1", undercurrent_settings: { enabled: true, autoTier: true } },
      ]);
      await pref.updateUndercurrentSettings("u-1", { autoTier: undefined, enabled: false });

      const upsert = writes.user_preferences!.upserts[0]!;
      expect(upsert.undercurrent_settings).toEqual({ enabled: false, autoTier: true });
    });
  });

  describe("convenience setters", () => {
    it("setEnabled patches only the enabled key", async () => {
      const { pref, writes } = makeClient([
        { user_id: "u-1", undercurrent_settings: { enabled: false, autoTier: true } },
      ]);
      await pref.setEnabled("u-1", true);
      expect(writes.user_preferences!.upserts[0]!.undercurrent_settings).toMatchObject({
        enabled: true,
        autoTier: true,
      });
    });

    it("setAutoTier flips the auto-tier flag", async () => {
      const { pref, writes } = makeClient();
      await pref.setAutoTier("u-1", true);
      expect(writes.user_preferences!.upserts[0]!.undercurrent_settings).toEqual({ autoTier: true });
    });

    it("setDefaultTier stores a per-user fallback tier", async () => {
      const { pref, writes } = makeClient();
      await pref.setDefaultTier("u-1", "premium");
      expect(writes.user_preferences!.upserts[0]!.undercurrent_settings).toEqual({
        defaultTier: "premium",
      });
    });
  });
});
