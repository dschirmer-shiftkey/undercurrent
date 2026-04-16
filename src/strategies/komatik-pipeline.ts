import { randomUUID } from "node:crypto";
import type {
  Assumption,
  ContextLayer,
  ConversationTurn,
  EnrichmentStrategy,
  Gap,
  GapResolution,
  IntentSignal,
} from "../types.js";

/**
 * Komatik Pipeline Strategy — the first real "contents" for the container.
 *
 * Maps human descriptions to the shape the Komatik pipeline expects:
 * domain detection, tech stack inference, feature extraction, scope boundaries,
 * and a structured output compatible with RequirementManifest / consultant spec.
 *
 * Designed to work in two modes:
 * 1. **Heuristic** (default) — fast, deterministic, no LLM calls. Good for
 *    pre-enrichment before the consultant takes over.
 * 2. **LLM-assisted** — pass an `llmCall` function to delegate classification
 *    and composition to a language model. Used for standalone scaffolding
 *    where the consultant is bypassed (e.g., Yggdrasil seedlings).
 */

export interface KomatikPipelineOptions {
  llmCall?: (prompt: string, systemPrompt: string) => Promise<string>;
  domainConfigs?: DomainConfig[];
  featureCatalog?: FeatureCatalogEntry[];
  yggdrasil?: boolean;
}

export interface DomainConfig {
  domainId: string;
  displayName: string;
  keywords: string[];
  defaultStack: string[];
  confidenceKeywords: Record<string, number>;
}

export interface FeatureCatalogEntry {
  id: string;
  name: string;
  description: string;
  baseHours: number;
  keywords: string[];
  category: string;
}

export interface KomatikEnrichmentData {
  projectName: string;
  projectType: string;
  detectedDomain: string;
  domainConfidence: number;
  techStack: Array<{ name: string; category: string; inferred: boolean }>;
  features: Array<{ name: string; description: string; source: "explicit" | "inferred" | "standard" }>;
  constraints: {
    platform: string;
    hostingPreference: string | null;
    stylePreference: string | null;
    budgetSignal: "low" | "medium" | "high" | "unknown";
    isYggdrasil: boolean;
  };
  readinessSignals: {
    hasProjectType: boolean;
    hasTechStack: boolean;
    hasFeatures: boolean;
    hasPlatform: boolean;
    hasAudience: boolean;
    estimatedReadiness: number;
  };
}

const DOMAIN_SIGNALS: Record<string, { keywords: RegExp; defaultStack: string[]; projectType: string }> = {
  ecommerce: {
    keywords: /\b(shop|store|cart|checkout|product|catalog|inventory|ecommerce|e-commerce|marketplace|sell|buy|payment)\b/i,
    defaultStack: ["Next.js", "Supabase", "Stripe", "Tailwind CSS"],
    projectType: "Web App",
  },
  saas: {
    keywords: /\b(saas|subscription|dashboard|admin|tenant|multi-tenant|platform|portal|billing)\b/i,
    defaultStack: ["Next.js", "Supabase", "Stripe", "Tailwind CSS"],
    projectType: "Web App",
  },
  education: {
    keywords: /\b(learn|teach|course|student|school|classroom|quiz|lesson|lms|education|curriculum|tutor)\b/i,
    defaultStack: ["Next.js", "Supabase", "Tailwind CSS"],
    projectType: "Web App",
  },
  healthcare: {
    keywords: /\b(health|medical|patient|doctor|clinic|hospital|appointment|telehealth|hipaa|ehr)\b/i,
    defaultStack: ["Next.js", "Supabase", "Tailwind CSS"],
    projectType: "Web App",
  },
  social: {
    keywords: /\b(social|community|feed|post|follow|chat|message|forum|network|profile|friends)\b/i,
    defaultStack: ["Next.js", "Supabase", "Tailwind CSS", "Realtime"],
    projectType: "Web App",
  },
  ai_ml: {
    keywords: /\b(ai|ml|machine learning|model|inference|training|neural|llm|gpt|claude|embedding|vector)\b/i,
    defaultStack: ["Next.js", "Supabase", "Vercel AI SDK", "Python"],
    projectType: "Web App",
  },
  game: {
    keywords: /\b(game|player|score|level|character|multiplayer|gameplay|engine|godot|unity|sprite)\b/i,
    defaultStack: ["Godot", "GDScript", "Supabase"],
    projectType: "Game",
  },
  mobile: {
    keywords: /\b(mobile|ios|android|app store|react native|flutter|expo|phone|tablet)\b/i,
    defaultStack: ["React Native", "Expo", "Supabase"],
    projectType: "Mobile App",
  },
  api: {
    keywords: /\b(api|endpoint|rest|graphql|webhook|microservice|backend|server|lambda)\b/i,
    defaultStack: ["Node.js", "Supabase", "Hono"],
    projectType: "API",
  },
  cli: {
    keywords: /\b(cli|command.line|terminal|script|automation|cron|batch|pipeline)\b/i,
    defaultStack: ["Node.js", "TypeScript"],
    projectType: "CLI Tool",
  },
  content: {
    keywords: /\b(blog|cms|content|article|writer|publishing|editorial|magazine|newsletter)\b/i,
    defaultStack: ["Next.js", "Supabase", "Tailwind CSS", "MDX"],
    projectType: "Web App",
  },
  climate: {
    keywords: /\b(climate|carbon|emission|environment|sustain|green|eco|footprint|sensor|weather|renewable)\b/i,
    defaultStack: ["Next.js", "Supabase", "Chart.js", "Tailwind CSS"],
    projectType: "Web App",
  },
};

const FEATURE_SIGNALS: Array<{ pattern: RegExp; feature: string; description: string }> = [
  { pattern: /\b(auth|login|sign.?up|register|password|oauth|sso)\b/i, feature: "Authentication", description: "User authentication with sign-up, login, and session management" },
  { pattern: /\b(pay|stripe|checkout|billing|subscription|invoice)\b/i, feature: "Payments", description: "Payment processing and billing integration" },
  { pattern: /\b(chat|message|real.?time|websocket|notification|push)\b/i, feature: "Real-time Messaging", description: "Real-time communication or notification system" },
  { pattern: /\b(upload|file|image|media|storage|s3|blob)\b/i, feature: "File Management", description: "File upload, storage, and media management" },
  { pattern: /\b(search|filter|sort|query|full.?text)\b/i, feature: "Search & Filtering", description: "Content search, filtering, and sorting capabilities" },
  { pattern: /\b(dashboard|analytics|chart|graph|metric|report|visual)\b/i, feature: "Dashboard & Analytics", description: "Data visualization and analytics dashboard" },
  { pattern: /\b(email|smtp|sendgrid|notification|alert)\b/i, feature: "Email Notifications", description: "Transactional and notification email system" },
  { pattern: /\b(role|permission|admin|rbac|access.control)\b/i, feature: "Role-Based Access", description: "Role-based access control and permission management" },
  { pattern: /\b(map|location|geo|gps|address|routing)\b/i, feature: "Geolocation", description: "Map integration, location services, or address handling" },
  { pattern: /\b(calendar|schedule|booking|appointment|reservation|event)\b/i, feature: "Scheduling", description: "Calendar, booking, or appointment scheduling system" },
  { pattern: /\b(export|import|csv|pdf|download|report)\b/i, feature: "Data Export", description: "Data export capabilities (CSV, PDF, reports)" },
  { pattern: /\b(api|integration|webhook|third.?party|connect)\b/i, feature: "API Integrations", description: "Third-party API integrations and webhook handling" },
  { pattern: /\b(track|monitor|log|audit|history|activity)\b/i, feature: "Activity Tracking", description: "User activity tracking and audit logging" },
  { pattern: /\b(drag.?and.?drop|kanban|board|workflow|pipeline)\b/i, feature: "Workflow Management", description: "Visual workflow or kanban-style task management" },
];

const PLATFORM_SIGNALS: Record<string, RegExp> = {
  web: /\b(web|website|site|browser|responsive|desktop)\b/i,
  mobile: /\b(mobile|ios|android|phone|tablet|app store)\b/i,
  desktop: /\b(desktop|electron|tauri|native|windows|mac)\b/i,
  cli: /\b(cli|command.line|terminal)\b/i,
};

export class KomatikPipelineStrategy implements EnrichmentStrategy {
  readonly name = "komatik-pipeline";

  private readonly llmCall?: KomatikPipelineOptions["llmCall"];
  private readonly externalDomains: DomainConfig[];
  private readonly externalFeatures: FeatureCatalogEntry[];
  private readonly isYggdrasil: boolean;

  constructor(options?: KomatikPipelineOptions) {
    this.llmCall = options?.llmCall;
    this.externalDomains = options?.domainConfigs ?? [];
    this.externalFeatures = options?.featureCatalog ?? [];
    this.isYggdrasil = options?.yggdrasil ?? false;
  }

  async classifyIntent(
    message: string,
    conversation: ConversationTurn[],
  ): Promise<IntentSignal> {
    const lower = message.toLowerCase();
    const allText = [
      ...conversation.map((t) => t.content),
      message,
    ].join(" ").toLowerCase();

    const domain = this.detectDomain(allText);
    const features = this.detectFeatures(allText);
    const platform = this.detectPlatform(allText);

    const domainHints = [domain.id];
    if (platform) domainHints.push(platform);
    if (features.length > 0) domainHints.push(...features.map((f) => f.feature.toLowerCase()));

    const specificity = this.assessSpecificity(message, features.length, domain.confidence);

    return {
      action: this.detectAction(lower),
      specificity,
      scope: features.length > 5 ? "cross-system" : features.length > 2 ? "product" : "local",
      emotionalLoad: this.detectEmotion(lower),
      confidence: domain.confidence,
      rawFragments: this.extractFragments(message),
      domainHints,
    };
  }

  async analyzeGaps(
    intent: IntentSignal,
    context: ContextLayer[],
    message: string,
  ): Promise<Gap[]> {
    const gaps: Gap[] = [];
    const allText = message.toLowerCase();

    const readiness = this.assessReadiness(allText, intent, context);

    if (!readiness.hasProjectType) {
      gaps.push(this.createGap("Missing project type — what kind of thing is this (web app, mobile, API, CLI)?", true));
    }
    if (!readiness.hasPlatform) {
      gaps.push(this.createGap("Target platform not specified (web, mobile, desktop)", false));
    }
    if (!readiness.hasFeatures && intent.specificity === "low") {
      gaps.push(this.createGap("No specific features mentioned — what should it DO?", true));
    }
    if (!readiness.hasAudience) {
      gaps.push(this.createGap("Target audience/users not described", false));
    }

    if (this.isYggdrasil && !readiness.hasMissionStatement(allText)) {
      gaps.push(this.createGap("Yggdrasil seedling requires a mission statement — what social/educational/humanitarian problem does this solve?", true));
    }

    return gaps;
  }

  async resolveGap(
    gap: Gap,
    context: ContextLayer[],
    confidenceThreshold: number,
  ): Promise<GapResolution> {
    for (const layer of context) {
      if (layer.source === "komatik-knowledge") {
        const data = layer.data as Record<string, unknown>;
        if (data.domainDefaults && gap.description.includes("project type")) {
          const defaults = data.domainDefaults as { projectType: string };
          return {
            type: "filled",
            value: defaults.projectType,
            source: layer.source,
          };
        }
      }
    }

    const domainFromContext = context.find((c) => c.source === "komatik-knowledge");
    const hasContext = context.length > 0;
    const inferredConfidence = hasContext ? 0.5 + context.length * 0.08 : 0.3;

    if (inferredConfidence >= confidenceThreshold || !gap.critical) {
      return {
        type: "assumed",
        assumption: {
          id: randomUUID(),
          claim: this.gapToAssumption(gap, domainFromContext),
          basis: hasContext
            ? `Based on ${context.length} context source(s) including domain knowledge`
            : "Default assumption — no supporting context",
          confidence: inferredConfidence,
          source: this.name,
          correctable: true,
        },
      };
    }

    return {
      type: "needs-clarification",
      clarification: {
        id: randomUUID(),
        question: this.gapToQuestion(gap),
        options: this.gapToOptions(gap),
        allowMultiple: false,
        defaultOptionId: "opt-1",
        reason: gap.description,
      },
    };
  }

  async compose(
    message: string,
    _intent: IntentSignal,
    context: ContextLayer[],
    assumptions: Assumption[],
    _resolvedGaps: Gap[],
  ): Promise<string> {
    const allText = [message, ...context.map((c) => c.summary)].join(" ");
    const domain = this.detectDomain(allText);
    const features = this.detectFeatures(allText);
    const platform = this.detectPlatform(allText) ?? "web";
    const techStack = this.inferTechStack(domain.id, features, platform);

    const enrichment: KomatikEnrichmentData = {
      projectName: this.inferProjectName(message),
      projectType: domain.id !== "unknown" ? DOMAIN_SIGNALS[domain.id]?.projectType ?? "Web App" : "Web App",
      detectedDomain: domain.id,
      domainConfidence: domain.confidence,
      techStack,
      features: features.map((f) => ({
        name: f.feature,
        description: f.description,
        source: "inferred" as const,
      })),
      constraints: {
        platform,
        hostingPreference: this.detectHosting(allText),
        stylePreference: this.detectStyle(allText),
        budgetSignal: this.detectBudgetSignal(allText),
        isYggdrasil: this.isYggdrasil,
      },
      readinessSignals: {
        hasProjectType: domain.id !== "unknown",
        hasTechStack: techStack.length > 0,
        hasFeatures: features.length > 0,
        hasPlatform: true,
        hasAudience: /\b(user|customer|client|student|teacher|admin|team|employee)\b/i.test(allText),
        estimatedReadiness: this.calculateReadiness(domain, features, techStack, assumptions),
      },
    };

    if (this.llmCall) {
      return this.llmCompose(message, enrichment, context, assumptions);
    }

    return this.heuristicCompose(message, enrichment, context, assumptions);
  }

  // ── Domain Detection ───────────────────────────────────────────────────

  private detectDomain(text: string): { id: string; confidence: number } {
    let bestDomain = "unknown";
    let bestScore = 0;

    for (const [domainId, signals] of Object.entries(DOMAIN_SIGNALS)) {
      const matches = text.match(signals.keywords);
      if (matches) {
        const score = matches.length;
        if (score > bestScore) {
          bestScore = score;
          bestDomain = domainId;
        }
      }
    }

    for (const ext of this.externalDomains) {
      const extMatches = ext.keywords.filter((k) => text.includes(k.toLowerCase())).length;
      if (extMatches > bestScore) {
        bestScore = extMatches;
        bestDomain = ext.domainId;
      }
    }

    const confidence = bestScore === 0 ? 0.1 : Math.min(0.3 + bestScore * 0.15, 0.95);
    return { id: bestDomain, confidence };
  }

  private detectFeatures(text: string): Array<{ feature: string; description: string }> {
    const detected: Array<{ feature: string; description: string }> = [];
    const seen = new Set<string>();

    for (const signal of FEATURE_SIGNALS) {
      if (signal.pattern.test(text) && !seen.has(signal.feature)) {
        seen.add(signal.feature);
        detected.push({ feature: signal.feature, description: signal.description });
      }
    }

    for (const entry of this.externalFeatures) {
      if (seen.has(entry.name)) continue;
      const entryMatches = entry.keywords.some((k) => text.includes(k.toLowerCase()));
      if (entryMatches) {
        seen.add(entry.name);
        detected.push({ feature: entry.name, description: entry.description });
      }
    }

    return detected;
  }

  private detectPlatform(text: string): string | null {
    for (const [platform, pattern] of Object.entries(PLATFORM_SIGNALS)) {
      if (pattern.test(text)) return platform;
    }
    return null;
  }

  private detectAction(lower: string): IntentSignal["action"] {
    if (/\b(build|create|make|scaffold|generate|start|launch)\b/.test(lower)) return "build";
    if (/\b(fix|debug|broken|error|issue|wrong)\b/.test(lower)) return "fix";
    if (/\b(idea|think|concept|explore|what if)\b/.test(lower)) return "explore";
    if (/\b(design|architect|plan|structure)\b/.test(lower)) return "design";
    return "build";
  }

  private detectEmotion(lower: string): IntentSignal["emotionalLoad"] {
    if (/[!]{2,}|\bfrustrat|\bhate|\bugh/.test(lower)) return "frustrated";
    if (/\bexcit|\bawesom|\bcool|\blove/.test(lower)) return "excited";
    if (/\bmaybe|\bnot sure|\bi think|\bperhaps/.test(lower)) return "uncertain";
    return "neutral";
  }

  // ── Tech Stack Inference ───────────────────────────────────────────────

  private inferTechStack(
    domainId: string,
    features: Array<{ feature: string }>,
    platform: string,
  ): KomatikEnrichmentData["techStack"] {
    const stack: KomatikEnrichmentData["techStack"] = [];
    const seen = new Set<string>();

    const domainDefaults = DOMAIN_SIGNALS[domainId]?.defaultStack ?? [];
    for (const tech of domainDefaults) {
      if (!seen.has(tech)) {
        seen.add(tech);
        stack.push({ name: tech, category: this.categorizeTech(tech), inferred: true });
      }
    }

    for (const f of features) {
      if (f.feature === "Payments" && !seen.has("Stripe")) {
        seen.add("Stripe");
        stack.push({ name: "Stripe", category: "Payment", inferred: true });
      }
      if (f.feature === "Real-time Messaging" && !seen.has("Supabase Realtime")) {
        seen.add("Supabase Realtime");
        stack.push({ name: "Supabase Realtime", category: "Real-time", inferred: true });
      }
      if (f.feature === "Geolocation" && !seen.has("Mapbox")) {
        seen.add("Mapbox");
        stack.push({ name: "Mapbox", category: "Maps", inferred: true });
      }
    }

    if (platform === "mobile" && !seen.has("React Native")) {
      seen.add("React Native");
      stack.push({ name: "React Native", category: "Frontend", inferred: true });
    }

    return stack;
  }

  private categorizeTech(name: string): string {
    const categories: Record<string, string[]> = {
      Frontend: ["Next.js", "React", "React Native", "Expo", "Vue", "Svelte", "Tailwind CSS"],
      Backend: ["Node.js", "Python", "Hono", "Express"],
      Database: ["Supabase", "PostgreSQL", "MongoDB"],
      Payment: ["Stripe"],
      Hosting: ["Vercel", "Cloudflare"],
      AI: ["Vercel AI SDK", "OpenAI", "Anthropic"],
      Engine: ["Godot", "Unity"],
    };
    for (const [category, techs] of Object.entries(categories)) {
      if (techs.includes(name)) return category;
    }
    return "Other";
  }

  // ── Readiness Assessment ───────────────────────────────────────────────

  private assessSpecificity(
    message: string,
    featureCount: number,
    domainConfidence: number,
  ): IntentSignal["specificity"] {
    let score = 0;
    if (featureCount >= 3) score += 2;
    else if (featureCount >= 1) score += 1;
    if (domainConfidence > 0.6) score += 2;
    if (message.length > 200) score += 1;
    if (/\b(specifically|exactly|must have|require)\b/i.test(message)) score += 1;
    if (message.length < 50) score -= 2;

    if (score >= 4) return "high";
    if (score >= 2) return "medium";
    return "low";
  }

  private assessReadiness(
    text: string,
    intent: IntentSignal,
    _context: ContextLayer[],
  ) {
    return {
      hasProjectType: intent.domainHints.length > 0 && intent.domainHints[0] !== "unknown",
      hasPlatform: Object.values(PLATFORM_SIGNALS).some((p) => p.test(text)),
      hasFeatures: FEATURE_SIGNALS.some((f) => f.pattern.test(text)),
      hasAudience: /\b(user|customer|client|student|teacher|admin|team)\b/i.test(text),
      hasMissionStatement: (t: string) => /\b(help|solve|improve|support|empower|enable|reduce|track)\b/i.test(t) && t.length > 50,
    };
  }

  private calculateReadiness(
    domain: { id: string; confidence: number },
    features: Array<unknown>,
    techStack: Array<unknown>,
    assumptions: Assumption[],
  ): number {
    let score = 0;
    if (domain.id !== "unknown") score += 0.2;
    if (domain.confidence > 0.5) score += 0.1;
    if (features.length > 0) score += Math.min(features.length * 0.08, 0.3);
    if (techStack.length > 0) score += 0.1;
    const highConfAssumptions = assumptions.filter((a) => a.confidence > 0.7).length;
    score += Math.min(highConfAssumptions * 0.05, 0.15);
    return Math.min(score, 1.0);
  }

  // ── Composition ────────────────────────────────────────────────────────

  private heuristicCompose(
    message: string,
    enrichment: KomatikEnrichmentData,
    context: ContextLayer[],
    assumptions: Assumption[],
  ): string {
    const parts: string[] = [];

    parts.push(`[Original]: ${message}`);
    parts.push(`[Project]: ${enrichment.projectName} (${enrichment.projectType})`);
    parts.push(`[Domain]: ${enrichment.detectedDomain} (confidence: ${(enrichment.domainConfidence * 100).toFixed(0)}%)`);
    parts.push(`[Platform]: ${enrichment.constraints.platform}`);

    if (enrichment.constraints.isYggdrasil) {
      parts.push(`[Yggdrasil]: Seedling mission — public repo, CC BY 4.0, 6-agent collective, 1% compute pledge`);
    }

    if (enrichment.techStack.length > 0) {
      parts.push(`[Tech Stack]: ${enrichment.techStack.map((t) => `${t.name} (${t.category})`).join(", ")}`);
    }

    if (enrichment.features.length > 0) {
      parts.push("[Detected Features]:");
      for (const f of enrichment.features) {
        parts.push(`  - ${f.name}: ${f.description} [${f.source}]`);
      }
    }

    if (context.length > 0) {
      parts.push("[Context]:");
      for (const layer of context) {
        parts.push(`  - ${layer.source}: ${layer.summary}`);
      }
    }

    if (assumptions.length > 0) {
      parts.push("[Assumptions]:");
      for (const a of assumptions) {
        parts.push(`  - ${a.claim} (confidence: ${(a.confidence * 100).toFixed(0)}%)`);
      }
    }

    const r = enrichment.readinessSignals;
    parts.push(`[Readiness]: ${(r.estimatedReadiness * 100).toFixed(0)}% — ${r.hasProjectType ? "✓" : "✗"} type, ${r.hasTechStack ? "✓" : "✗"} stack, ${r.hasFeatures ? "✓" : "✗"} features, ${r.hasPlatform ? "✓" : "✗"} platform, ${r.hasAudience ? "✓" : "✗"} audience`);

    return parts.join("\n");
  }

  private async llmCompose(
    message: string,
    enrichment: KomatikEnrichmentData,
    context: ContextLayer[],
    assumptions: Assumption[],
  ): Promise<string> {
    if (!this.llmCall) return this.heuristicCompose(message, enrichment, context, assumptions);

    const systemPrompt = `You are Undercurrent, a translation layer that converts vague project descriptions into structured specifications for the Komatik development pipeline.

Given the user's original message and the enrichment data below, produce a clear, structured project specification that a development team can act on. Include: project name, type, domain, platform, tech stack, features (with descriptions), constraints, and any assumptions you're making.

${this.isYggdrasil ? "This is a Yggdrasil Seedling — a charitable, open-source project. Constraints: public GitHub repo, CC BY 4.0 license, MIT for code, 6-agent collective, 1% compute pledge budget." : ""}

Write in the second person ("Your project...") and keep it actionable. Don't ask questions — make smart assumptions and state them.`;

    const prompt = `Original message: "${message}"

Enrichment data:
${JSON.stringify(enrichment, null, 2)}

Additional context:
${context.map((c) => `- ${c.source}: ${c.summary}`).join("\n")}

Assumptions already made:
${assumptions.map((a) => `- ${a.claim} (${(a.confidence * 100).toFixed(0)}% confidence)`).join("\n")}`;

    return this.llmCall(prompt, systemPrompt);
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private inferProjectName(message: string): string {
    const quoted = message.match(/"([^"]+)"|'([^']+)'/);
    if (quoted) return (quoted[1] ?? quoted[2])!;

    const words = message
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !/^(want|need|build|create|make|that|this|with|from|have|some|like|would|could|should)$/i.test(w));

    return words.slice(0, 3).join("-").toLowerCase() || "untitled-project";
  }

  private detectHosting(text: string): string | null {
    if (/\bvercel\b/i.test(text)) return "Vercel";
    if (/\bnetlify\b/i.test(text)) return "Netlify";
    if (/\baws\b/i.test(text)) return "AWS";
    if (/\bcloudflare\b/i.test(text)) return "Cloudflare";
    if (/\bself.host/i.test(text)) return "Self-hosted";
    return null;
  }

  private detectStyle(text: string): string | null {
    if (/\bminimal(ist)?\b/i.test(text)) return "Minimalist";
    if (/\bmodern\b/i.test(text)) return "Modern";
    if (/\bclean\b/i.test(text)) return "Clean";
    if (/\bbold\b/i.test(text)) return "Bold";
    if (/\bdark\s*mode\b/i.test(text)) return "Dark mode";
    return null;
  }

  private detectBudgetSignal(text: string): KomatikEnrichmentData["constraints"]["budgetSignal"] {
    if (/\b(cheap|free|budget|minimal cost|low cost|bootstrap)\b/i.test(text)) return "low";
    if (/\b(enterprise|unlimited|premium|no budget limit)\b/i.test(text)) return "high";
    if (/\b(reasonable|moderate|mid.range)\b/i.test(text)) return "medium";
    return "unknown";
  }

  private extractFragments(message: string): string[] {
    const fragments: string[] = [];
    const quoted = message.match(/["'][^"']+["']/g);
    if (quoted) fragments.push(...quoted.map((q) => q.slice(1, -1)));
    const backticked = message.match(/`[^`]+`/g);
    if (backticked) fragments.push(...backticked.map((b) => b.slice(1, -1)));
    return fragments;
  }

  private createGap(description: string, critical: boolean): Gap {
    return { id: randomUUID(), description, critical, resolution: null };
  }

  private gapToAssumption(gap: Gap, domainContext: ContextLayer | undefined): string {
    const desc = gap.description.toLowerCase();
    if (desc.includes("project type")) {
      const domain = domainContext?.data as { detectedDomain?: string } | undefined;
      return `Assuming web application based on ${domain?.detectedDomain ?? "general"} domain signals`;
    }
    if (desc.includes("platform")) return "Assuming web platform (most common for new projects)";
    if (desc.includes("audience")) return "Assuming general end-users as target audience";
    if (desc.includes("feature")) return "Features will be inferred from domain defaults and conversation refinement";
    return `Assuming reasonable default for: ${gap.description}`;
  }

  private gapToQuestion(gap: Gap): string {
    const desc = gap.description.toLowerCase();
    if (desc.includes("project type")) return "Web app, mobile app, API, or CLI?";
    if (desc.includes("platform")) return "Web, mobile, or desktop?";
    if (desc.includes("feature")) return "What's the one thing this absolutely must do?";
    if (desc.includes("audience")) return "Who's using this?";
    if (desc.includes("mission")) return "What real-world problem does this solve?";
    return gap.description;
  }

  private gapToOptions(gap: Gap) {
    const desc = gap.description.toLowerCase();
    if (desc.includes("project type")) {
      return [
        { id: "opt-1", label: "Web App", isDefault: true },
        { id: "opt-2", label: "Mobile App", isDefault: false },
        { id: "opt-3", label: "API / Backend", isDefault: false },
      ];
    }
    if (desc.includes("platform")) {
      return [
        { id: "opt-1", label: "Web", isDefault: true },
        { id: "opt-2", label: "Mobile", isDefault: false },
        { id: "opt-3", label: "Both", isDefault: false },
      ];
    }
    return [
      { id: "opt-1", label: "Use reasonable defaults", isDefault: true },
      { id: "opt-2", label: "Let me specify", isDefault: false },
    ];
  }
}
