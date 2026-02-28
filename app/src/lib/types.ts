export type LlmProvider = "zhipu" | "minimax" | "doubao";

export type ReviewRequest = {
  targetRole: string;
  company?: string;
  round?: string;
  rawNotes: string;
};

export type QuestionReview = {
  question: string;
  performance: "好" | "一般" | "差";
  issue: string;
  betterAnswer: string;
};

export type InterviewReview = {
  summary: string;
  questions: QuestionReview[];
  nextActions: string[];
};

export type ReviewResult = {
  review: InterviewReview;
  modelRawOutput: string;
  provider: LlmProvider;
  model: string;
};

export type LibrarySource = "self" | "community" | "other";

export type VerificationStatus =
  | "unverified"
  | "supported"
  | "weak"
  | "conflict"
  | "unreachable";

export type LibraryEntry = {
  id: string;
  createdAt: string;
  source: LibrarySource;
  targetRole: string;
  company?: string;
  round?: string;
  question: string;
  pitfall: string;
  betterAnswer: string;
  tags: string[];
  sourceUrl?: string;
  evidenceNote?: string;
  verificationStatus?: VerificationStatus;
  confidence?: number;
};

export type LibraryEntryInput = {
  source: LibrarySource;
  targetRole: string;
  company?: string;
  round?: string;
  question: string;
  pitfall: string;
  betterAnswer: string;
  tags?: string[];
  sourceUrl?: string;
  evidenceNote?: string;
  verificationStatus?: VerificationStatus;
  confidence?: number;
};

export type PrepRequest = {
  targetRole: string;
  company?: string;
  focus?: string;
  topK?: number;
  qualityGateEnabled?: boolean;
  qualityGateThreshold?: number;
};

export type PrepQuestion = {
  question: string;
  whyLikely: string;
  howToAnswer: string;
};

export type PrepSourceRef = {
  entryId: string;
  rank: number;
  label: string;
  sourceUrl?: string;
  source: LibrarySource;
  company?: string;
  round?: string;
  verificationStatus?: VerificationStatus;
  confidence?: number;
};

export type PrepTraceability = {
  summaryRefs: PrepSourceRef[];
  questionRefs: PrepSourceRef[][];
  redFlagRefs: PrepSourceRef[][];
  actionRefs: PrepSourceRef[][];
};

export type PrepQuality = {
  matchedCount: number;
  supportedCount: number;
  weakCount: number;
  conflictCount: number;
  unverifiedCount: number;
  unreachableCount: number;
  avgConfidence: number;
  evidenceScore: number;
  qualityLevel: "高" | "中" | "低";
  sourceDiversity: {
    self: number;
    community: number;
    other: number;
  };
  gateEnabled: boolean;
  gateThreshold: number;
  gatePassed: boolean;
  gateReason?: string;
  riskTips: string[];
};

export type PrepPlan = {
  strategySummary: string;
  likelyQuestions: PrepQuestion[];
  redFlags: string[];
  actionChecklist: string[];
  matchedEntries: LibraryEntry[];
  quality: PrepQuality;
  traceability?: PrepTraceability;
};

export type ResearchProvider = "gemini" | "gpt" | "doubao" | "zhipu" | "other";

export type ResearchImportRequest = {
  provider: ResearchProvider;
  targetRole: string;
  company?: string;
  round?: string;
  reportText: string;
  sourceUrls: string[];
  verifySources?: boolean;
};

export type SourceCheck = {
  url: string;
  ok: boolean;
  statusCode?: number;
  title?: string;
  excerpt?: string;
  error?: string;
};

export type ResearchImportStats = {
  supported: number;
  weak: number;
  conflict: number;
  unverified: number;
  unreachable: number;
};

export type DedupGroupSample = {
  representativeQuestion: string;
  size: number;
  targetRole: string;
  company?: string;
};

export type DedupSummary = {
  beforeCount: number;
  afterCount: number;
  mergedCount: number;
  duplicateGroups: number;
  dryRun: boolean;
  samples: DedupGroupSample[];
};

export type DeepResearchChannel =
  | "job"
  | "interview"
  | "community"
  | "knowledge"
  | "salary";

export type DeepResearchSourceQualityGrade = "A" | "B" | "C";

export type DeepResearchSourceQuality = {
  score: number;
  grade: DeepResearchSourceQualityGrade;
  reasons: string[];
};

export type DeepResearchSource = {
  title: string;
  url: string;
  domain: string;
  snippet: string;
  channel: DeepResearchChannel;
  query: string;
  quality: DeepResearchSourceQuality;
};

export type DeepResearchSearchEngine =
  | "duck-duck-scrape"
  | "duckduckgo-html"
  | "bing-html";

export type DeepResearchEvidenceCluster = {
  id: string;
  claim: string;
  supportDomainCount: number;
  supportDomains: string[];
  supportSourceCount: number;
  channels: DeepResearchChannel[];
  sourceIndexes: number[];
  accepted: boolean;
};

export type DeepResearchRequest = {
  targetRole: string;
  company?: string;
  focus?: string;
  maxSourcesPerChannel?: number;
  enableReflection?: boolean;
  reflectionQueriesPerChannel?: number;
  enableCrossValidation?: boolean;
  crossValidationProvider?: LlmProvider;
  crossValidationModel?: string;
};

export type DeepResearchSkill = {
  skill: string;
  reason: string;
  priority: "高" | "中" | "低";
};

export type DeepResearchQuestionTheme = {
  theme: string;
  whyImportant: string;
  sampleQuestions: string[];
};

export type DeepResearchProfile = {
  roleSummary: string;
  coreResponsibilities: string[];
  coreSkills: DeepResearchSkill[];
  interviewQuestionThemes: DeepResearchQuestionTheme[];
  marketSignals: string[];
  risks: string[];
  actionPlan: string[];
};

export type DeepResearchResult = {
  generatedAt: string;
  searchTelemetry: {
    totalQueries: number;
    primarySuccess: number;
    fallbackSuccess: number;
    failedQueries: number;
    engineUsage: Array<{
      engine: DeepResearchSearchEngine;
      count: number;
    }>;
  };
  queryPlan: Array<{ channel: DeepResearchChannel; queries: string[] }>;
  channelStats: Array<{
    channel: DeepResearchChannel;
    sourceCount: number;
    firstPassSourceCount: number;
    secondPassSourceCount: number;
  }>;
  sources: DeepResearchSource[];
  qualityStats: {
    avgScore: number;
    highQualityCount: number;
    mediumQualityCount: number;
    lowQualityCount: number;
    channelAvgScores: Array<{
      channel: DeepResearchChannel;
      avgScore: number;
      sourceCount: number;
    }>;
  };
  evidenceClusters: {
    minSupportDomains: number;
    total: number;
    accepted: number;
    clusters: DeepResearchEvidenceCluster[];
  };
  readiness: {
    gatePassed: boolean;
    score: number;
    level: "高" | "中" | "低";
    blockers: string[];
    suggestions: string[];
    metrics: {
      uniqueDomainCount: number;
      coveredChannels: number;
      avgSourceScore: number;
      aGradeSourceCount: number;
      acceptedClusterCount: number;
      crossModelAlignment?: number;
    };
  };
  profile: DeepResearchProfile;
  crossValidation: {
    enabled: boolean;
    used: boolean;
    reviewerProvider?: LlmProvider;
    reviewerModel?: string;
    alignmentScore: number;
    agreements: string[];
    conflicts: string[];
    finalSuggestion: string;
  };
  reflection: {
    enabled: boolean;
    secondPassUsed: boolean;
    weakChannels: DeepResearchChannel[];
    gapHypotheses: string[];
    secondPassQueries: Array<{
      channel: DeepResearchChannel;
      query: string;
      reason: string;
    }>;
    firstPassSourceCount: number;
    secondPassSourceCount: number;
  };
};

export type DeepResearchJobStatus =
  | "queued"
  | "running"
  | "retrying"
  | "completed"
  | "failed"
  | "cancelled";

export type DeepResearchJobEvent = {
  at: string;
  type: string;
  message: string;
};

export type DeepResearchJob = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: DeepResearchJobStatus;
  attempts: number;
  maxAttempts: number;
  nextRunAt?: string;
  lastError?: string;
  payload: DeepResearchRequest;
  events: DeepResearchJobEvent[];
  result?: DeepResearchResult;
};

export type ProjectHealthLevel = "healthy" | "watch" | "risk";

export type ProjectHealthPerspective = {
  level: ProjectHealthLevel;
  summary: string;
  recommendations: string[];
};

export type ProjectHealthSnapshot = {
  generatedAt: string;
  windowDays: number;
  overview: {
    libraryEntryCount: number;
    roleCount: number;
    companyCount: number;
    deepResearchJobCount: number;
    prepPassRate7d: number;
    deepResearchPassRate7d: number;
    runtimeErrorRate7d: number;
    queueGatePassRate: number;
    avgReadinessScore: number;
  };
  perspectives: {
    user: ProjectHealthPerspective;
    developer: ProjectHealthPerspective;
    engineer: ProjectHealthPerspective;
    productManager: ProjectHealthPerspective;
  };
  breakdown: {
    verification: {
      supported: number;
      weak: number;
      conflict: number;
      unverified: number;
      unreachable: number;
    };
    jobsByStatus: Record<DeepResearchJobStatus, number>;
  };
  alerts: string[];
};
