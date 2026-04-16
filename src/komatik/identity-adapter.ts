import type { AdapterInput, ContextAdapter, ContextLayer } from "../types.js";
import type { KomatikAdapterOptions, KomatikDataClient } from "./client.js";
import type { KomatikProfile } from "./types.js";

/**
 * Queries komatik_profiles for the authenticated user.
 * Returns identity context: who they are, their role, which products
 * they've used, and whether they've completed onboarding.
 *
 * This adapter runs at priority 0 — identity is foundational context
 * that other adapters and the strategy can build on.
 */
export class KomatikIdentityAdapter implements ContextAdapter {
  readonly name = "komatik-identity";
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
    const { data: profile, error } = await this.client
      .from("komatik_profiles")
      .select("*")
      .eq("id", this.userId)
      .single();

    if (error || !profile) {
      return [];
    }

    const p = profile as unknown as KomatikProfile;
    const layers: ContextLayer[] = [];

    const rolePart = p.primary_role ? ` (${p.primary_role})` : "";
    const productsPart =
      p.products_used.length > 0
        ? ` — uses ${p.products_used.join(", ")}`
        : "";
    const onboardingPart = p.onboarding_complete
      ? "Onboarding complete."
      : "Onboarding not yet complete.";

    layers.push({
      source: this.name,
      priority: this.priority,
      timestamp: Date.now(),
      data: {
        profile: p,
        userId: this.userId,
      },
      summary: `${p.display_name ?? p.email}${rolePart}${productsPart}. ${onboardingPart}`,
    });

    return layers;
  }
}
