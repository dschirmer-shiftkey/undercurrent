// ─── Komatik Supabase Row Types ──────────────────────────────────────────────
// TypeScript representations of the tables created in Komatik PR #800.
// These are the "Apple of AI" ecosystem tables that power identity-aware
// enrichment. Every type matches a migration file 1:1.

// ─── komatik_profiles (migration 000009) ────────────────────────────────────

export type KomatikRole =
  | "founder"
  | "developer"
  | "designer"
  | "creator"
  | "enterprise"
  | "student";

export interface KomatikProfile {
  id: string;
  display_name: string | null;
  email: string;
  avatar_url: string | null;
  primary_role: KomatikRole | null;
  products_used: string[];
  onboarding_complete: boolean;
  created_at: string;
  updated_at: string;
}

// ─── user_product_events (migration 000005) ─────────────────────────────────

export type ProductEventType =
  | "visited"
  | "signed_up"
  | "purchased"
  | "completed_quiz"
  | "submitted_intake"
  | "started_trial"
  | "custom";

export interface UserProductEvent {
  id: string;
  user_id: string | null;
  email: string | null;
  product_slug: string;
  event_type: ProductEventType;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ─── crm_contacts (migration 000010) ────────────────────────────────────────

export type CrmSource =
  | "quiz"
  | "triage"
  | "floe"
  | "forge_waitlist"
  | "deployguard"
  | "organic"
  | "referral"
  | "outreach";

export type CrmStatus = "lead" | "qualified" | "opportunity" | "customer" | "churned";

export interface CrmContact {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  source: CrmSource;
  status: CrmStatus;
  score: number;
  tags: string[];
  metadata: Record<string, unknown>;
  first_seen_at: string;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
}

// ─── crm_activities (migration 000010) ──────────────────────────────────────

export type CrmActivityType =
  | "quiz_completed"
  | "triage_submitted"
  | "triage_paid"
  | "floe_submitted"
  | "floe_paid"
  | "forge_waitlist"
  | "marketplace_signup"
  | "consultation_booked"
  | "email_sent"
  | "email_opened"
  | "note"
  | "call"
  | "meeting";

export interface CrmActivity {
  id: string;
  contact_id: string;
  deal_id: string | null;
  activity_type: CrmActivityType;
  description: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ─── crm_deals (migration 000010) ───────────────────────────────────────────

export type CrmDealStage =
  | "new"
  | "contacted"
  | "qualified"
  | "proposal"
  | "negotiation"
  | "won"
  | "lost";

export interface CrmDeal {
  id: string;
  contact_id: string;
  title: string;
  product_slug: string;
  stage: CrmDealStage;
  value_cents: number;
  currency: string;
  notes: string | null;
  metadata: Record<string, unknown>;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── triage_intakes (migration 000002) ──────────────────────────────────────

export type TriageProjectType = "repo" | "link" | "figma" | "description" | "other";

export type TriageUrgency = "low" | "medium" | "high";

export type TriageStatus =
  | "pending"
  | "payment_sent"
  | "paid"
  | "in_progress"
  | "delivered"
  | "cancelled";

export interface TriageIntake {
  id: string;
  name: string;
  email: string;
  project_url: string | null;
  project_type: TriageProjectType;
  description: string;
  urgency: TriageUrgency;
  budget: string | null;
  status: TriageStatus;
  stripe_checkout_url: string | null;
  stripe_payment_intent: string | null;
  report_url: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// ─── floe_scans (migration 000006) ──────────────────────────────────────────

export type FloeScanTier = "quick" | "deep" | "full_audit";

export type FloeScanStatus =
  | "pending"
  | "payment_required"
  | "paid"
  | "scanning"
  | "completed"
  | "failed"
  | "cancelled";

export type FloeFindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface FloeScan {
  id: string;
  email: string;
  user_id: string | null;
  repo_url: string | null;
  repo_name: string | null;
  scan_tier: FloeScanTier;
  status: FloeScanStatus;
  stripe_checkout_url: string | null;
  stripe_payment_intent: string | null;
  findings_summary: Record<string, unknown>;
  findings_count: number;
  critical_count: number;
  high_count: number;
  medium_count: number;
  low_count: number;
  report_url: string | null;
  scan_started_at: string | null;
  scan_completed_at: string | null;
  scan_duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

// ─── forge_tools (migration 000007) ─────────────────────────────────────────

export type ForgeCategory =
  | "general"
  | "code"
  | "data"
  | "infra"
  | "security"
  | "productivity"
  | "communication"
  | "analytics"
  | "design"
  | "ai";

export type ForgePricingModel = "free" | "per_call" | "monthly" | "tiered";

export type ForgeToolStatus = "pending_review" | "active" | "suspended" | "deprecated";

export interface ForgeTool {
  id: string;
  author_id: string | null;
  author_email: string;
  slug: string;
  name: string;
  tagline: string;
  description: string | null;
  server_url: string;
  category: ForgeCategory;
  tags: string[];
  pricing_model: ForgePricingModel;
  status: ForgeToolStatus;
  is_verified: boolean;
  trust_score: number;
  total_calls: number;
  created_at: string;
  updated_at: string;
}

// ─── forge_usage (migration 000007) ─────────────────────────────────────────

export interface ForgeUsage {
  id: string;
  tool_id: string;
  consumer_id: string | null;
  latency_ms: number | null;
  success: boolean;
  cost_cents: number;
  created_at: string;
}

// ─── llm_usage (migration 000004) ───────────────────────────────────────────

export interface LlmUsage {
  id: string;
  provider: string;
  model: string;
  task_type: string;
  product: string;
  input_tokens: number;
  output_tokens: number;
  cost_cents: number;
  latency_ms: number | null;
  cascade_depth: number;
  success: boolean;
  error_message: string | null;
  user_id: string | null;
  created_at: string;
}

// ─── model_availability (migration 000004) ──────────────────────────────────

export type ModelStatus = "discovered" | "smoke_tested" | "active" | "deprecated" | "unavailable";

export interface ModelAvailability {
  id: string;
  model_id: string;
  provider: string;
  api_model_name: string;
  display_name: string | null;
  model_family: string | null;
  status: ModelStatus;
  discovered_at: string;
  last_checked_at: string;
  smoke_test_passed: boolean | null;
  smoke_test_latency_ms: number | null;
  metadata: Record<string, unknown>;
}

// ─── user_preferences (new table for Undercurrent internal track) ────────────

export type PreferenceTone = "formal" | "casual" | "terse" | "friendly";

export type PreferenceExplanationDepth = "minimal" | "standard" | "deep";

export type PreferenceResponseFormat = "code-first" | "plan-first" | "explanation-first" | "mixed";

export interface CodeStylePreferences {
  language: string | null;
  framework: string | null;
  paradigm: string | null;
  indent: string | null;
  other: string[];
}

export interface UserPreferences {
  id: string;
  user_id: string;
  tone: PreferenceTone | null;
  explanation_depth: PreferenceExplanationDepth | null;
  response_format: PreferenceResponseFormat | null;
  code_style: CodeStylePreferences;
  always_assume: string[];
  never_assume: string[];
  undercurrent_settings: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

// ─── enrichment_outcomes (new table for outcome learning) ────────────────────

export type OutcomeVerdict = "accepted" | "rejected" | "revised" | "ignored";

export interface EnrichmentOutcome {
  id: string;
  user_id: string;
  enrichment_id: string | null;
  original_message: string;
  enriched_message: string;
  strategy_used: string;
  enrichment_depth: string;
  verdict: OutcomeVerdict | null;
  assumptions_accepted: string[];
  assumptions_corrected: string[];
  correction_details: Record<string, unknown>;
  platform: string | null;
  session_id: string | null;
  processing_time_ms: number | null;
  context_layer_count: number;
  assumption_count: number;
  gap_count: number;
  model_used: string | null;
  had_mutations: boolean;
  tool_calls: number;
  workspace_id: string | null;
  created_at: string;
}

// ─── session_memories (new table for session continuity) ─────────────────────

export type MemoryType =
  | "decision"
  | "unresolved"
  | "active-work"
  | "preference-learned"
  | "correction";

export interface SessionMemory {
  id: string;
  user_id: string;
  memory_type: MemoryType;
  content: string;
  context_key: string | null;
  relevance_score: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Aggregate Context Type ─────────────────────────────────────────────────
// The full picture of a Komatik user — assembled by the adapters, consumed
// by strategies that understand the Komatik ecosystem.

export interface KomatikUserContext {
  profile: KomatikProfile | null;
  preferences: UserPreferences | null;
  recentEvents: UserProductEvent[];
  crmContact: CrmContact | null;
  recentActivities: CrmActivity[];
  triageIntakes: TriageIntake[];
  floeScans: FloeScan[];
  forgeToolsAuthored: ForgeTool[];
  forgeUsage: ForgeUsage[];
  recentOutcomes: EnrichmentOutcome[];
  sessionMemories: SessionMemory[];
}
