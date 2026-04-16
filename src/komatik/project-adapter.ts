import type { AdapterInput, ContextAdapter, ContextLayer } from "../types.js";
import type { KomatikAdapterOptions, KomatikDataClient } from "./client.js";
import type { FloeScan, TriageIntake } from "./types.js";

/**
 * Queries triage_intakes and floe_scans for the authenticated user.
 * Returns context about active projects, diagnostic requests, and
 * security scan history — the things they're actually working on.
 */
export class KomatikProjectAdapter implements ContextAdapter {
  readonly name = "komatik-projects";
  readonly priority = 2;

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
    const layers: ContextLayer[] = [];

    const [intakesResult, scansResult] = await Promise.allSettled([
      this.fetchTriageIntakes(),
      this.fetchFloeScans(),
    ]);

    const intakes =
      intakesResult.status === "fulfilled" ? intakesResult.value : [];
    const scans =
      scansResult.status === "fulfilled" ? scansResult.value : [];

    if (intakes.length > 0) {
      layers.push({
        source: this.name,
        priority: this.priority,
        timestamp: Date.now(),
        data: { triageIntakes: intakes },
        summary: this.summarizeIntakes(intakes),
      });
    }

    if (scans.length > 0) {
      layers.push({
        source: this.name,
        priority: this.priority,
        timestamp: Date.now(),
        data: { floeScans: scans },
        summary: this.summarizeScans(scans),
      });
    }

    return layers;
  }

  private async fetchTriageIntakes(): Promise<TriageIntake[]> {
    const { data: profile } = await this.client
      .from("komatik_profiles")
      .select("email")
      .eq("id", this.userId)
      .single();

    if (!profile) return [];
    const email = (profile as unknown as { email: string }).email;

    const { data, error } = await this.client
      .from("triage_intakes")
      .select("*")
      .eq("email", email)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error || !data) return [];
    return data as unknown as TriageIntake[];
  }

  private async fetchFloeScans(): Promise<FloeScan[]> {
    const { data, error } = await this.client
      .from("floe_scans")
      .select("*")
      .eq("user_id", this.userId)
      .order("created_at", { ascending: false })
      .limit(10);

    if (error || !data) return [];
    return data as unknown as FloeScan[];
  }

  private summarizeIntakes(intakes: TriageIntake[]): string {
    const active = intakes.filter(
      (i) => i.status !== "delivered" && i.status !== "cancelled",
    );
    const delivered = intakes.filter((i) => i.status === "delivered");

    const parts: string[] = [];

    if (active.length > 0) {
      const top = active[0]!;
      const desc =
        top.description.length > 80
          ? top.description.slice(0, 80) + "..."
          : top.description;
      parts.push(
        `Active triage: "${desc}" (${top.status}, ${top.urgency} urgency)`,
      );
      if (active.length > 1) {
        parts.push(`+${active.length - 1} more active`);
      }
    }

    if (delivered.length > 0) {
      parts.push(`${delivered.length} delivered diagnostic(s)`);
    }

    if (parts.length === 0) {
      return `${intakes.length} triage intake(s), all ${intakes[0]!.status}`;
    }

    return parts.join(". ");
  }

  private summarizeScans(scans: FloeScan[]): string {
    const byStatus = new Map<string, number>();
    let totalFindings = 0;
    let totalCritical = 0;

    for (const s of scans) {
      byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
      totalFindings += s.findings_count;
      totalCritical += s.critical_count;
    }

    const statusParts = [...byStatus.entries()]
      .map(([status, count]) => `${count} ${status}`)
      .join(", ");

    const findingsPart =
      totalFindings > 0
        ? ` — ${totalFindings} total findings (${totalCritical} critical)`
        : "";

    return `${scans.length} Floe scan(s): ${statusParts}${findingsPart}`;
  }
}
