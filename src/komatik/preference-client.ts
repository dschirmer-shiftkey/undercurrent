import type { KomatikDataClient, KomatikWriteClient } from "./client.js";
import type { TierBias } from "./session-manager.js";

/**
 * Thin read/write wrapper around the `user_preferences` table for the
 * Slipstream-specific settings bag. Persistence layer for the IDE's
 * tier-bias preference so the IDE doesn't have to track it per-session.
 *
 * The bag column is named `undercurrent_settings` on the Komatik schema
 * (pre-rename name preserved to avoid breaking the DB integration). All
 * Slipstream-owned settings live as keys inside that JSON column.
 */

const TIER_BIAS_KEY = "tier_bias";
const TIER_VALUES: readonly TierBias[] = ["budget", "balanced", "premier"];

function isTierBias(value: unknown): value is TierBias {
  return typeof value === "string" && (TIER_VALUES as readonly string[]).includes(value);
}

export interface KomatikPreferenceClientOptions {
  client: KomatikDataClient;
  writeClient: KomatikWriteClient;
}

export class KomatikPreferenceClient {
  private readonly client: KomatikDataClient;
  private readonly writeClient: KomatikWriteClient;

  constructor(options: KomatikPreferenceClientOptions) {
    this.client = options.client;
    this.writeClient = options.writeClient;
  }

  /** Returns the stored tier bias for a user, or null if none is set. */
  async getTierBias(userId: string): Promise<TierBias | null> {
    const settings = await this.readSettingsBag(userId);
    if (!settings) return null;
    const value = settings[TIER_BIAS_KEY];
    return isTierBias(value) ? value : null;
  }

  /**
   * Sets the tier bias for a user. Read-merge-upsert pattern preserves
   * other keys in `undercurrent_settings` (e.g., future Slipstream-owned
   * settings the IDE doesn't know about).
   */
  async setTierBias(userId: string, tier: TierBias): Promise<void> {
    const existing = (await this.readSettingsBag(userId)) ?? {};
    const merged: Record<string, unknown> = { ...existing, [TIER_BIAS_KEY]: tier };

    const { error } = await this.writeClient
      .from("user_preferences")
      .upsert({
        user_id: userId,
        undercurrent_settings: merged,
      });

    if (error) {
      throw new Error(`KomatikPreferenceClient.setTierBias failed: ${error.message}`);
    }
  }

  private async readSettingsBag(userId: string): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.client
      .from("user_preferences")
      .select("undercurrent_settings")
      .eq("user_id", userId)
      .single();

    if (error || !data) return null;
    const bag = (data as Record<string, unknown>).undercurrent_settings;
    if (bag === null || bag === undefined || typeof bag !== "object") return null;
    return bag as Record<string, unknown>;
  }
}
