export { KomatikIdentityAdapter } from "./identity-adapter.js";
export { KomatikHistoryAdapter } from "./history-adapter.js";
export { KomatikProjectAdapter } from "./project-adapter.js";
export { KomatikMarketplaceAdapter } from "./marketplace-adapter.js";
export { KomatikPreferenceAdapter } from "./preference-adapter.js";
export { KomatikOutcomeAdapter } from "./outcome-adapter.js";
export { KomatikMemoryAdapter } from "./memory-adapter.js";
export { KomatikSessionWriter } from "./session-writer.js";
export { KomatikModelUsageAdapter } from "./model-usage-adapter.js";
export type { KomatikModelUsageAdapterOptions } from "./model-usage-adapter.js";
export { createMockClient } from "./testing.js";

export type {
  KomatikDataClient,
  KomatikQueryBuilder,
  KomatikFilterBuilder,
  KomatikQueryResult,
  KomatikQueryError,
  KomatikAdapterOptions,
  KomatikWriteClient,
  KomatikWriteQueryBuilder,
  KomatikWriteFilterBuilder,
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
