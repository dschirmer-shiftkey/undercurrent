export { KomatikIdentityAdapter } from "./identity-adapter.js";
export { KomatikHistoryAdapter } from "./history-adapter.js";
export { KomatikProjectAdapter } from "./project-adapter.js";
export { KomatikMarketplaceAdapter } from "./marketplace-adapter.js";
export { KomatikPreferenceAdapter } from "./preference-adapter.js";
export { KomatikOutcomeAdapter } from "./outcome-adapter.js";
export { KomatikMemoryAdapter } from "./memory-adapter.js";

export type {
  KomatikDataClient,
  KomatikQueryBuilder,
  KomatikFilterBuilder,
  KomatikQueryResult,
  KomatikQueryError,
  KomatikAdapterOptions,
} from "./client.js";

export type {
  KomatikProfile,
  KomatikRole,
  UserProductEvent,
  ProductEventType,
  CrmContact,
  CrmSource,
  CrmStatus,
  CrmActivity,
  CrmActivityType,
  CrmDeal,
  CrmDealStage,
  TriageIntake,
  TriageProjectType,
  TriageUrgency,
  TriageStatus,
  FloeScan,
  FloeScanTier,
  FloeScanStatus,
  FloeFindingSeverity,
  ForgeTool,
  ForgeCategory,
  ForgePricingModel,
  ForgeToolStatus,
  ForgeUsage,
  LlmUsage,
  ModelAvailability,
  ModelStatus,
  KomatikUserContext,
  UserPreferences,
  PreferenceTone,
  PreferenceExplanationDepth,
  PreferenceResponseFormat,
  CodeStylePreferences,
  EnrichmentOutcome,
  OutcomeVerdict,
  SessionMemory,
  MemoryType,
} from "./types.js";
