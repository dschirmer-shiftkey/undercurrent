export { KomatikIdentityAdapter } from "./identity-adapter.js";
export { KomatikHistoryAdapter } from "./history-adapter.js";
export { KomatikProjectAdapter } from "./project-adapter.js";
export { KomatikMarketplaceAdapter } from "./marketplace-adapter.js";
export { KomatikPreferenceAdapter } from "./preference-adapter.js";
export { KomatikOutcomeAdapter } from "./outcome-adapter.js";
export { KomatikMemoryAdapter } from "./memory-adapter.js";
export { KomatikSessionWriter } from "./session-writer.js";
export { KomatikModelUsageAdapter } from "./model-usage-adapter.js";
export { KomatikPilotProcessor } from "./pilot.js";
export { KomatikOutcomeWriter } from "./outcome-writer.js";
export { runPilotSimulation } from "./pilot-simulator.js";
export type {
  PilotSimulationOptions,
  PilotSimulationResult,
  PilotSimulationMessage,
} from "./pilot-simulator.js";
export { SlipstreamSessionManager, TIER_WEIGHT_PRESETS } from "./session-manager.js";
export type {
  TierBias,
  SessionScope,
  SessionStartInput,
  SessionHandle,
  ResumedSessionInfo,
  ProcessInput,
  ProcessOutput,
  RecordOutcomeInput,
  SessionEvent,
  SessionManagerConfig,
} from "./session-manager.js";
export {
  KomatikPreferenceClient,
  DEFAULT_UNDERCURRENT_SETTINGS,
} from "./preference-client.js";
export type {
  KomatikPreferenceClientOptions,
  UndercurrentSettings,
  EnrichmentDepth,
  StrategyChoice,
} from "./preference-client.js";
export {
  runTierRecommendationHarness,
  DEFAULT_HARNESS_MODELS,
  DEFAULT_HARNESS_TIER_MAP,
} from "./tier-recommendation-harness.js";
export type {
  HarnessMessage as TierHarnessMessage,
  HarnessVariant as TierHarnessVariant,
  HarnessOptions as TierHarnessOptions,
  HarnessRunResult as TierHarnessRunResult,
  HarnessComparison as TierHarnessComparison,
  SimulatedModel as TierHarnessSimulatedModel,
  TierToModelMap as TierHarnessTierToModelMap,
  VariantStrategy as TierHarnessVariantStrategy,
} from "./tier-recommendation-harness.js";
export type { KomatikModelUsageAdapterOptions } from "./model-usage-adapter.js";
export { createMockClient, createMockWriteClient } from "./testing.js";
export type { MockWriteLog } from "./testing.js";

export type {
  PilotRequestContext,
  PilotProcessTelemetry,
  PilotOutcome,
  PilotRoiSummary,
  PilotTelemetrySink,
  PilotProcessResult,
  ProcessInvoker,
} from "./pilot.js";

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
