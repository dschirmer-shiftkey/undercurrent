import type { AdapterInput, ContextAdapter, ContextLayer } from "../types.js";
import type { KomatikAdapterOptions, KomatikDataClient } from "./client.js";
import type { EnrichmentOutcome } from "./types.js";

/**
 * Queries enrichment_outcomes to understand what enrichments the user
 * accepted, rejected, or revised in past interactions. This feedback
 * loop lets the strategy calibrate confidence and avoid repeating
 * mistakes.
 *
 * Priority 1 — runs after identity/preferences but before project context.
 */
export class KomatikOutcomeAdapter implements ContextAdapter {
  readonly name = "komatik-outcomes";
  readonly priority = 1;

  private readonly client: KomatikDataClient;
  private readonly userId: string;
  private readonly maxOutcomes: number;

  constructor(
    options: KomatikAdapterOptions & { maxOutcomes?: number },
  ) {
    this.client = options.client;
    this.userId = options.userId;
    this.maxOutcomes = options.maxOutcomes ?? 20;
  }

  async available(): Promise<boolean> {
    return Boolean(this.userId);
  }

  async gather(_input: AdapterInput): Promise<ContextLayer[]> {
    const { data, error } = await this.client
      .from("enrichment_outcomes")
      .select("*")
      .eq("user_id", this.userId)
      .order("created_at", { ascending: false })
      .limit(this.maxOutcomes);

    if (error || !data || data.length === 0) {
      return [];
    }

    const outcomes = data as unknown as EnrichmentOutcome[];

    const verdictCounts = new Map<string, number>();
    let totalCorrected = 0;
    const correctionPatterns = new Map<string, number>();

    for (const o of outcomes) {
      verdictCounts.set(o.verdict, (verdictCounts.get(o.verdict) ?? 0) + 1);

      if (o.assumptions_corrected && o.assumptions_corrected.length > 0) {
        totalCorrected += o.assumptions_corrected.length;
        for (const correction of o.assumptions_corrected) {
          correctionPatterns.set(
            correction,
            (correctionPatterns.get(correction) ?? 0) + 1,
          );
        }
      }
    }

    const accepted = verdictCounts.get("accepted") ?? 0;
    const rejected = verdictCounts.get("rejected") ?? 0;
    const revised = verdictCounts.get("revised") ?? 0;
    const total = outcomes.length;
    const acceptanceRate = total > 0 ? ((accepted / total) * 100).toFixed(0) : "0";

    const parts: string[] = [];
    parts.push(
      `${total} recent enrichments: ${accepted} accepted, ${revised} revised, ${rejected} rejected (${acceptanceRate}% acceptance)`,
    );

    if (totalCorrected > 0) {
      const topCorrections = [...correctionPatterns.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([pattern, count]) => `"${pattern}" (${count}x)`);
      parts.push(`Frequent corrections: ${topCorrections.join(", ")}`);
    }

    return [
      {
        source: this.name,
        priority: this.priority,
        timestamp: Date.now(),
        data: {
          outcomes,
          stats: {
            total,
            accepted,
            rejected,
            revised,
            acceptanceRate: Number(acceptanceRate),
            totalCorrected,
            topCorrectionPatterns: Object.fromEntries(correctionPatterns),
          },
        },
        summary: parts.join(". "),
      },
    ];
  }
}
