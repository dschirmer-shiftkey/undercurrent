import type { KomatikDataClient, KomatikWriteClient } from "./client.js";
import type { CostTier } from "../types.js";

/**
 * Thin read/write wrapper around the `user_preferences.undercurrent_settings`
 * JSON column on the Komatik schema. The shape mirrors the IDE's live
 * settings panel exactly so the SDK and the host UI never drift.
 *
 * The DB column name (`undercurrent_settings`) is preserved from before the
 * Slipstream rename to avoid breaking the existing Komatik integration. All
 * Slipstream-owned settings live as keys inside that JSON bag.
 */

export type EnrichmentDepth = "auto" | "light" | "standard" | "deep";
export type StrategyChoice = "default" | "llm";

/**
 * Mirrors `platform/web/app/api/workspace-agent/undercurrentEnricher.ts` →
 * `UndercurrentSettings`. Keys must stay byte-identical for the IDE round-trip.
 *
 * Reference: Komatik/platform/web/app/api/workspace-agent/undercurrentEnricher.ts
 */
export interface UndercurrentSettings {
  /** Master on/off — when false, the IDE skips Slipstream entirely. */
  enabled: boolean;
  /** Per-user override for pipeline enrichment depth. */
  enrichmentDepth: EnrichmentDepth;
  /** Heuristic vs LLM-assisted strategy. */
  strategy: StrategyChoice;
  /** Whether the IDE shows the enrichment metadata panel under each message. */
  showEnrichmentDetails: boolean;
  /**
   * NEW for v2.0+: when true, the IDE honors Slipstream's
   * `metadata.tierRecommendation.tier` instead of the user's manual pick.
   * Defaults to false (user pick wins).
   */
  autoTier?: boolean;
  /**
   * Optional per-user fallback tier when no explicit choice exists.
   * Used by the IDE when `autoTier` is off and there's no in-session pick.
   */
  defaultTier?: CostTier;
}

export const DEFAULT_UNDERCURRENT_SETTINGS: UndercurrentSettings = {
  enabled: false,
  enrichmentDepth: "auto",
  strategy: "default",
  showEnrichmentDetails: true,
  autoTier: false,
};

export interface KomatikPreferenceClientOptions {
  client: KomatikDataClient;
  writeClient: KomatikWriteClient;
}

const VALID_DEPTHS: EnrichmentDepth[] = ["auto", "light", "standard", "deep"];
const VALID_STRATEGIES: StrategyChoice[] = ["default", "llm"];
const VALID_TIERS: CostTier[] = ["budget", "balanced", "premium"];

function isDepth(value: unknown): value is EnrichmentDepth {
  return typeof value === "string" && (VALID_DEPTHS as readonly string[]).includes(value);
}
function isStrategy(value: unknown): value is StrategyChoice {
  return typeof value === "string" && (VALID_STRATEGIES as readonly string[]).includes(value);
}
function isCostTier(value: unknown): value is CostTier {
  return typeof value === "string" && (VALID_TIERS as readonly string[]).includes(value);
}

function sanitize(raw: Record<string, unknown>): UndercurrentSettings {
  const merged = { ...DEFAULT_UNDERCURRENT_SETTINGS };
  if (typeof raw.enabled === "boolean") merged.enabled = raw.enabled;
  if (isDepth(raw.enrichmentDepth)) merged.enrichmentDepth = raw.enrichmentDepth;
  if (isStrategy(raw.strategy)) merged.strategy = raw.strategy;
  if (typeof raw.showEnrichmentDetails === "boolean") {
    merged.showEnrichmentDetails = raw.showEnrichmentDetails;
  }
  if (typeof raw.autoTier === "boolean") merged.autoTier = raw.autoTier;
  if (isCostTier(raw.defaultTier)) merged.defaultTier = raw.defaultTier;
  return merged;
}

export class KomatikPreferenceClient {
  private readonly client: KomatikDataClient;
  private readonly writeClient: KomatikWriteClient;

  constructor(options: KomatikPreferenceClientOptions) {
    this.client = options.client;
    this.writeClient = options.writeClient;
  }

  /**
   * Returns the merged-with-defaults UndercurrentSettings for a user.
   * Always returns a complete object — missing keys fall through to
   * DEFAULT_UNDERCURRENT_SETTINGS so callers never have to null-check fields.
   */
  async getUndercurrentSettings(userId: string): Promise<UndercurrentSettings> {
    const bag = await this.readSettingsBag(userId);
    return sanitize(bag ?? {});
  }

  /**
   * Patch-style update — merges `partial` into the existing bag, preserving
   * any other keys the host might write (forward-compatibility with future
   * IDE-owned settings).
   */
  async updateUndercurrentSettings(
    userId: string,
    partial: Partial<UndercurrentSettings>,
  ): Promise<void> {
    const existing = (await this.readSettingsBag(userId)) ?? {};
    const merged: Record<string, unknown> = { ...existing };
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) merged[key] = value;
    }

    const { error } = await this.writeClient
      .from("user_preferences")
      .upsert({ user_id: userId, undercurrent_settings: merged });

    if (error) {
      throw new Error(`KomatikPreferenceClient.updateUndercurrentSettings failed: ${error.message}`);
    }
  }

  /** Convenience: just toggle the master enable flag. */
  async setEnabled(userId: string, enabled: boolean): Promise<void> {
    return this.updateUndercurrentSettings(userId, { enabled });
  }

  /** Convenience: opt into auto-tier (Slipstream picks tier instead of the user). */
  async setAutoTier(userId: string, autoTier: boolean): Promise<void> {
    return this.updateUndercurrentSettings(userId, { autoTier });
  }

  /** Convenience: set a per-user default tier (used when autoTier is off). */
  async setDefaultTier(userId: string, defaultTier: CostTier): Promise<void> {
    return this.updateUndercurrentSettings(userId, { defaultTier });
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
