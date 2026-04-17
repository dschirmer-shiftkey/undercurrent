import type { AdapterInput, ContextAdapter, ContextLayer } from "../types.js";
import type { KomatikAdapterOptions, KomatikDataClient } from "./client.js";
import type { CrmActivity, CrmContact, UserProductEvent } from "./types.js";

/**
 * Queries user_product_events and crm_activities to build a behavioral
 * history of the user across the Komatik ecosystem.
 *
 * Returns context about: recent product interactions, activity trajectory,
 * CRM lead score, and engagement patterns.
 */
export class KomatikHistoryAdapter implements ContextAdapter {
  readonly name = "komatik-history";
  readonly priority = 1;

  private readonly client: KomatikDataClient;
  private readonly userId: string;
  private readonly maxEvents: number;
  private readonly maxActivities: number;

  constructor(
    options: KomatikAdapterOptions & {
      maxEvents?: number;
      maxActivities?: number;
    },
  ) {
    this.client = options.client;
    this.userId = options.userId;
    this.maxEvents = options.maxEvents ?? 50;
    this.maxActivities = options.maxActivities ?? 30;
  }

  async available(): Promise<boolean> {
    return Boolean(this.userId);
  }

  async gather(_input: AdapterInput): Promise<ContextLayer[]> {
    const layers: ContextLayer[] = [];

    const [eventsResult, contactResult] = await Promise.allSettled([
      this.fetchEvents(),
      this.fetchCrmContact(),
    ]);

    const events = eventsResult.status === "fulfilled" ? eventsResult.value : [];
    const contact = contactResult.status === "fulfilled" ? contactResult.value : null;

    if (events.length > 0) {
      layers.push({
        source: this.name,
        priority: this.priority,
        timestamp: Date.now(),
        data: { events },
        summary: this.summarizeEvents(events),
      });
    }

    if (contact) {
      const activities = await this.fetchActivities(contact.id);

      layers.push({
        source: this.name,
        priority: this.priority,
        timestamp: Date.now(),
        data: {
          contact,
          activities,
        },
        summary: this.summarizeContact(contact, activities),
      });
    }

    return layers;
  }

  private async fetchEvents(): Promise<UserProductEvent[]> {
    const { data, error } = await this.client
      .from("user_product_events")
      .select("*")
      .eq("user_id", this.userId)
      .order("created_at", { ascending: false })
      .limit(this.maxEvents);

    if (error || !data) return [];
    return data as unknown as UserProductEvent[];
  }

  private async fetchCrmContact(): Promise<CrmContact | null> {
    const { data: profile } = await this.client
      .from("komatik_profiles")
      .select("email")
      .eq("id", this.userId)
      .single();

    if (!profile) return null;
    const email = (profile as unknown as { email: string }).email;

    const { data: contact, error } = await this.client
      .from("crm_contacts")
      .select("*")
      .eq("email", email)
      .single();

    if (error || !contact) return null;
    return contact as unknown as CrmContact;
  }

  private async fetchActivities(contactId: string): Promise<CrmActivity[]> {
    const { data, error } = await this.client
      .from("crm_activities")
      .select("*")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(this.maxActivities);

    if (error || !data) return [];
    return data as unknown as CrmActivity[];
  }

  private summarizeEvents(events: UserProductEvent[]): string {
    const productCounts = new Map<string, number>();
    for (const e of events) {
      productCounts.set(e.product_slug, (productCounts.get(e.product_slug) ?? 0) + 1);
    }

    const recentSlice = events.slice(0, 5);
    const recentParts = recentSlice.map((e) => {
      const age = this.formatAge(e.created_at);
      return `${e.event_type} on ${e.product_slug} (${age})`;
    });

    const totalProducts = productCounts.size;
    return `${events.length} product events across ${totalProducts} product(s). Recent: ${recentParts.join(", ")}`;
  }

  private summarizeContact(contact: CrmContact, activities: CrmActivity[]): string {
    const parts: string[] = [];
    parts.push(`CRM: ${contact.status} (score ${contact.score})`);
    parts.push(`source: ${contact.source}`);

    if (activities.length > 0) {
      const trajectory = activities
        .slice(0, 5)
        .map((a) => a.activity_type)
        .reverse()
        .join(" → ");
      parts.push(`trajectory: ${trajectory}`);
    }

    return parts.join(", ");
  }

  private formatAge(isoDate: string): string {
    const ms = Date.now() - new Date(isoDate).getTime();
    const hours = Math.floor(ms / (1000 * 60 * 60));
    if (hours < 1) return "just now";
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return "yesterday";
    return `${days}d ago`;
  }
}
