import type { AdapterInput, ContextAdapter, ContextLayer } from "../types.js";
import type { KomatikAdapterOptions, KomatikDataClient } from "./client.js";
import type { UserPreferences } from "./types.js";

/**
 * Queries user_preferences for the authenticated user's persistent
 * settings — tone, style, code conventions, response format, and
 * "always assume" rules that travel with the user across every
 * Komatik-powered agent interaction.
 *
 * Priority 0 alongside identity — preferences are foundational context
 * that shape every enrichment pass.
 */
export class KomatikPreferenceAdapter implements ContextAdapter {
  readonly name = "komatik-preferences";
  readonly priority = 0;

  private readonly client: KomatikDataClient;
  private readonly userId: string;

  constructor(options: KomatikAdapterOptions) {
    this.client = options.client;
    this.userId = options.userId;
  }

  async available(): Promise<boolean> {
    return Boolean(this.userId);
  }

  async gather(_input: AdapterInput): Promise<ContextLayer[]> {
    const { data: prefs, error } = await this.client
      .from("user_preferences")
      .select("*")
      .eq("user_id", this.userId)
      .single();

    if (error || !prefs) {
      return [];
    }

    const p = prefs as unknown as UserPreferences;
    const layers: ContextLayer[] = [];

    const parts: string[] = [];

    if (p.tone) {
      parts.push(`Tone: ${p.tone}`);
    }
    if (p.explanation_depth) {
      parts.push(`Explanation depth: ${p.explanation_depth}`);
    }
    if (p.response_format) {
      parts.push(`Response format: ${p.response_format}`);
    }
    if (p.code_style && Object.keys(p.code_style).length > 0) {
      const styleParts: string[] = [];
      if (p.code_style.language) styleParts.push(`language: ${p.code_style.language}`);
      if (p.code_style.framework) styleParts.push(`framework: ${p.code_style.framework}`);
      if (p.code_style.paradigm) styleParts.push(`paradigm: ${p.code_style.paradigm}`);
      if (p.code_style.indent) styleParts.push(`indent: ${p.code_style.indent}`);
      if (p.code_style.other && p.code_style.other.length > 0) {
        styleParts.push(...p.code_style.other);
      }
      if (styleParts.length > 0) {
        parts.push(`Code style: ${styleParts.join(", ")}`);
      }
    }
    if (p.always_assume && p.always_assume.length > 0) {
      parts.push(`Always assume: ${p.always_assume.join("; ")}`);
    }
    if (p.never_assume && p.never_assume.length > 0) {
      parts.push(`Never assume: ${p.never_assume.join("; ")}`);
    }

    const summary =
      parts.length > 0
        ? `User preferences: ${parts.join(". ")}`
        : "User preferences: defaults (no customization)";

    layers.push({
      source: this.name,
      priority: this.priority,
      timestamp: Date.now(),
      data: { preferences: p, userId: this.userId },
      summary,
    });

    return layers;
  }
}
