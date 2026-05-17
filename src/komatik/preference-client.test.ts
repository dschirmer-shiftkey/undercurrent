import { describe, it, expect } from "vitest";
import { KomatikPreferenceClient } from "./preference-client.js";
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
  describe("getTierBias", () => {
    it("returns null when the user has no preferences row", async () => {
      const { pref } = makeClient();
      expect(await pref.getTierBias("user-1")).toBeNull();
    });

    it("returns null when the user has a row but no undercurrent_settings", async () => {
      const { pref } = makeClient([
        { user_id: "user-1", undercurrent_settings: null },
      ]);
      expect(await pref.getTierBias("user-1")).toBeNull();
    });

    it("returns null when undercurrent_settings exists but has no tier_bias key", async () => {
      const { pref } = makeClient([
        { user_id: "user-1", undercurrent_settings: { other_setting: "value" } },
      ]);
      expect(await pref.getTierBias("user-1")).toBeNull();
    });

    it("returns the stored tier_bias when valid", async () => {
      const { pref } = makeClient([
        { user_id: "user-1", undercurrent_settings: { tier_bias: "premier" } },
      ]);
      expect(await pref.getTierBias("user-1")).toBe("premier");
    });

    it("returns null when tier_bias is set to an invalid value", async () => {
      const { pref } = makeClient([
        { user_id: "user-1", undercurrent_settings: { tier_bias: "unlimited" } },
      ]);
      expect(await pref.getTierBias("user-1")).toBeNull();
    });
  });

  describe("setTierBias", () => {
    it("upserts a tier_bias for a user with no existing preferences", async () => {
      const { pref, writes } = makeClient();
      await pref.setTierBias("user-1", "budget");

      expect(writes.user_preferences?.upserts).toHaveLength(1);
      const upsert = writes.user_preferences!.upserts[0]!;
      expect(upsert.user_id).toBe("user-1");
      expect(upsert.undercurrent_settings).toEqual({ tier_bias: "budget" });
    });

    it("preserves other keys in undercurrent_settings on update", async () => {
      const { pref, writes } = makeClient([
        {
          user_id: "user-1",
          undercurrent_settings: { other_setting: "keep me", drift_threshold: 50 },
        },
      ]);
      await pref.setTierBias("user-1", "premier");

      const upsert = writes.user_preferences!.upserts[0]!;
      expect(upsert.undercurrent_settings).toEqual({
        other_setting: "keep me",
        drift_threshold: 50,
        tier_bias: "premier",
      });
    });

    it("overwrites a previous tier_bias", async () => {
      const { pref, writes } = makeClient([
        { user_id: "user-1", undercurrent_settings: { tier_bias: "budget" } },
      ]);
      await pref.setTierBias("user-1", "premier");

      const upsert = writes.user_preferences!.upserts[0]!;
      expect(upsert.undercurrent_settings).toEqual({ tier_bias: "premier" });
    });
  });
});
