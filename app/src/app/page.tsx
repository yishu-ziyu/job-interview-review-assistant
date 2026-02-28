"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  cleanCapturedReportText,
  getCaptureBookmarklet,
  inferCaptureContextSuggestions,
  isLikelyConversationOrAppUrl,
  mergeSourceUrlLines,
  parseBrowserCapture,
  type CompanyAliasEntry,
} from "@/lib/browser-capture";
import type {
  DeepResearchJob,
  DeepResearchResult,
  DeepResearchSourceQualityGrade,
  DedupSummary,
  InterviewReview,
  LlmProvider,
  LibraryEntry,
  LibrarySource,
  ProjectHealthLevel,
  ProjectHealthSnapshot,
  PrepSourceRef,
  PrepPlan,
  ResearchImportStats,
  ResearchProvider,
  SourceCheck,
  VerificationStatus,
} from "@/lib/types";

type Mode = "review" | "prep";

type ReviewFormState = {
  targetRole: string;
  company: string;
  round: string;
  notes: string;
};

type LibraryFormState = {
  source: LibrarySource;
  targetRole: string;
  company: string;
  round: string;
  question: string;
  pitfall: string;
  betterAnswer: string;
  tags: string;
};

type PrepFormState = {
  targetRole: string;
  company: string;
  focus: string;
  qualityGateEnabled: boolean;
  qualityGateThreshold: number;
};

type DeepResearchFormState = {
  targetRole: string;
  company: string;
  focus: string;
  maxSourcesPerChannel: number;
  enableReflection: boolean;
  reflectionQueriesPerChannel: number;
  enableCrossValidation: boolean;
  crossValidationProvider: "auto" | LlmProvider;
  crossValidationModel: string;
};

type ResearchImportFormState = {
  provider: ResearchProvider;
  targetRole: string;
  company: string;
  round: string;
  sourceUrls: string;
  reportText: string;
  verifySources: boolean;
};

type ResearchImportResponse = {
  createdCount: number;
  entries: LibraryEntry[];
  sourceChecks: SourceCheck[];
  stats: ResearchImportStats;
};

type AutoCaptureImportResponse = {
  createdCount: number;
  entries: LibraryEntry[];
  sourceChecks: SourceCheck[];
  stats: ResearchImportStats;
  capture: {
    pageTitle: string;
    pageUrl: string;
    capturedAt: string;
    providerHint: ResearchProvider;
    sourceUrls: string[];
    rawText: string;
    cleanedText: string;
    rawCharCount: number;
    cleanedCharCount: number;
    removedLineCount: number;
    citationReady: boolean;
    suggestions: {
      targetRoles: string[];
      companies: string[];
      confidence: "high" | "medium" | "low";
    };
  };
};

type DeepResearchJobResponse = {
  job: DeepResearchJob;
};

type ImageImportFormState = {
  provider: ResearchProvider;
  targetRole: string;
  company: string;
  round: string;
  sourceUrls: string;
  verifySources: boolean;
  imageFile: File | null;
};

type ImageImportResponse = {
  createdCount: number;
  textLength: number;
  ocrPreview: string;
  sourceChecks: SourceCheck[];
  stats: ResearchImportStats;
};

type PmDemoMeta = {
  version: string;
  targetRole: string;
  companyCount: number;
  entryCount: number;
  companies: string[];
  companyDistribution: Record<string, number>;
  roundDistribution: Record<string, number>;
  quality: {
    standardizedRate: number;
    avgCapabilityTagsPerEntry: number;
    capabilityCoverageRate: number;
    missingCapabilities: string[];
    difficultyDistribution: Record<string, number>;
    capabilityDistribution: Record<string, number>;
  };
};

type CaptureMetaState = {
  pageTitle: string;
  pageUrl: string;
  capturedAt: string;
  rawCharCount: number;
  cleanedCharCount: number;
  removedLineCount: number;
  sourceUrlCount: number;
  providerHint: ResearchProvider;
  citationReady: boolean;
};

type CaptureSuggestionState = {
  targetRoleSuggestions: string[];
  companySuggestions: string[];
  confidence: "high" | "medium" | "low";
};

const defaultReviewForm: ReviewFormState = {
  targetRole: "AI 产品经理",
  company: "",
  round: "一面",
  notes: "",
};

const defaultLibraryForm: LibraryFormState = {
  source: "community",
  targetRole: "AI 产品经理",
  company: "",
  round: "一面",
  question: "",
  pitfall: "",
  betterAnswer: "",
  tags: "",
};

const defaultPrepForm: PrepFormState = {
  targetRole: "AI 产品经理",
  company: "",
  focus: "",
  qualityGateEnabled: true,
  qualityGateThreshold: 60,
};

const defaultDeepResearchForm: DeepResearchFormState = {
  targetRole: "AI 产品经理",
  company: "",
  focus: "",
  maxSourcesPerChannel: 8,
  enableReflection: true,
  reflectionQueriesPerChannel: 1,
  enableCrossValidation: false,
  crossValidationProvider: "auto",
  crossValidationModel: "",
};

const defaultResearchImportForm: ResearchImportFormState = {
  provider: "gemini",
  targetRole: "AI 产品经理",
  company: "",
  round: "一面",
  sourceUrls: "",
  reportText: "",
  verifySources: true,
};

const defaultImageImportForm: Omit<ImageImportFormState, "imageFile"> = {
  provider: "other",
  targetRole: "AI 产品经理",
  company: "",
  round: "一面",
  sourceUrls: "",
  verifySources: true,
};

function qualityColor(value: "好" | "一般" | "差"): string {
  if (value === "好") return "text-ok";
  if (value === "一般") return "text-warn";
  return "text-risk";
}

function sourceLabel(source: LibrarySource): string {
  if (source === "self") return "本人经历";
  if (source === "community") return "他人面经";
  return "其他来源";
}

function verificationLabel(status: VerificationStatus | undefined): string {
  if (status === "supported") return "证据支持";
  if (status === "weak") return "证据偏弱";
  if (status === "conflict") return "存在冲突";
  if (status === "unreachable") return "来源不可达";
  return "待复核";
}

function verificationColor(status: VerificationStatus | undefined): string {
  if (status === "supported") return "text-ok";
  if (status === "weak") return "text-warn";
  if (status === "conflict") return "text-risk";
  if (status === "unreachable") return "text-risk";
  return "text-muted";
}

function suggestionConfidenceLabel(value: "high" | "medium" | "low"): string {
  if (value === "high") return "高";
  if (value === "medium") return "中";
  return "低";
}

function sourceQualityBadgeClass(grade: DeepResearchSourceQualityGrade): string {
  if (grade === "A") return "border-ok/30 bg-ok/10 text-ok";
  if (grade === "B") return "border-warn/30 bg-warn/10 text-warn";
  return "border-risk/30 bg-risk/10 text-risk";
}

function perspectiveLevelLabel(level: ProjectHealthLevel): string {
  if (level === "healthy") return "健康";
  if (level === "watch") return "观察";
  return "风险";
}

function perspectiveLevelClass(level: ProjectHealthLevel): string {
  if (level === "healthy") return "text-ok";
  if (level === "watch") return "text-warn";
  return "text-risk";
}

function parseAliasInput(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/\n|,|，|;|；/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ).slice(0, 20);
}

function formatAliases(aliases: string[]): string {
  return aliases.join(", ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function renderPrepSourceRefs(refs: PrepSourceRef[] | undefined) {
  if (!refs || refs.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {refs.map((ref) => {
        const external = Boolean(ref.sourceUrl?.trim());
        const href = external ? ref.sourceUrl!.trim() : `#entry-${ref.entryId}`;
        const confidenceText =
          typeof ref.confidence === "number"
            ? ` · ${Math.round(ref.confidence * 100)}%`
            : "";
        return (
          <a
            key={`${ref.entryId}-${ref.rank}-${ref.label}`}
            href={href}
            target={external ? "_blank" : undefined}
            rel={external ? "noreferrer" : undefined}
            className="inline-flex items-center rounded-md border border-border bg-background px-2 py-0.5 text-xs text-muted hover:bg-white hover:text-foreground"
            title={`${sourceLabel(ref.source)} / ${verificationLabel(ref.verificationStatus)}${confidenceText}`}
          >
            {ref.label}
          </a>
        );
      })}
    </div>
  );
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("review");

  const [reviewForm, setReviewForm] = useState<ReviewFormState>(defaultReviewForm);
  const [review, setReview] = useState<InterviewReview | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);

  const [libraryForm, setLibraryForm] = useState<LibraryFormState>(defaultLibraryForm);
  const [entryLoading, setEntryLoading] = useState(false);
  const [entryMessage, setEntryMessage] = useState<string | null>(null);
  const [entryError, setEntryError] = useState<string | null>(null);

  const [prepForm, setPrepForm] = useState<PrepFormState>(defaultPrepForm);
  const [prepPlan, setPrepPlan] = useState<PrepPlan | null>(null);
  const [prepWarning, setPrepWarning] = useState<string | null>(null);
  const [prepLoading, setPrepLoading] = useState(false);
  const [prepError, setPrepError] = useState<string | null>(null);
  const [deepResearchForm, setDeepResearchForm] = useState<DeepResearchFormState>(
    defaultDeepResearchForm,
  );
  const [deepResearchResult, setDeepResearchResult] = useState<DeepResearchResult | null>(
    null,
  );
  const [deepResearchLoading, setDeepResearchLoading] = useState(false);
  const [deepResearchError, setDeepResearchError] = useState<string | null>(null);
  const [deepResearchUseQueue, setDeepResearchUseQueue] = useState(true);
  const [deepResearchJob, setDeepResearchJob] = useState<DeepResearchJob | null>(null);

  const [researchForm, setResearchForm] = useState<ResearchImportFormState>(
    defaultResearchImportForm,
  );
  const [researchLoading, setResearchLoading] = useState(false);
  const [researchError, setResearchError] = useState<string | null>(null);
  const [researchMessage, setResearchMessage] = useState<string | null>(null);
  const [researchChecks, setResearchChecks] = useState<SourceCheck[]>([]);
  const [researchStats, setResearchStats] = useState<ResearchImportStats | null>(null);
  const [autoCaptureUrl, setAutoCaptureUrl] = useState("");
  const [autoCaptureWaitMs, setAutoCaptureWaitMs] = useState(3500);
  const [autoCaptureLoading, setAutoCaptureLoading] = useState(false);
  const [autoCaptureError, setAutoCaptureError] = useState<string | null>(null);
  const [autoCaptureMessage, setAutoCaptureMessage] = useState<string | null>(null);
  const [captureLoading, setCaptureLoading] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captureMessage, setCaptureMessage] = useState<string | null>(null);
  const [captureMeta, setCaptureMeta] = useState<CaptureMetaState | null>(null);
  const [captureSuggestion, setCaptureSuggestion] = useState<CaptureSuggestionState | null>(null);
  const [captureRawText, setCaptureRawText] = useState<string>("");
  const [captureCleanText, setCaptureCleanText] = useState<string>("");
  const [bookmarkletCopied, setBookmarkletCopied] = useState(false);

  const [dedupLoading, setDedupLoading] = useState(false);
  const [dedupError, setDedupError] = useState<string | null>(null);
  const [dedupMessage, setDedupMessage] = useState<string | null>(null);
  const [dedupSummary, setDedupSummary] = useState<DedupSummary | null>(null);
  const [seedPmLoading, setSeedPmLoading] = useState(false);
  const [seedPmError, setSeedPmError] = useState<string | null>(null);
  const [seedPmMessage, setSeedPmMessage] = useState<string | null>(null);
  const [seedPmMeta, setSeedPmMeta] = useState<PmDemoMeta | null>(null);
  const [projectHealth, setProjectHealth] = useState<ProjectHealthSnapshot | null>(null);
  const [projectHealthLoading, setProjectHealthLoading] = useState(false);
  const [projectHealthError, setProjectHealthError] = useState<string | null>(null);

  const [imageForm, setImageForm] = useState<ImageImportFormState>({
    ...defaultImageImportForm,
    imageFile: null,
  });
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageMessage, setImageMessage] = useState<string | null>(null);
  const [imageStats, setImageStats] = useState<ResearchImportStats | null>(null);
  const [imageChecks, setImageChecks] = useState<SourceCheck[]>([]);
  const [imagePreview, setImagePreview] = useState<string>("");

  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [companyAliasEntries, setCompanyAliasEntries] = useState<CompanyAliasEntry[]>([]);
  const [aliasDraftCompany, setAliasDraftCompany] = useState("");
  const [aliasDraftAliases, setAliasDraftAliases] = useState("");
  const [aliasLoading, setAliasLoading] = useState(false);
  const [aliasSaving, setAliasSaving] = useState(false);
  const [aliasError, setAliasError] = useState<string | null>(null);
  const [aliasMessage, setAliasMessage] = useState<string | null>(null);

  const notesCount = useMemo(
    () => reviewForm.notes.trim().length,
    [reviewForm.notes],
  );
  const researchCount = useMemo(
    () => researchForm.reportText.trim().length,
    [researchForm.reportText],
  );
  const captureBookmarklet = useMemo(() => getCaptureBookmarklet(), []);

  async function refreshEntries(): Promise<void> {
    setEntriesLoading(true);
    try {
      const response = await fetch("/api/library/entries?limit=30");
      const payload = (await response.json()) as
        | { entries: LibraryEntry[] }
        | { error: string };
      if (response.ok && "entries" in payload) {
        setEntries(payload.entries);
      }
    } finally {
      setEntriesLoading(false);
    }
  }

  async function loadCompanyAliasDictionary(): Promise<void> {
    setAliasLoading(true);
    setAliasError(null);
    try {
      const response = await fetch("/api/config/company-aliases", {
        method: "GET",
        cache: "no-store",
      });
      const payload = (await response.json()) as
        | { entries: CompanyAliasEntry[] }
        | { error: string };
      if (!response.ok || "error" in payload) {
        setAliasError("error" in payload ? payload.error : "读取词典失败");
        return;
      }
      setCompanyAliasEntries(payload.entries);
    } catch {
      setAliasError("网络异常，读取词典失败。");
    } finally {
      setAliasLoading(false);
    }
  }

  async function loadPmDemoMeta(): Promise<void> {
    try {
      const response = await fetch("/api/library/seed-pm-demo", {
        method: "GET",
        cache: "no-store",
      });
      const payload = (await response.json()) as
        | PmDemoMeta
        | { error: string };
      if (!response.ok || "error" in payload) return;
      setSeedPmMeta(payload);
    } catch {
      // ignore metadata load error for non-blocking UX
    }
  }

  async function loadProjectHealth(): Promise<void> {
    setProjectHealthLoading(true);
    setProjectHealthError(null);
    try {
      const response = await fetch("/api/project/health", {
        method: "GET",
        cache: "no-store",
      });
      const payload = (await response.json()) as
        | ProjectHealthSnapshot
        | { error: string };
      if (!response.ok || "error" in payload) {
        setProjectHealthError("error" in payload ? payload.error : "读取项目健康数据失败");
        return;
      }
      setProjectHealth(payload);
    } catch {
      setProjectHealthError("网络异常，读取项目健康数据失败。");
    } finally {
      setProjectHealthLoading(false);
    }
  }

  useEffect(() => {
    void refreshEntries();
    void loadCompanyAliasDictionary();
    void loadPmDemoMeta();
    void loadProjectHealth();
  }, []);

  async function onSubmitReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setReviewLoading(true);
    setReviewError(null);
    setReview(null);
    setImportMessage(null);

    try {
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetRole: reviewForm.targetRole.trim(),
          company: reviewForm.company.trim(),
          round: reviewForm.round.trim(),
          rawNotes: reviewForm.notes.trim(),
        }),
      });

      const payload = (await response.json()) as
        | { review: InterviewReview }
        | { error: string };

      if (!response.ok || "error" in payload) {
        setReviewError("error" in payload ? payload.error : "请求失败");
        return;
      }

      setReview(payload.review);
    } catch {
      setReviewError("网络请求失败，请稍后重试。");
    } finally {
      setReviewLoading(false);
    }
  }

  async function onImportReviewToLibrary() {
    if (!review) return;
    setImportLoading(true);
    setImportMessage(null);
    try {
      const response = await fetch("/api/library/import-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetRole: reviewForm.targetRole,
          company: reviewForm.company,
          round: reviewForm.round,
          review,
        }),
      });
      const payload = (await response.json()) as
        | { createdCount: number }
        | { error: string };
      if (!response.ok || "error" in payload) {
        setImportMessage("error" in payload ? payload.error : "导入失败");
        return;
      }
      setImportMessage(`已导入 ${payload.createdCount} 条经验到经验库。`);
      await refreshEntries();
    } catch {
      setImportMessage("网络异常，导入失败。");
    } finally {
      setImportLoading(false);
    }
  }

  async function onSubmitLibraryEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEntryLoading(true);
    setEntryError(null);
    setEntryMessage(null);
    try {
      const response = await fetch("/api/library/entries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: libraryForm.source,
          targetRole: libraryForm.targetRole,
          company: libraryForm.company,
          round: libraryForm.round,
          question: libraryForm.question,
          pitfall: libraryForm.pitfall,
          betterAnswer: libraryForm.betterAnswer,
          tags: libraryForm.tags,
        }),
      });

      const payload = (await response.json()) as
        | { entry: LibraryEntry }
        | { error: string };
      if (!response.ok || "error" in payload) {
        setEntryError("error" in payload ? payload.error : "入库失败");
        return;
      }

      setEntryMessage("经验已入库。");
      setLibraryForm((prev) => ({
        ...prev,
        question: "",
        pitfall: "",
        betterAnswer: "",
        tags: "",
      }));
      await refreshEntries();
    } catch {
      setEntryError("网络异常，入库失败。");
    } finally {
      setEntryLoading(false);
    }
  }

  async function onGeneratePrep(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPrepLoading(true);
    setPrepError(null);
    setPrepWarning(null);
    setPrepPlan(null);
    try {
      const response = await fetch("/api/library/prep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetRole: prepForm.targetRole.trim(),
          company: prepForm.company.trim(),
          focus: prepForm.focus.trim(),
          topK: 8,
          qualityGateEnabled: prepForm.qualityGateEnabled,
          qualityGateThreshold: prepForm.qualityGateThreshold,
        }),
      });
      const payload = (await response.json()) as
        | { plan: PrepPlan; warning?: string }
        | { error: string };
      if (!response.ok || "error" in payload) {
        setPrepError("error" in payload ? payload.error : "生成失败");
        return;
      }
      setPrepPlan(payload.plan);
      if (payload.warning) setPrepWarning(payload.warning);
    } catch {
      setPrepError("网络异常，策略生成失败。");
    } finally {
      setPrepLoading(false);
    }
  }

  async function onLoadPmDemoLibrary(resetDemo: boolean) {
    setSeedPmLoading(true);
    setSeedPmError(null);
    setSeedPmMessage(null);
    try {
      const response = await fetch("/api/library/seed-pm-demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resetDemo }),
      });
      const payload = (await response.json()) as
        | {
            version: string;
            plannedCount: number;
            createdCount: number;
            skippedCount: number;
            totalEntries: number;
            demoEntriesInLibrary: number;
            companyDistribution?: Record<string, number>;
            roundDistribution?: Record<string, number>;
            quality?: PmDemoMeta["quality"];
          }
        | { error: string };
      if (!response.ok || "error" in payload) {
        setSeedPmError("error" in payload ? payload.error : "导入内置库失败");
        return;
      }
      setSeedPmMessage(
        `内置库导入完成：新增 ${payload.createdCount} 条，跳过 ${payload.skippedCount} 条，当前库共 ${payload.totalEntries} 条（PM内置 ${payload.demoEntriesInLibrary} 条）。`,
      );
      setSeedPmMeta((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          companyDistribution: payload.companyDistribution ?? prev.companyDistribution,
          roundDistribution: payload.roundDistribution ?? prev.roundDistribution,
          quality: payload.quality ?? prev.quality,
        };
      });
      await refreshEntries();
      await loadPmDemoMeta();
    } catch {
      setSeedPmError("网络异常，导入内置库失败。");
    } finally {
      setSeedPmLoading(false);
    }
  }

  async function pollDeepResearchJob(jobId: string): Promise<void> {
    for (let i = 0; i < 120; i += 1) {
      const response = await fetch(`/api/deep-research/jobs/${jobId}`);
      const payload = (await response.json()) as
        | DeepResearchJobResponse
        | { error: string };
      if (!response.ok || "error" in payload) {
        setDeepResearchError("error" in payload ? payload.error : "任务状态查询失败");
        return;
      }
      const job = payload.job;
      setDeepResearchJob(job);

      if (job.status === "completed") {
        if (job.result) {
          setDeepResearchResult(job.result);
        } else {
          setDeepResearchError("任务已完成，但结果为空。");
        }
        return;
      }
      if (job.status === "failed") {
        setDeepResearchError(job.lastError ?? "任务失败，请重试。");
        return;
      }
      if (job.status === "cancelled") {
        setDeepResearchError("任务已取消。");
        return;
      }
      await sleep(2000);
    }
    setDeepResearchError("任务执行超时，请稍后查看任务状态。");
  }

  async function onRunDeepResearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDeepResearchLoading(true);
    setDeepResearchError(null);
    setDeepResearchResult(null);
    setDeepResearchJob(null);

    const body = {
      targetRole: deepResearchForm.targetRole.trim(),
      company: deepResearchForm.company.trim(),
      focus: deepResearchForm.focus.trim(),
      maxSourcesPerChannel: deepResearchForm.maxSourcesPerChannel,
      enableReflection: deepResearchForm.enableReflection,
      reflectionQueriesPerChannel: deepResearchForm.reflectionQueriesPerChannel,
      enableCrossValidation: deepResearchForm.enableCrossValidation,
      crossValidationProvider:
        deepResearchForm.crossValidationProvider === "auto"
          ? undefined
          : deepResearchForm.crossValidationProvider,
      crossValidationModel: deepResearchForm.crossValidationModel.trim(),
    };

    try {
      if (deepResearchUseQueue) {
        const createResponse = await fetch("/api/deep-research/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...body,
            maxAttempts: 3,
          }),
        });
        const createPayload = (await createResponse.json()) as
          | DeepResearchJobResponse
          | { error: string };
        if (!createResponse.ok || "error" in createPayload) {
          setDeepResearchError(
            "error" in createPayload ? createPayload.error : "异步任务创建失败",
          );
          return;
        }
        setDeepResearchJob(createPayload.job);
        await pollDeepResearchJob(createPayload.job.id);
      } else {
        const response = await fetch("/api/deep-research/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = (await response.json()) as DeepResearchResult | { error: string };
        if (!response.ok || "error" in payload) {
          setDeepResearchError("error" in payload ? payload.error : "Deep Research 失败");
          return;
        }
        setDeepResearchResult(payload);
      }
    } catch {
      setDeepResearchError("网络异常，Deep Research 失败。");
    } finally {
      setDeepResearchLoading(false);
    }
  }

  async function onCancelDeepResearchJob() {
    if (!deepResearchJob?.id) return;
    try {
      const response = await fetch(`/api/deep-research/jobs/${deepResearchJob.id}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as
        | DeepResearchJobResponse
        | { error: string };
      if (!response.ok || "error" in payload) {
        setDeepResearchError("error" in payload ? payload.error : "取消任务失败");
        return;
      }
      setDeepResearchJob(payload.job);
      setDeepResearchError("任务已取消。");
    } catch {
      setDeepResearchError("网络异常，取消任务失败。");
    }
  }

  async function onImportResearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResearchLoading(true);
    setResearchError(null);
    setResearchMessage(null);
    setResearchChecks([]);
    setResearchStats(null);
    try {
      const response = await fetch("/api/library/import-research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: researchForm.provider,
          targetRole: researchForm.targetRole.trim(),
          company: researchForm.company.trim(),
          round: researchForm.round.trim(),
          sourceUrls: researchForm.sourceUrls,
          reportText: researchForm.reportText.trim(),
          verifySources: researchForm.verifySources,
        }),
      });
      const payload = (await response.json()) as
        | ResearchImportResponse
        | { error: string };
      if (!response.ok || "error" in payload) {
        setResearchError("error" in payload ? payload.error : "研究导入失败");
        return;
      }
      setResearchMessage(`导入完成，新增 ${payload.createdCount} 条经验。`);
      setResearchChecks(payload.sourceChecks);
      setResearchStats(payload.stats);
      await refreshEntries();
    } catch {
      setResearchError("网络异常，研究导入失败。");
    } finally {
      setResearchLoading(false);
    }
  }

  async function onAutoCaptureAndImport() {
    const pageUrl = autoCaptureUrl.trim();
    if (!pageUrl) {
      setAutoCaptureError("请先输入研究结果页 URL。");
      return;
    }

    setAutoCaptureLoading(true);
    setAutoCaptureError(null);
    setAutoCaptureMessage(null);
    setCaptureError(null);
    setCaptureMessage(null);
    setResearchError(null);
    setResearchMessage(null);
    setResearchChecks([]);
    setResearchStats(null);

    try {
      const response = await fetch("/api/library/auto-capture-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pageUrl,
          provider: researchForm.provider,
          targetRole: researchForm.targetRole.trim(),
          company: researchForm.company.trim(),
          round: researchForm.round.trim(),
          verifySources: researchForm.verifySources,
          waitMs: autoCaptureWaitMs,
        }),
      });

      const payload = (await response.json()) as
        | AutoCaptureImportResponse
        | { error: string };
      if (!response.ok || "error" in payload) {
        setAutoCaptureError(
          "error" in payload ? payload.error : "自动抓取导入失败",
        );
        return;
      }

      const localSuggestion = inferCaptureContextSuggestions({
        pageTitle: payload.capture.pageTitle,
        pageUrl: payload.capture.pageUrl,
        reportText: payload.capture.cleanedText,
        sourceUrls: payload.capture.sourceUrls,
        companyAliasDict: companyAliasEntries,
      });
      const suggestion =
        localSuggestion.targetRoles.length > 0 || localSuggestion.companies.length > 0
          ? localSuggestion
          : payload.capture.suggestions;

      setCaptureRawText(payload.capture.rawText);
      setCaptureCleanText(payload.capture.cleanedText);
      setCaptureMeta({
        pageTitle: payload.capture.pageTitle || "未命名页面",
        pageUrl: payload.capture.pageUrl || pageUrl,
        capturedAt: payload.capture.capturedAt,
        rawCharCount: payload.capture.rawCharCount,
        cleanedCharCount: payload.capture.cleanedCharCount,
        removedLineCount: payload.capture.removedLineCount,
        sourceUrlCount: payload.capture.sourceUrls.length,
        providerHint: payload.capture.providerHint,
        citationReady: payload.capture.citationReady,
      });
      setCaptureSuggestion({
        targetRoleSuggestions: suggestion.targetRoles,
        companySuggestions: suggestion.companies,
        confidence: suggestion.confidence,
      });

      setResearchForm((prev) => {
        const fallbackRole =
          !prev.targetRole.trim() ||
          prev.targetRole.trim() === defaultResearchImportForm.targetRole;
        const nextRole = fallbackRole
          ? suggestion.targetRoles[0] || prev.targetRole
          : prev.targetRole;

        return {
          ...prev,
          provider: payload.capture.providerHint ?? prev.provider,
          targetRole: nextRole,
          company: prev.company,
          reportText: payload.capture.cleanedText,
          sourceUrls: mergeSourceUrlLines(prev.sourceUrls, payload.capture.sourceUrls),
        };
      });

      setResearchChecks(payload.sourceChecks);
      setResearchStats(payload.stats);
      setResearchMessage(`自动导入完成，新增 ${payload.createdCount} 条经验。`);
      setCaptureMessage(
        payload.capture.citationReady
          ? `自动抓取完成：已提取 ${payload.capture.sourceUrls.length} 条来源，并自动入库。`
          : "自动抓取完成，但未提取到稳定外链，建议你人工补充来源后再复核一次。",
      );
      setAutoCaptureMessage(
        `自动流程成功：抓取 -> 解析 -> 入库已完成，新增 ${payload.createdCount} 条。`,
      );
      await refreshEntries();
    } catch {
      setAutoCaptureError("网络异常，自动抓取导入失败。");
    } finally {
      setAutoCaptureLoading(false);
    }
  }

  async function onCopyCaptureBookmarklet() {
    setCaptureError(null);
    setCaptureMessage(null);
    try {
      await navigator.clipboard.writeText(captureBookmarklet);
      setBookmarkletCopied(true);
      setCaptureMessage(
        "书签脚本 URL 已复制。请新建浏览器书签并把地址替换为该脚本。",
      );
    } catch {
      setCaptureError("复制失败，请手动复制下方脚本 URL。");
    }
  }

  function onAddCompanyAliasDraft() {
    const company = aliasDraftCompany.trim();
    const aliases = parseAliasInput(aliasDraftAliases);
    if (!company) {
      setAliasError("公司名称不能为空。");
      return;
    }
    const nextAliases = Array.from(new Set([company, ...aliases]));
    setCompanyAliasEntries((prev) => {
      const index = prev.findIndex((item) => item.company === company);
      if (index < 0) {
        return [...prev, { company, aliases: nextAliases }];
      }
      const merged = Array.from(
        new Set([...prev[index].aliases, ...nextAliases]),
      ).slice(0, 20);
      return prev.map((item, idx) =>
        idx === index ? { ...item, aliases: merged } : item,
      );
    });
    setAliasDraftCompany("");
    setAliasDraftAliases("");
    setAliasError(null);
    setAliasMessage(`已加入词典：${company}`);
  }

  function onUpdateCompanyAliasCompany(index: number, company: string) {
    setCompanyAliasEntries((prev) =>
      prev.map((item, idx) =>
        idx === index ? { ...item, company } : item,
      ),
    );
  }

  function onUpdateCompanyAliasAliases(index: number, aliasesText: string) {
    setCompanyAliasEntries((prev) =>
      prev.map((item, idx) =>
        idx === index
          ? { ...item, aliases: parseAliasInput(aliasesText) }
          : item,
      ),
    );
  }

  function onRemoveCompanyAliasEntry(index: number) {
    setCompanyAliasEntries((prev) => prev.filter((_, idx) => idx !== index));
    setAliasMessage("已删除词典条目。");
    setAliasError(null);
  }

  async function onSaveCompanyAliasDictionary() {
    setAliasSaving(true);
    setAliasError(null);
    setAliasMessage(null);
    try {
      const response = await fetch("/api/config/company-aliases", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: companyAliasEntries }),
      });
      const payload = (await response.json()) as
        | { entries: CompanyAliasEntry[] }
        | { error: string };
      if (!response.ok || "error" in payload) {
        setAliasError("error" in payload ? payload.error : "保存词典失败");
        return;
      }
      setCompanyAliasEntries(payload.entries);
      setAliasMessage(`词典已保存，共 ${payload.entries.length} 个公司。`);
    } catch {
      setAliasError("网络异常，保存词典失败。");
    } finally {
      setAliasSaving(false);
    }
  }

  async function onResetCompanyAliasDictionary() {
    setAliasSaving(true);
    setAliasError(null);
    setAliasMessage(null);
    try {
      const response = await fetch("/api/config/company-aliases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset" }),
      });
      const payload = (await response.json()) as
        | { entries: CompanyAliasEntry[] }
        | { error: string };
      if (!response.ok || "error" in payload) {
        setAliasError("error" in payload ? payload.error : "恢复默认失败");
        return;
      }
      setCompanyAliasEntries(payload.entries);
      setAliasMessage("已恢复默认词典。");
    } catch {
      setAliasError("网络异常，恢复默认失败。");
    } finally {
      setAliasSaving(false);
    }
  }

  function onApplyDeepResearchToImport() {
    if (!deepResearchResult) return;
    const profile = deepResearchResult.profile;
    const sourceUrls = deepResearchResult.sources.map((item) => item.url);
    const synthesizedReport = [
      `岗位画像摘要：${profile.roleSummary}`,
      "",
      "核心职责：",
      ...profile.coreResponsibilities.map((item, index) => `${index + 1}. ${item}`),
      "",
      "核心技能：",
      ...profile.coreSkills.map(
        (item, index) =>
          `${index + 1}. ${item.skill}（优先级：${item.priority}）- ${item.reason}`,
      ),
      "",
      "面试主题：",
      ...profile.interviewQuestionThemes.map((item, index) => {
        const questions =
          item.sampleQuestions.length > 0
            ? ` 示例题：${item.sampleQuestions.join(" / ")}`
            : "";
        return `${index + 1}. ${item.theme} - ${item.whyImportant}${questions}`;
      }),
      "",
      "风险点：",
      ...profile.risks.map((item, index) => `${index + 1}. ${item}`),
      "",
      "行动建议：",
      ...profile.actionPlan.map((item, index) => `${index + 1}. ${item}`),
    ].join("\n");

    setResearchForm((prev) => ({
      ...prev,
      provider: "other",
      targetRole: deepResearchForm.targetRole.trim() || prev.targetRole,
      company: deepResearchForm.company.trim() || prev.company,
      reportText: synthesizedReport,
      sourceUrls: mergeSourceUrlLines(prev.sourceUrls, sourceUrls),
    }));
    setCaptureMessage("已把多源 Deep Research 结果回填到导入区，可直接导入经验库。");
  }

  function onApplyCapturedText(mode: "cleaned" | "raw") {
    if (!captureRawText && !captureCleanText) {
      setCaptureError("还没有可用的抓取文本，请先读取抓取结果。");
      return;
    }
    const nextText = mode === "cleaned" ? captureCleanText : captureRawText;
    setResearchForm((prev) => ({
      ...prev,
      reportText: nextText,
    }));
    setCaptureMessage(mode === "cleaned" ? "已应用清洗文本。" : "已恢复原始抓取文本。");
    setCaptureError(null);
  }

  function onApplyCaptureSuggestion(field: "targetRole" | "company", value: string) {
    if (!value.trim()) return;
    setResearchForm((prev) => ({
      ...prev,
      [field]: value,
    }));
    setCaptureMessage(
      field === "targetRole"
        ? `已应用岗位建议：${value}`
        : `已应用公司建议：${value}`,
    );
    setCaptureError(null);
  }

  function onApplyAllCaptureSuggestions() {
    if (!captureSuggestion) {
      setCaptureError("暂无可应用建议，请先读取抓取结果。");
      return;
    }
    const role = captureSuggestion.targetRoleSuggestions[0];
    const company = captureSuggestion.companySuggestions[0];
    setResearchForm((prev) => ({
      ...prev,
      targetRole: role || prev.targetRole,
      company: company || prev.company,
    }));
    setCaptureMessage(
      `已一键应用建议：岗位=${role || "保持原值"}，公司=${company || "保持原值"}`,
    );
    setCaptureError(null);
  }

  async function onReadCaptureFromClipboard() {
    setCaptureLoading(true);
    setCaptureError(null);
    setCaptureMessage(null);
    setCaptureSuggestion(null);
    try {
      if (!navigator.clipboard?.readText) {
        setCaptureError("当前浏览器不支持读取剪贴板，请改用手动粘贴文本。");
        return;
      }
      const raw = await navigator.clipboard.readText();
      const payload = parseBrowserCapture(raw);
      if (!payload) {
        setCaptureError(
          "剪贴板内容不是有效抓取结果。请先在研究结果页点击书签脚本。",
        );
        return;
      }

      const cleanResult = cleanCapturedReportText(payload.reportText);
      setCaptureRawText(payload.reportText);
      setCaptureCleanText(cleanResult.cleanedText);
      const externalCount = payload.sourceUrls.filter(
        (url) => !isLikelyConversationOrAppUrl(url, payload.pageUrl),
      ).length;
      const citationReady = externalCount > 0;
      const suggestion = inferCaptureContextSuggestions({
        pageTitle: payload.pageTitle,
        pageUrl: payload.pageUrl,
        reportText: cleanResult.cleanedText,
        sourceUrls: payload.sourceUrls,
        companyAliasDict: companyAliasEntries,
      });

      let autoRoleApplied = "";
      let autoCompanyApplied = "";

      setResearchForm((prev) => {
        const shouldFillRole =
          (!prev.targetRole.trim() ||
            prev.targetRole.trim() === defaultResearchImportForm.targetRole) &&
          Boolean(suggestion.targetRoles[0]);
        const shouldFillCompany =
          !prev.company.trim() && Boolean(suggestion.companies[0]);

        const nextRole = shouldFillRole ? suggestion.targetRoles[0] : prev.targetRole;
        const nextCompany = shouldFillCompany
          ? suggestion.companies[0]
          : prev.company;

        if (nextRole && nextRole !== prev.targetRole) autoRoleApplied = nextRole;
        if (nextCompany && nextCompany !== prev.company) autoCompanyApplied = nextCompany;

        return {
          ...prev,
          provider: payload.providerHint ?? prev.provider,
          reportText: cleanResult.cleanedText,
          sourceUrls: mergeSourceUrlLines(prev.sourceUrls, payload.sourceUrls),
          targetRole: nextRole,
          company: nextCompany,
        };
      });
      setCaptureMeta({
        pageTitle: payload.pageTitle || "未命名页面",
        pageUrl: payload.pageUrl || "",
        capturedAt: payload.capturedAt,
        rawCharCount: cleanResult.originalLength,
        cleanedCharCount: cleanResult.cleanedLength,
        removedLineCount: cleanResult.removedLineCount,
        sourceUrlCount: payload.sourceUrls.length,
        providerHint: payload.providerHint,
        citationReady,
      });
      setCaptureSuggestion({
        targetRoleSuggestions: suggestion.targetRoles,
        companySuggestions: suggestion.companies,
        confidence: suggestion.confidence,
      });

      const autoAppliedParts = [
        autoRoleApplied ? `岗位=${autoRoleApplied}` : "",
        autoCompanyApplied ? `公司=${autoCompanyApplied}` : "",
      ].filter((item) => item.length > 0);
      const autoAppliedText =
        autoAppliedParts.length > 0
          ? ` 已自动补全：${autoAppliedParts.join("，")}。`
          : "";
      if (citationReady) {
        setCaptureMessage(
          `抓取并清洗完成：${cleanResult.cleanedLength} 字，已提取 ${externalCount} 条参考外链。${autoAppliedText}`,
        );
      } else {
        setCaptureMessage(
          `已读取到文本，但尚未提取到参考外链。请在豆包右侧“参考资料”展开后，再点一次书签抓取。${autoAppliedText}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("NotAllowedError")) {
        setCaptureError("浏览器拒绝了剪贴板权限，请允许后重试。");
      } else {
        setCaptureError("读取剪贴板失败，请重试。");
      }
    } finally {
      setCaptureLoading(false);
    }
  }

  async function onRunDedup(dryRun: boolean) {
    setDedupLoading(true);
    setDedupError(null);
    setDedupMessage(null);
    setDedupSummary(null);
    try {
      const response = await fetch("/api/library/dedup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dryRun,
          similarityThreshold: 0.86,
        }),
      });
      const payload = (await response.json()) as DedupSummary | { error: string };
      if (!response.ok || "error" in payload) {
        setDedupError("error" in payload ? payload.error : "去重失败");
        return;
      }
      setDedupSummary(payload);
      setDedupMessage(
        dryRun
          ? `预览完成：可合并 ${payload.mergedCount} 条，涉及 ${payload.duplicateGroups} 组。`
          : `去重完成：已从 ${payload.beforeCount} 条整理为 ${payload.afterCount} 条。`,
      );
      if (!dryRun) await refreshEntries();
    } catch {
      setDedupError("网络异常，去重失败。");
    } finally {
      setDedupLoading(false);
    }
  }

  async function onImportImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!imageForm.imageFile) {
      setImageError("请先上传图片。");
      return;
    }
    setImageLoading(true);
    setImageError(null);
    setImageMessage(null);
    setImageStats(null);
    setImageChecks([]);
    setImagePreview("");

    try {
      const formData = new FormData();
      formData.append("image", imageForm.imageFile);
      formData.append("provider", imageForm.provider);
      formData.append("targetRole", imageForm.targetRole.trim());
      formData.append("company", imageForm.company.trim());
      formData.append("round", imageForm.round.trim());
      formData.append("sourceUrls", imageForm.sourceUrls);
      formData.append("verifySources", imageForm.verifySources ? "true" : "false");

      const response = await fetch("/api/library/import-image", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json()) as ImageImportResponse | { error: string };
      if (!response.ok || "error" in payload) {
        setImageError("error" in payload ? payload.error : "图片导入失败");
        return;
      }

      setImageMessage(
        `图片导入成功，OCR 提取 ${payload.textLength} 字，新增 ${payload.createdCount} 条经验。`,
      );
      setImageStats(payload.stats);
      setImageChecks(payload.sourceChecks);
      setImagePreview(payload.ocrPreview);
      await refreshEntries();
    } catch {
      setImageError("网络异常，图片导入失败。");
    } finally {
      setImageLoading(false);
    }
  }

  return (
    <div className="app-shell min-h-screen px-4 py-8 md:px-8">
      <main className="app-main mx-auto flex w-full max-w-6xl flex-col gap-6">
        <header className="hero-panel panel rounded-2xl border border-border bg-surface p-6 shadow-[0_10px_30px_rgba(21,42,61,0.08)]">
          <h1 className="text-2xl font-semibold tracking-tight md:text-4xl">
            求职面试复盘助手
          </h1>
          <p className="mt-2 text-sm text-muted md:text-base">
            第三阶段：自动导入研究结果并做来源复查
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-border bg-background px-2.5 py-1 text-muted">
              复盘结构化
            </span>
            <span className="rounded-full border border-border bg-background px-2.5 py-1 text-muted">
              Deep Research 汇总
            </span>
            <span className="rounded-full border border-border bg-background px-2.5 py-1 text-muted">
              经验库可追溯
            </span>
          </div>
          <div className="mode-switch mt-4 inline-flex rounded-xl border border-border bg-white/85 p-1">
            <button
              onClick={() => setMode("review")}
              className={`rounded-lg px-3 py-1.5 text-sm transition ${
                mode === "review"
                  ? "bg-brand text-white shadow-[0_8px_18px_rgba(13,93,109,0.35)]"
                  : "text-foreground hover:bg-background"
              }`}
            >
              复盘模式
            </button>
            <button
              onClick={() => setMode("prep")}
              className={`rounded-lg px-3 py-1.5 text-sm transition ${
                mode === "prep"
                  ? "bg-brand text-white shadow-[0_8px_18px_rgba(13,93,109,0.35)]"
                  : "text-foreground hover:bg-background"
              }`}
            >
              面试前准备模式
            </button>
          </div>
        </header>

        <section className="panel rounded-2xl border border-border bg-surface p-6 shadow-[0_10px_28px_rgba(21,42,61,0.06)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">项目健康看板（多角色视角）</h2>
              <p className="mt-1 text-sm text-muted">
                同时从使用者、开发者、程序员、产品经理视角审视当前版本健康度。
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadProjectHealth()}
              disabled={projectHealthLoading}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {projectHealthLoading ? "刷新中..." : "刷新健康数据"}
            </button>
          </div>

          {projectHealthError && (
            <p className="mt-3 rounded-lg border border-risk/30 bg-risk/10 px-3 py-2 text-sm text-risk">
              {projectHealthError}
            </p>
          )}

          {projectHealth && (
            <div className="mt-4 space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl border border-border bg-white p-3 text-sm">
                  <p className="text-muted">经验库条目</p>
                  <p className="mt-1 text-xl font-semibold">
                    {projectHealth.overview.libraryEntryCount}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    岗位 {projectHealth.overview.roleCount} / 公司{" "}
                    {projectHealth.overview.companyCount}
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-white p-3 text-sm">
                  <p className="text-muted">7天 prep 通过率</p>
                  <p className="mt-1 text-xl font-semibold">
                    {projectHealth.overview.prepPassRate7d}%
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    7天 deep research 通过率 {projectHealth.overview.deepResearchPassRate7d}%
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-white p-3 text-sm">
                  <p className="text-muted">7天运行错误率</p>
                  <p className="mt-1 text-xl font-semibold">
                    {projectHealth.overview.runtimeErrorRate7d}%
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    队列门禁通过率 {projectHealth.overview.queueGatePassRate}%
                  </p>
                </div>
                <div className="rounded-xl border border-border bg-white p-3 text-sm">
                  <p className="text-muted">队列任务总数</p>
                  <p className="mt-1 text-xl font-semibold">
                    {projectHealth.overview.deepResearchJobCount}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    平均准备度 {projectHealth.overview.avgReadinessScore}
                  </p>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-border bg-white p-4">
                  <h3 className="text-sm font-semibold">角色诊断</h3>
                  <ul className="mt-2 space-y-2 text-sm text-muted">
                    <li>
                      使用者：
                      <span className={`ml-1 font-medium ${perspectiveLevelClass(projectHealth.perspectives.user.level)}`}>
                        {perspectiveLevelLabel(projectHealth.perspectives.user.level)}
                      </span>
                      <span className="ml-1">{projectHealth.perspectives.user.summary}</span>
                    </li>
                    <li>
                      开发者：
                      <span className={`ml-1 font-medium ${perspectiveLevelClass(projectHealth.perspectives.developer.level)}`}>
                        {perspectiveLevelLabel(projectHealth.perspectives.developer.level)}
                      </span>
                      <span className="ml-1">{projectHealth.perspectives.developer.summary}</span>
                    </li>
                    <li>
                      程序员：
                      <span className={`ml-1 font-medium ${perspectiveLevelClass(projectHealth.perspectives.engineer.level)}`}>
                        {perspectiveLevelLabel(projectHealth.perspectives.engineer.level)}
                      </span>
                      <span className="ml-1">{projectHealth.perspectives.engineer.summary}</span>
                    </li>
                    <li>
                      产品经理：
                      <span className={`ml-1 font-medium ${perspectiveLevelClass(projectHealth.perspectives.productManager.level)}`}>
                        {perspectiveLevelLabel(projectHealth.perspectives.productManager.level)}
                      </span>
                      <span className="ml-1">{projectHealth.perspectives.productManager.summary}</span>
                    </li>
                  </ul>
                </div>
                <div className="rounded-xl border border-border bg-white p-4">
                  <h3 className="text-sm font-semibold">当前风险提醒</h3>
                  {projectHealth.alerts.length > 0 ? (
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
                      {projectHealth.alerts.map((item, index) => (
                        <li key={`project-health-alert-${index}`}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-muted">暂无高优先级风险提醒。</p>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>

        {mode === "review" ? (
          <section className="grid gap-6 md:grid-cols-[1fr_1.2fr]">
            <div className="panel rounded-2xl border border-border bg-surface p-6 shadow-[0_10px_28px_rgba(21,42,61,0.06)]">
              <h2 className="text-lg font-semibold">输入面试回忆</h2>
              <p className="mt-1 text-sm text-muted">
                生成三段式复盘后，可一键写入经验库。
              </p>
              <form className="mt-4 space-y-4" onSubmit={onSubmitReview}>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">目标岗位</span>
                  <input
                    className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                    value={reviewForm.targetRole}
                    onChange={(e) =>
                      setReviewForm((prev) => ({ ...prev, targetRole: e.target.value }))
                    }
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">公司（可选）</span>
                  <input
                    className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                    value={reviewForm.company}
                    onChange={(e) =>
                      setReviewForm((prev) => ({ ...prev, company: e.target.value }))
                    }
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">面试轮次</span>
                  <select
                    className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                    value={reviewForm.round}
                    onChange={(e) =>
                      setReviewForm((prev) => ({ ...prev, round: e.target.value }))
                    }
                  >
                    <option value="一面">一面</option>
                    <option value="二面">二面</option>
                    <option value="终面">终面</option>
                    <option value="HR 面">HR 面</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">面试回忆文本</span>
                  <textarea
                    className="min-h-48 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm leading-6 outline-none ring-brand/30 transition focus:ring-2"
                    value={reviewForm.notes}
                    onChange={(e) =>
                      setReviewForm((prev) => ({ ...prev, notes: e.target.value }))
                    }
                  />
                  <div className="mt-1 text-xs text-muted">
                    当前 {notesCount} 字，建议至少 120 字。
                  </div>
                </label>
                <button
                  type="submit"
                  disabled={reviewLoading || notesCount < 40}
                  className="inline-flex w-full items-center justify-center rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {reviewLoading ? "正在生成复盘..." : "生成三段式复盘"}
                </button>
              </form>
            </div>

            <div className="panel rounded-2xl border border-border bg-surface p-6 shadow-[0_10px_28px_rgba(21,42,61,0.06)]">
              <h2 className="text-lg font-semibold">复盘结果</h2>
              {!review && !reviewError && (
                <p className="mt-3 text-sm text-muted">
                  提交后显示结构化复盘，支持一键导入经验库。
                </p>
              )}
              {reviewError && (
                <p className="mt-3 rounded-lg border border-risk/30 bg-risk/5 px-3 py-2 text-sm text-risk">
                  {reviewError}
                </p>
              )}
              {review && (
                <div className="mt-4 space-y-4">
                  <section className="rounded-xl border border-border bg-white p-4">
                    <h3 className="text-sm font-semibold text-brand">1) 面试摘要</h3>
                    <p className="mt-2 text-sm leading-6 text-foreground">{review.summary}</p>
                  </section>
                  <section className="rounded-xl border border-border bg-white p-4">
                    <h3 className="text-sm font-semibold text-brand">2) 问题清单</h3>
                    <div className="mt-3 space-y-3">
                      {review.questions.map((item, index) => (
                        <article
                          key={`${item.question}-${index}`}
                          className="rounded-lg border border-border px-3 py-3 text-sm"
                        >
                          <p className="font-medium">{index + 1}. {item.question}</p>
                          <p className={`mt-1 text-xs ${qualityColor(item.performance)}`}>
                            表现：{item.performance}
                          </p>
                          <p className="mt-1 text-muted">问题：{item.issue}</p>
                          <p className="mt-1 text-muted">改进建议：{item.betterAnswer}</p>
                        </article>
                      ))}
                    </div>
                  </section>
                  <section className="rounded-xl border border-border bg-white p-4">
                    <h3 className="text-sm font-semibold text-brand">3) 下次改进动作</h3>
                    <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm leading-6 text-foreground">
                      {review.nextActions.map((action, index) => (
                        <li key={`${action}-${index}`}>{action}</li>
                      ))}
                    </ol>
                  </section>
                  <button
                    onClick={onImportReviewToLibrary}
                    disabled={importLoading}
                    className="inline-flex w-full items-center justify-center rounded-xl border border-brand px-4 py-2 text-sm font-medium text-brand transition hover:bg-brand hover:text-white disabled:opacity-50"
                  >
                    {importLoading ? "正在导入经验库..." : "将本次复盘写入经验库"}
                  </button>
                  {importMessage && (
                    <p className="text-sm text-muted">{importMessage}</p>
                  )}
                </div>
              )}
            </div>
          </section>
        ) : (
          <section className="grid gap-6">
            <div className="panel rounded-2xl border border-border bg-surface p-6 shadow-[0_10px_28px_rgba(21,42,61,0.06)]">
              <h2 className="text-lg font-semibold">B2｜多源 Deep Research 岗位画像</h2>
              <p className="mt-1 text-sm text-muted">
                采用“并行多渠道搜索”逻辑，从岗位 JD、面经、社区、知识文章、薪资信号构建岗位画像。
              </p>
              <form className="mt-4 grid gap-3 md:grid-cols-2" onSubmit={onRunDeepResearch}>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">目标岗位</span>
                  <input
                    className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                    value={deepResearchForm.targetRole}
                    onChange={(e) =>
                      setDeepResearchForm((prev) => ({
                        ...prev,
                        targetRole: e.target.value,
                      }))
                    }
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">目标公司（可选）</span>
                  <input
                    className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                    value={deepResearchForm.company}
                    onChange={(e) =>
                      setDeepResearchForm((prev) => ({
                        ...prev,
                        company: e.target.value,
                      }))
                    }
                  />
                </label>
                <label className="block md:col-span-2">
                  <span className="mb-1 block text-sm font-medium">关注点（可选）</span>
                  <textarea
                    className="min-h-20 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm leading-6 outline-none ring-brand/30 transition focus:ring-2"
                    placeholder="例如：能力模型、转行门槛、面试题型、薪资区间"
                    value={deepResearchForm.focus}
                    onChange={(e) =>
                      setDeepResearchForm((prev) => ({
                        ...prev,
                        focus: e.target.value,
                      }))
                    }
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">每渠道最大来源数</span>
                  <select
                    className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                    value={deepResearchForm.maxSourcesPerChannel}
                    onChange={(e) =>
                      setDeepResearchForm((prev) => ({
                        ...prev,
                        maxSourcesPerChannel: Number(e.target.value),
                      }))
                    }
                  >
                    <option value={6}>6（快）</option>
                    <option value={8}>8（推荐）</option>
                    <option value={10}>10（更全）</option>
                    <option value={12}>12（更慢）</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">B2.1 反思式二次检索</span>
                  <button
                    type="button"
                    onClick={() =>
                      setDeepResearchForm((prev) => ({
                        ...prev,
                        enableReflection: !prev.enableReflection,
                      }))
                    }
                    className={`inline-flex w-full items-center justify-between rounded-xl border px-3 py-2 text-sm transition ${
                      deepResearchForm.enableReflection
                        ? "border-brand bg-brand/10 text-brand"
                        : "border-border bg-white text-muted"
                    }`}
                  >
                    <span>{deepResearchForm.enableReflection ? "已启用（推荐）" : "已关闭"}</span>
                    <span className="text-xs">
                      {deepResearchForm.enableReflection ? "开启二轮补检索" : "仅首轮检索"}
                    </span>
                  </button>
                </label>
                {deepResearchForm.enableReflection && (
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium">每弱渠道二次查询数</span>
                    <select
                      className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                      value={deepResearchForm.reflectionQueriesPerChannel}
                      onChange={(e) =>
                        setDeepResearchForm((prev) => ({
                          ...prev,
                          reflectionQueriesPerChannel: Number(e.target.value),
                        }))
                      }
                    >
                      <option value={1}>1（快）</option>
                      <option value={2}>2（推荐）</option>
                      <option value={3}>3（更全）</option>
                    </select>
                  </label>
                )}
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">B2.3 多模型交叉验证</span>
                  <button
                    type="button"
                    onClick={() =>
                      setDeepResearchForm((prev) => ({
                        ...prev,
                        enableCrossValidation: !prev.enableCrossValidation,
                      }))
                    }
                    className={`inline-flex w-full items-center justify-between rounded-xl border px-3 py-2 text-sm transition ${
                      deepResearchForm.enableCrossValidation
                        ? "border-brand bg-brand/10 text-brand"
                        : "border-border bg-white text-muted"
                    }`}
                  >
                    <span>
                      {deepResearchForm.enableCrossValidation ? "已启用（更稳）" : "已关闭（更省）"}
                    </span>
                    <span className="text-xs">
                      {deepResearchForm.enableCrossValidation
                        ? "第二模型复核画像"
                        : "仅单模型输出"}
                    </span>
                  </button>
                </label>
                {deepResearchForm.enableCrossValidation && (
                  <>
                    <label className="block">
                      <span className="mb-1 block text-sm font-medium">复核模型提供方</span>
                      <select
                        className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                        value={deepResearchForm.crossValidationProvider}
                        onChange={(e) =>
                          setDeepResearchForm((prev) => ({
                            ...prev,
                            crossValidationProvider: e.target.value as
                              | "auto"
                              | LlmProvider,
                          }))
                        }
                      >
                        <option value="auto">自动（同主模型提供方）</option>
                        <option value="zhipu">智谱</option>
                        <option value="minimax">MiniMax</option>
                        <option value="doubao">豆包</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-sm font-medium">
                        复核模型名（建议填）
                      </span>
                      <input
                        className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                        placeholder="例如：glm-4.5 / abab7.5-chat / doubao-1.5-pro"
                        value={deepResearchForm.crossValidationModel}
                        onChange={(e) =>
                          setDeepResearchForm((prev) => ({
                            ...prev,
                            crossValidationModel: e.target.value,
                          }))
                        }
                      />
                    </label>
                  </>
                )}
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">B2.6 异步任务队列</span>
                  <button
                    type="button"
                    onClick={() => setDeepResearchUseQueue((prev) => !prev)}
                    className={`inline-flex w-full items-center justify-between rounded-xl border px-3 py-2 text-sm transition ${
                      deepResearchUseQueue
                        ? "border-brand bg-brand/10 text-brand"
                        : "border-border bg-white text-muted"
                    }`}
                  >
                    <span>{deepResearchUseQueue ? "已启用（推荐）" : "已关闭"}</span>
                    <span className="text-xs">
                      {deepResearchUseQueue
                        ? "长任务支持重试与追踪"
                        : "同步执行（简单）"}
                    </span>
                  </button>
                </label>
                <div className="flex items-end">
                  <button
                    type="submit"
                    disabled={deepResearchLoading}
                    className="inline-flex w-full items-center justify-center rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-strong disabled:opacity-50"
                  >
                    {deepResearchLoading
                      ? deepResearchUseQueue
                        ? "任务执行中..."
                        : "并行检索中..."
                      : deepResearchUseQueue
                        ? "提交 Deep Research 异步任务"
                        : "生成岗位 Deep Research 画像"}
                  </button>
                </div>
              </form>

              {deepResearchJob && (
                <div className="mt-3 rounded-lg border border-border bg-white px-3 py-3 text-xs text-muted">
                  <div className="grid gap-2 md:grid-cols-4">
                    <p>任务ID：{deepResearchJob.id.slice(0, 8)}...</p>
                    <p>状态：{deepResearchJob.status}</p>
                    <p>
                      尝试：{deepResearchJob.attempts}/{deepResearchJob.maxAttempts}
                    </p>
                    <p>
                      下次执行：
                      {deepResearchJob.nextRunAt
                        ? new Date(deepResearchJob.nextRunAt).toLocaleTimeString("zh-CN", {
                            hour12: false,
                          })
                        : "-"}
                    </p>
                  </div>
                  {deepResearchJob.lastError && (
                    <p className="mt-1 text-risk">最近错误：{deepResearchJob.lastError}</p>
                  )}
                  {!(
                    deepResearchJob.status === "completed" ||
                    deepResearchJob.status === "failed" ||
                    deepResearchJob.status === "cancelled"
                  ) && (
                    <button
                      type="button"
                      onClick={() => void onCancelDeepResearchJob()}
                      className="mt-2 rounded-lg border border-risk/40 px-2 py-1 text-xs text-risk hover:bg-risk hover:text-white"
                    >
                      取消任务
                    </button>
                  )}
                </div>
              )}

              {deepResearchError && (
                <p className="mt-3 rounded-lg border border-risk/30 bg-risk/5 px-3 py-2 text-sm text-risk">
                  {deepResearchError}
                </p>
              )}

              {deepResearchResult && (
                <div className="mt-4 space-y-4">
                  <div className="grid gap-2 text-xs text-muted md:grid-cols-10">
                    <p className="rounded-lg border border-border bg-white px-2 py-1">
                      来源总数：{deepResearchResult.sources.length}
                    </p>
                    <p className="rounded-lg border border-border bg-white px-2 py-1">
                      检索渠道：{deepResearchResult.channelStats.length}
                    </p>
                    <p className="rounded-lg border border-border bg-white px-2 py-1">
                      查询批次：{deepResearchResult.queryPlan.reduce((acc, item) => acc + item.queries.length, 0)}
                    </p>
                    <p className="rounded-lg border border-border bg-white px-2 py-1">
                      主检成功：{deepResearchResult.searchTelemetry.primarySuccess}
                    </p>
                    <p className="rounded-lg border border-border bg-white px-2 py-1">
                      回退成功：{deepResearchResult.searchTelemetry.fallbackSuccess}
                    </p>
                    <p className="rounded-lg border border-border bg-white px-2 py-1">
                      二轮新增：{deepResearchResult.reflection.secondPassSourceCount}
                    </p>
                    <p className="rounded-lg border border-border bg-white px-2 py-1">
                      质量均分：{deepResearchResult.qualityStats.avgScore}
                    </p>
                    <p className="rounded-lg border border-border bg-white px-2 py-1">
                      交叉一致度：
                      {deepResearchResult.crossValidation.used
                        ? `${deepResearchResult.crossValidation.alignmentScore}`
                        : "-"}
                    </p>
                    <p
                      className={`rounded-lg border px-2 py-1 ${
                        deepResearchResult.readiness.gatePassed
                          ? "border-ok/30 bg-ok/5 text-ok"
                          : "border-risk/30 bg-risk/5 text-risk"
                      }`}
                    >
                      研究门禁：
                      {deepResearchResult.readiness.gatePassed
                        ? `通过（${deepResearchResult.readiness.score}）`
                        : `未通过（${deepResearchResult.readiness.score}）`}
                    </p>
                    <p className="rounded-lg border border-border bg-white px-2 py-1">
                      合格论点：{deepResearchResult.evidenceClusters.accepted}
                    </p>
                    <p className="rounded-lg border border-border bg-white px-2 py-1">
                      生成时间：
                      {new Date(deepResearchResult.generatedAt).toLocaleTimeString("zh-CN", {
                        hour12: false,
                      })}
                    </p>
                  </div>

                  <section className="rounded-xl border border-border bg-white p-4">
                    <h3 className="text-sm font-semibold text-brand">
                      B2.4 多检索引擎回退（有结果率增强）
                    </h3>
                    <div className="mt-2 grid gap-2 text-sm text-muted md:grid-cols-4">
                      <p className="rounded-lg border border-border px-2 py-1">
                        查询总数：{deepResearchResult.searchTelemetry.totalQueries}
                      </p>
                      <p className="rounded-lg border border-border px-2 py-1">
                        主检成功：{deepResearchResult.searchTelemetry.primarySuccess}
                      </p>
                      <p className="rounded-lg border border-border px-2 py-1">
                        回退成功：{deepResearchResult.searchTelemetry.fallbackSuccess}
                      </p>
                      <p className="rounded-lg border border-border px-2 py-1">
                        失败查询：{deepResearchResult.searchTelemetry.failedQueries}
                      </p>
                    </div>
                    <div className="mt-2 grid gap-2 text-xs text-muted md:grid-cols-3">
                      {deepResearchResult.searchTelemetry.engineUsage.length > 0 ? (
                        deepResearchResult.searchTelemetry.engineUsage.map((item) => (
                          <p
                            key={`engine-usage-${item.engine}`}
                            className="rounded-lg border border-border bg-surface px-2 py-1"
                          >
                            引擎 {item.engine}：{item.count}
                          </p>
                        ))
                      ) : (
                        <p className="rounded-lg border border-border bg-surface px-2 py-1">
                          暂无可用引擎命中
                        </p>
                      )}
                    </div>
                  </section>

                  <section className="rounded-xl border border-border bg-white p-4">
                    <h3 className="text-sm font-semibold text-brand">
                      B2.5 论点级证据聚类（双域名门槛）
                    </h3>
                    <div className="mt-2 grid gap-2 text-sm text-muted md:grid-cols-4">
                      <p className="rounded-lg border border-border px-2 py-1">
                        最低支撑域名：{deepResearchResult.evidenceClusters.minSupportDomains}
                      </p>
                      <p className="rounded-lg border border-border px-2 py-1">
                        聚类总数：{deepResearchResult.evidenceClusters.total}
                      </p>
                      <p className="rounded-lg border border-border px-2 py-1">
                        合格聚类：{deepResearchResult.evidenceClusters.accepted}
                      </p>
                      <p className="rounded-lg border border-border px-2 py-1">
                        未合格聚类：
                        {deepResearchResult.evidenceClusters.total -
                          deepResearchResult.evidenceClusters.accepted}
                      </p>
                    </div>
                    <div className="mt-3 space-y-2">
                      {deepResearchResult.evidenceClusters.clusters.slice(0, 8).map((cluster) => (
                        <article
                          key={cluster.id}
                          className="rounded-lg border border-border px-3 py-2 text-xs"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`rounded-md px-2 py-0.5 ${
                                cluster.accepted
                                  ? "bg-ok/10 text-ok"
                                  : "bg-risk/10 text-risk"
                              }`}
                            >
                              {cluster.accepted ? "已通过门槛" : "未通过门槛"}
                            </span>
                            <span className="text-muted">
                              域名 {cluster.supportDomainCount} / 来源 {cluster.supportSourceCount}
                            </span>
                            <span className="text-muted">
                              渠道：{cluster.channels.join(" / ")}
                            </span>
                          </div>
                          <p className="mt-1 text-foreground">{cluster.claim}</p>
                        </article>
                      ))}
                    </div>
                  </section>

                  <section className="rounded-xl border border-border bg-white p-4">
                    <h3 className="text-sm font-semibold text-brand">B2.1 反思式二次检索诊断</h3>
                    <div className="mt-2 grid gap-2 text-sm text-muted md:grid-cols-3">
                      <p className="rounded-lg border border-border px-2 py-1">
                        状态：{deepResearchResult.reflection.enabled ? "已启用" : "已关闭"}
                      </p>
                      <p className="rounded-lg border border-border px-2 py-1">
                        是否触发二轮：{deepResearchResult.reflection.secondPassUsed ? "是" : "否"}
                      </p>
                      <p className="rounded-lg border border-border px-2 py-1">
                        弱渠道数：{deepResearchResult.reflection.weakChannels.length}
                      </p>
                    </div>
                    {deepResearchResult.reflection.weakChannels.length > 0 && (
                      <p className="mt-2 text-sm text-muted">
                        弱渠道：{deepResearchResult.reflection.weakChannels.join(" / ")}
                      </p>
                    )}
                    {deepResearchResult.reflection.gapHypotheses.length > 0 && (
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
                        {deepResearchResult.reflection.gapHypotheses.map((item, index) => (
                          <li key={`gap-${index}`}>{item}</li>
                        ))}
                      </ul>
                    )}
                    {deepResearchResult.reflection.secondPassQueries.length > 0 && (
                      <div className="mt-3 space-y-2 text-sm">
                        <p className="font-medium text-foreground">二轮查询清单</p>
                        {deepResearchResult.reflection.secondPassQueries.map((item, index) => (
                          <article
                            key={`${item.channel}-${item.query}-${index}`}
                            className="rounded-lg border border-border px-2 py-2"
                          >
                            <p className="font-medium text-foreground">
                              [{item.channel}] {item.query}
                            </p>
                            <p className="text-muted">目的：{item.reason}</p>
                          </article>
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="rounded-xl border border-border bg-white p-4">
                    <h3 className="text-sm font-semibold text-brand">B2.2 可信来源打分</h3>
                    <div className="mt-2 grid gap-2 text-sm text-muted md:grid-cols-4">
                      <p className="rounded-lg border border-border px-2 py-1">
                        A 级来源：{deepResearchResult.qualityStats.highQualityCount}
                      </p>
                      <p className="rounded-lg border border-border px-2 py-1">
                        B 级来源：{deepResearchResult.qualityStats.mediumQualityCount}
                      </p>
                      <p className="rounded-lg border border-border px-2 py-1">
                        C 级来源：{deepResearchResult.qualityStats.lowQualityCount}
                      </p>
                      <p className="rounded-lg border border-border px-2 py-1">
                        平均质量分：{deepResearchResult.qualityStats.avgScore}
                      </p>
                    </div>
                    <div className="mt-3 grid gap-2 text-xs text-muted md:grid-cols-5">
                      {deepResearchResult.qualityStats.channelAvgScores.map((item) => (
                        <p
                          key={`quality-channel-${item.channel}`}
                          className="rounded-lg border border-border bg-surface px-2 py-1"
                        >
                          {item.channel}：{item.avgScore}（{item.sourceCount}）
                        </p>
                      ))}
                    </div>
                  </section>

                  <section className="rounded-xl border border-border bg-white p-4">
                    <h3 className="text-sm font-semibold text-brand">B2.3 多模型交叉验证</h3>
                    <div className="mt-2 grid gap-2 text-sm text-muted md:grid-cols-4">
                      <p className="rounded-lg border border-border px-2 py-1">
                        状态：{deepResearchResult.crossValidation.enabled ? "已启用" : "未启用"}
                      </p>
                      <p className="rounded-lg border border-border px-2 py-1">
                        已执行：{deepResearchResult.crossValidation.used ? "是" : "否"}
                      </p>
                      <p className="rounded-lg border border-border px-2 py-1">
                        复核提供方：
                        {deepResearchResult.crossValidation.reviewerProvider ?? "-"}
                      </p>
                      <p className="rounded-lg border border-border px-2 py-1">
                        复核模型：
                        {deepResearchResult.crossValidation.reviewerModel ?? "-"}
                      </p>
                    </div>
                    <p className="mt-2 text-sm text-muted">
                      一致度评分：{deepResearchResult.crossValidation.alignmentScore}
                    </p>
                    {deepResearchResult.crossValidation.agreements.length > 0 && (
                      <div className="mt-2">
                        <p className="text-sm font-medium text-foreground">一致点</p>
                        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted">
                          {deepResearchResult.crossValidation.agreements.map((item, index) => (
                            <li key={`cv-agree-${index}`}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {deepResearchResult.crossValidation.conflicts.length > 0 && (
                      <div className="mt-2">
                        <p className="text-sm font-medium text-foreground">冲突点</p>
                        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted">
                          {deepResearchResult.crossValidation.conflicts.map((item, index) => (
                            <li key={`cv-conflict-${index}`}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <p className="mt-2 text-sm text-muted">
                      建议：{deepResearchResult.crossValidation.finalSuggestion}
                    </p>
                  </section>

                  <section className="rounded-xl border border-border bg-white p-4">
                    <h3 className="text-sm font-semibold text-brand">
                      Research Quality Gate（研究结果可用性门禁）
                    </h3>
                    <div className="mt-2 grid gap-2 text-sm text-muted md:grid-cols-4">
                      <p
                        className={`rounded-lg border px-2 py-1 ${
                          deepResearchResult.readiness.gatePassed
                            ? "border-ok/30 bg-ok/5 text-ok"
                            : "border-risk/30 bg-risk/5 text-risk"
                        }`}
                      >
                        门禁状态：{deepResearchResult.readiness.gatePassed ? "通过" : "未通过"}
                      </p>
                      <p className="rounded-lg border border-border px-2 py-1">
                        准备度评分：{deepResearchResult.readiness.score}
                      </p>
                      <p className="rounded-lg border border-border px-2 py-1">
                        准备度等级：{deepResearchResult.readiness.level}
                      </p>
                      <p className="rounded-lg border border-border px-2 py-1">
                        覆盖渠道：{deepResearchResult.readiness.metrics.coveredChannels} / 5
                      </p>
                    </div>
                    <div className="mt-2 grid gap-2 text-xs text-muted md:grid-cols-5">
                      <p className="rounded-lg border border-border bg-surface px-2 py-1">
                        独立域名：{deepResearchResult.readiness.metrics.uniqueDomainCount}
                      </p>
                      <p className="rounded-lg border border-border bg-surface px-2 py-1">
                        A级来源：{deepResearchResult.readiness.metrics.aGradeSourceCount}
                      </p>
                      <p className="rounded-lg border border-border bg-surface px-2 py-1">
                        合格论点：{deepResearchResult.readiness.metrics.acceptedClusterCount}
                      </p>
                      <p className="rounded-lg border border-border bg-surface px-2 py-1">
                        来源均分：{deepResearchResult.readiness.metrics.avgSourceScore}
                      </p>
                      <p className="rounded-lg border border-border bg-surface px-2 py-1">
                        交叉一致度：
                        {typeof deepResearchResult.readiness.metrics.crossModelAlignment ===
                        "number"
                          ? deepResearchResult.readiness.metrics.crossModelAlignment
                          : "-"}
                      </p>
                    </div>
                    {deepResearchResult.readiness.blockers.length > 0 && (
                      <div className="mt-3">
                        <p className="text-sm font-medium text-risk">阻塞项</p>
                        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-risk">
                          {deepResearchResult.readiness.blockers.map((item, index) => (
                            <li key={`readiness-blocker-${index}`}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {deepResearchResult.readiness.suggestions.length > 0 && (
                      <div className="mt-3">
                        <p className="text-sm font-medium text-foreground">修复建议</p>
                        <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-muted">
                          {deepResearchResult.readiness.suggestions.map((item, index) => (
                            <li key={`readiness-suggestion-${index}`}>{item}</li>
                          ))}
                        </ol>
                      </div>
                    )}
                  </section>

                  <section className="rounded-xl border border-border bg-white p-4">
                    <h3 className="text-sm font-semibold text-brand">岗位画像摘要</h3>
                    <p className="mt-2 text-sm leading-6">
                      {deepResearchResult.profile.roleSummary}
                    </p>
                  </section>

                  <div className="grid gap-4 md:grid-cols-2">
                    <section className="rounded-xl border border-border bg-white p-4">
                      <h3 className="text-sm font-semibold text-brand">核心职责</h3>
                      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
                        {deepResearchResult.profile.coreResponsibilities.map((item, index) => (
                          <li key={`resp-${index}`}>{item}</li>
                        ))}
                      </ol>
                    </section>
                    <section className="rounded-xl border border-border bg-white p-4">
                      <h3 className="text-sm font-semibold text-brand">核心技能</h3>
                      <div className="mt-2 space-y-2 text-sm">
                        {deepResearchResult.profile.coreSkills.map((item, index) => (
                          <article key={`skill-${index}`}>
                            <p className="font-medium">
                              {item.skill}
                              <span className="ml-2 text-xs text-muted">优先级：{item.priority}</span>
                            </p>
                            <p className="text-muted">{item.reason}</p>
                          </article>
                        ))}
                      </div>
                    </section>
                  </div>

                  <section className="rounded-xl border border-border bg-white p-4">
                    <h3 className="text-sm font-semibold text-brand">面试高频主题</h3>
                    <div className="mt-2 space-y-2 text-sm">
                      {deepResearchResult.profile.interviewQuestionThemes.map((item, index) => (
                        <article key={`theme-${index}`}>
                          <p className="font-medium">{index + 1}. {item.theme}</p>
                          <p className="text-muted">为什么重要：{item.whyImportant}</p>
                          {item.sampleQuestions.length > 0 && (
                            <p className="text-muted">示例题：{item.sampleQuestions.join(" / ")}</p>
                          )}
                        </article>
                      ))}
                    </div>
                  </section>

                  <div className="grid gap-4 md:grid-cols-2">
                    <section className="rounded-xl border border-border bg-white p-4">
                      <h3 className="text-sm font-semibold text-brand">市场信号</h3>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                        {deepResearchResult.profile.marketSignals.map((item, index) => (
                          <li key={`market-${index}`}>{item}</li>
                        ))}
                      </ul>
                    </section>
                    <section className="rounded-xl border border-border bg-white p-4">
                      <h3 className="text-sm font-semibold text-brand">风险与盲区</h3>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                        {deepResearchResult.profile.risks.map((item, index) => (
                          <li key={`risk-${index}`}>{item}</li>
                        ))}
                      </ul>
                    </section>
                  </div>

                  <section className="rounded-xl border border-border bg-white p-4">
                    <h3 className="text-sm font-semibold text-brand">行动清单</h3>
                    <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
                      {deepResearchResult.profile.actionPlan.map((item, index) => (
                        <li key={`action-${index}`}>{item}</li>
                      ))}
                    </ol>
                  </section>

                  <details className="rounded-xl border border-border bg-white p-4 text-xs text-muted">
                    <summary className="cursor-pointer font-medium text-foreground">
                      查看来源明细（{deepResearchResult.sources.length} 条）
                    </summary>
                    <div className="mt-3 space-y-2">
                      {deepResearchResult.sources.map((item, index) => (
                        <article key={`${item.url}-${index}`} className="rounded-lg border border-border px-2 py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium text-foreground">
                              [{item.channel}] {item.title}
                            </p>
                            <span
                              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${sourceQualityBadgeClass(item.quality.grade)}`}
                            >
                              {item.quality.grade} / {item.quality.score}
                            </span>
                          </div>
                          <p className="mt-1 text-muted">query: {item.query}</p>
                          <p className="mt-1 text-muted">domain: {item.domain}</p>
                          <p className="mt-1 text-muted">
                            评分原因：{item.quality.reasons.join("；")}
                          </p>
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 inline-block break-all text-brand underline"
                          >
                            {item.url}
                          </a>
                          <p className="mt-1 text-muted">{item.snippet}</p>
                        </article>
                      ))}
                    </div>
                  </details>

                  <button
                    type="button"
                    onClick={onApplyDeepResearchToImport}
                    className="inline-flex w-full items-center justify-center rounded-xl border border-brand px-4 py-2 text-sm font-medium text-brand transition hover:bg-brand hover:text-white"
                  >
                    将此画像一键回填到 B1 导入区
                  </button>
                </div>
              )}
            </div>

            <div className="panel rounded-2xl border border-border bg-surface p-6 shadow-[0_10px_28px_rgba(21,42,61,0.06)]">
              <h2 className="text-lg font-semibold">A0｜内置 PM Demo 经验库（100条/10公司）</h2>
              <p className="mt-1 text-sm text-muted">
                一键加载产品经理面试示例库，适合演示、练习和快速验证策略生成效果。
              </p>
              {seedPmMeta && (
                <div className="mt-3 grid gap-2 text-xs text-muted md:grid-cols-4">
                  <p className="rounded-lg border border-border bg-white px-2 py-1">
                    版本：{seedPmMeta.version}
                  </p>
                  <p className="rounded-lg border border-border bg-white px-2 py-1">
                    岗位：{seedPmMeta.targetRole}
                  </p>
                  <p className="rounded-lg border border-border bg-white px-2 py-1">
                    公司数：{seedPmMeta.companyCount}
                  </p>
                  <p className="rounded-lg border border-border bg-white px-2 py-1">
                    条目数：{seedPmMeta.entryCount}
                  </p>
                </div>
              )}
              {seedPmMeta && seedPmMeta.companies.length > 0 && (
                <p className="mt-2 text-xs text-muted">
                  覆盖公司：{seedPmMeta.companies.join(" / ")}
                </p>
              )}
              {seedPmMeta &&
                Object.keys(seedPmMeta.companyDistribution).length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs text-muted">公司分布：</p>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs">
                      {Object.entries(seedPmMeta.companyDistribution).map(([company, count]) => (
                        <span
                          key={company}
                          className="rounded-full border border-border bg-white px-2 py-1 text-muted"
                        >
                          {company} {count} 条
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              {seedPmMeta &&
                Object.keys(seedPmMeta.roundDistribution).length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs text-muted">轮次分布：</p>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs">
                      {Object.entries(seedPmMeta.roundDistribution).map(([round, count]) => (
                        <span
                          key={round}
                          className="rounded-full border border-border bg-white px-2 py-1 text-muted"
                        >
                          {round} {count} 条
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              {seedPmMeta?.quality && (
                <div className="mt-3 rounded-xl border border-border bg-white p-3">
                  <p className="text-xs font-medium text-foreground">质量体检</p>
                  <div className="mt-2 grid gap-2 text-xs text-muted md:grid-cols-3">
                    <p className="rounded-lg border border-border bg-background px-2 py-1">
                      标准化率：{seedPmMeta.quality.standardizedRate}%
                    </p>
                    <p className="rounded-lg border border-border bg-background px-2 py-1">
                      能力标签均值：{seedPmMeta.quality.avgCapabilityTagsPerEntry}
                    </p>
                    <p className="rounded-lg border border-border bg-background px-2 py-1">
                      能力覆盖度：{seedPmMeta.quality.capabilityCoverageRate}%
                    </p>
                  </div>
                  {Object.keys(seedPmMeta.quality.difficultyDistribution).length > 0 && (
                    <div className="mt-2">
                      <p className="text-xs text-muted">难度分布：</p>
                      <div className="mt-1 flex flex-wrap gap-2 text-xs">
                        {Object.entries(seedPmMeta.quality.difficultyDistribution).map(
                          ([tag, count]) => (
                            <span
                              key={tag}
                              className="rounded-full border border-border bg-background px-2 py-1 text-muted"
                            >
                              {tag.replace("难度:", "")} {count} 条
                            </span>
                          ),
                        )}
                      </div>
                    </div>
                  )}
                  {Object.keys(seedPmMeta.quality.capabilityDistribution).length > 0 && (
                    <div className="mt-2">
                      <p className="text-xs text-muted">能力覆盖（Top 6）：</p>
                      <div className="mt-1 flex flex-wrap gap-2 text-xs">
                        {Object.entries(seedPmMeta.quality.capabilityDistribution)
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 6)
                          .map(([tag, count]) => (
                            <span
                              key={tag}
                              className="rounded-full border border-border bg-background px-2 py-1 text-muted"
                            >
                              {tag.replace("能力:", "")} {count}
                            </span>
                          ))}
                      </div>
                    </div>
                  )}
                  {seedPmMeta.quality.missingCapabilities.length > 0 ? (
                    <p className="mt-2 text-xs text-warn">
                      仍缺能力维度：{seedPmMeta.quality.missingCapabilities.map((item) => item.replace("能力:", "")).join(" / ")}
                    </p>
                  ) : (
                    <p className="mt-2 text-xs text-ok">能力维度已全覆盖。</p>
                  )}
                </div>
              )}
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => void onLoadPmDemoLibrary(false)}
                  disabled={seedPmLoading}
                  className="inline-flex items-center justify-center rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-strong disabled:opacity-50"
                >
                  {seedPmLoading ? "导入中..." : "一键加载 PM Demo 库（推荐）"}
                </button>
                <button
                  type="button"
                  onClick={() => void onLoadPmDemoLibrary(true)}
                  disabled={seedPmLoading}
                  className="inline-flex items-center justify-center rounded-xl border border-border px-4 py-2 text-sm font-medium text-foreground transition hover:bg-background disabled:opacity-50"
                >
                  {seedPmLoading ? "处理中..." : "重置后重载 PM Demo 库"}
                </button>
              </div>
              {seedPmError && (
                <p className="mt-3 rounded-lg border border-risk/30 bg-risk/5 px-3 py-2 text-sm text-risk">
                  {seedPmError}
                </p>
              )}
              {seedPmMessage && (
                <p className="mt-3 rounded-lg border border-ok/30 bg-ok/5 px-3 py-2 text-sm text-ok">
                  {seedPmMessage}
                </p>
              )}
            </div>

            <div className="grid gap-6 md:grid-cols-2">
              <div className="panel rounded-2xl border border-border bg-surface p-6 shadow-[0_10px_28px_rgba(21,42,61,0.06)]">
                <h2 className="text-lg font-semibold">A2｜经验库去重合并</h2>
                <p className="mt-1 text-sm text-muted">
                  自动合并相似问题，减少重复噪声，保留更完整答案。
                </p>
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  <button
                    onClick={() => void onRunDedup(true)}
                    disabled={dedupLoading}
                    className="inline-flex items-center justify-center rounded-xl border border-brand px-4 py-2 text-sm font-medium text-brand transition hover:bg-brand hover:text-white disabled:opacity-50"
                  >
                    {dedupLoading ? "处理中..." : "预览去重结果"}
                  </button>
                  <button
                    onClick={() => void onRunDedup(false)}
                    disabled={dedupLoading}
                    className="inline-flex items-center justify-center rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-strong disabled:opacity-50"
                  >
                    {dedupLoading ? "处理中..." : "执行去重合并"}
                  </button>
                </div>
                {dedupError && (
                  <p className="mt-3 rounded-lg border border-risk/30 bg-risk/5 px-3 py-2 text-sm text-risk">
                    {dedupError}
                  </p>
                )}
                {dedupMessage && (
                  <p className="mt-3 rounded-lg border border-ok/30 bg-ok/5 px-3 py-2 text-sm text-ok">
                    {dedupMessage}
                  </p>
                )}
                {dedupSummary && (
                  <div className="mt-3 rounded-xl border border-border bg-white p-3 text-sm">
                    <p className="text-muted">
                      前后对比：{dedupSummary.beforeCount} → {dedupSummary.afterCount}
                    </p>
                    <p className="text-muted">
                      合并条目：{dedupSummary.mergedCount}，重复组数：{dedupSummary.duplicateGroups}
                    </p>
                    {dedupSummary.samples.length > 0 && (
                      <div className="mt-2 space-y-1 text-xs text-muted">
                        {dedupSummary.samples.map((item, index) => (
                          <p key={`${item.representativeQuestion}-${index}`}>
                            {index + 1}. ({item.size}条) {item.representativeQuestion}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="panel rounded-2xl border border-border bg-surface p-6 shadow-[0_10px_28px_rgba(21,42,61,0.06)]">
                <h2 className="text-lg font-semibold">A3｜图片 OCR 导入</h2>
                <p className="mt-1 text-sm text-muted">
                  上传面经截图（例如小红书/牛客截图），自动提取文本后入库。
                </p>
                <form className="mt-4 space-y-3" onSubmit={onImportImage}>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-sm font-medium">来源类型</span>
                      <select
                        className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                        value={imageForm.provider}
                        onChange={(e) =>
                          setImageForm((prev) => ({
                            ...prev,
                            provider: e.target.value as ResearchProvider,
                          }))
                        }
                      >
                        <option value="other">截图导入</option>
                        <option value="gemini">Gemini</option>
                        <option value="gpt">GPT</option>
                        <option value="doubao">豆包</option>
                        <option value="zhipu">智谱</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-sm font-medium">目标岗位</span>
                      <input
                        className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                        value={imageForm.targetRole}
                        onChange={(e) =>
                          setImageForm((prev) => ({ ...prev, targetRole: e.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-sm font-medium">公司（可选）</span>
                      <input
                        className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                        value={imageForm.company}
                        onChange={(e) =>
                          setImageForm((prev) => ({ ...prev, company: e.target.value }))
                        }
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-sm font-medium">轮次（可选）</span>
                      <input
                        className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                        value={imageForm.round}
                        onChange={(e) =>
                          setImageForm((prev) => ({ ...prev, round: e.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium">来源 URL（可选）</span>
                    <textarea
                      className="min-h-16 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm leading-6 outline-none ring-brand/30 transition focus:ring-2"
                      placeholder="每行一个来源链接"
                      value={imageForm.sourceUrls}
                      onChange={(e) =>
                        setImageForm((prev) => ({ ...prev, sourceUrls: e.target.value }))
                      }
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium">上传图片（&lt;= 5MB）</span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/jpg,image/webp"
                      className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm"
                      onChange={(e) =>
                        setImageForm((prev) => ({
                          ...prev,
                          imageFile: e.target.files?.[0] ?? null,
                        }))
                      }
                    />
                  </label>
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={imageForm.verifySources}
                      onChange={(e) =>
                        setImageForm((prev) => ({
                          ...prev,
                          verifySources: e.target.checked,
                        }))
                      }
                    />
                    启用来源复查
                  </label>
                  <button
                    type="submit"
                    disabled={imageLoading}
                    className="inline-flex w-full items-center justify-center rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-strong disabled:opacity-50"
                  >
                    {imageLoading ? "OCR识别并导入中..." : "上传图片并导入经验库"}
                  </button>
                </form>
                {imageError && (
                  <p className="mt-3 rounded-lg border border-risk/30 bg-risk/5 px-3 py-2 text-sm text-risk">
                    {imageError}
                  </p>
                )}
                {imageMessage && (
                  <p className="mt-3 rounded-lg border border-ok/30 bg-ok/5 px-3 py-2 text-sm text-ok">
                    {imageMessage}
                  </p>
                )}
                {imageStats && (
                  <div className="mt-3 grid gap-2 text-xs text-muted sm:grid-cols-5">
                    <p className="rounded-lg border border-border bg-white px-2 py-1">
                      支持 {imageStats.supported}
                    </p>
                    <p className="rounded-lg border border-border bg-white px-2 py-1">
                      偏弱 {imageStats.weak}
                    </p>
                    <p className="rounded-lg border border-border bg-white px-2 py-1">
                      冲突 {imageStats.conflict}
                    </p>
                    <p className="rounded-lg border border-border bg-white px-2 py-1">
                      待复核 {imageStats.unverified}
                    </p>
                    <p className="rounded-lg border border-border bg-white px-2 py-1">
                      不可达 {imageStats.unreachable}
                    </p>
                  </div>
                )}
                {imagePreview && (
                  <details className="mt-3 rounded-xl border border-border bg-white p-3 text-xs text-muted">
                    <summary className="cursor-pointer font-medium text-foreground">
                      查看 OCR 预览文本（前 800 字）
                    </summary>
                    <pre className="mt-2 whitespace-pre-wrap">{imagePreview}</pre>
                  </details>
                )}
                {imageChecks.length > 0 && (
                  <div className="mt-3 space-y-2 rounded-xl border border-border bg-white p-3 text-xs">
                    {imageChecks.map((item) => (
                      <article key={`image-${item.url}`} className="rounded-md border border-border px-2 py-2">
                        <p className="break-all text-foreground">{item.url}</p>
                        <p className={item.ok ? "text-ok" : "text-risk"}>
                          {item.ok
                            ? `可访问（${item.statusCode ?? "未知"}）`
                            : `不可访问：${item.error ?? "未知错误"}`}
                        </p>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="panel rounded-2xl border border-border bg-surface p-6 shadow-[0_10px_28px_rgba(21,42,61,0.06)]">
              <h2 className="text-lg font-semibold">B1｜网页一键抓取 + 研究结果导入</h2>
              <p className="mt-1 text-sm text-muted">
                优先使用一键抓取；手动粘贴作为兜底。导入后系统会自动抽取经验条目并复查来源。
              </p>
              <div className="mt-4 rounded-xl border border-border bg-white p-4">
                <h3 className="text-sm font-semibold text-brand">B1 全自动 v1（实验）</h3>
                <p className="mt-1 text-xs text-muted">
                  直接输入研究结果页 URL，系统自动打开页面、抽取正文与引用，并自动入库。
                </p>
                <div className="mt-3 grid gap-2 md:grid-cols-[1fr_140px]">
                  <input
                    className="rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                    placeholder="研究结果页 URL（如：https://www.doubao.com/chat/xxx）"
                    value={autoCaptureUrl}
                    onChange={(e) => setAutoCaptureUrl(e.target.value)}
                  />
                  <input
                    type="number"
                    min={800}
                    max={15000}
                    step={100}
                    className="rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                    value={autoCaptureWaitMs}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      if (!Number.isFinite(next)) return;
                      setAutoCaptureWaitMs(Math.max(800, Math.min(15000, Math.round(next))));
                    }}
                  />
                </div>
                <p className="mt-1 text-[11px] text-muted">
                  等待毫秒（右侧输入框）：建议 2500-5000；页面越重可适当提高。
                </p>
                <button
                  type="button"
                  onClick={() => void onAutoCaptureAndImport()}
                  disabled={autoCaptureLoading}
                  className="mt-3 inline-flex items-center justify-center rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-strong disabled:opacity-50"
                >
                  {autoCaptureLoading ? "自动抓取并入库中..." : "一键自动抓取并导入经验库"}
                </button>
                {autoCaptureMessage && (
                  <p className="mt-3 rounded-lg border border-ok/30 bg-ok/5 px-3 py-2 text-sm text-ok">
                    {autoCaptureMessage}
                  </p>
                )}
                {autoCaptureError && (
                  <p className="mt-3 rounded-lg border border-risk/30 bg-risk/5 px-3 py-2 text-sm text-risk">
                    {autoCaptureError}
                  </p>
                )}
              </div>
              <div className="mt-4 rounded-xl border border-border bg-white p-4">
                <h3 className="text-sm font-semibold text-brand">3 步完成一键抓取（B1.1）</h3>
                <div className="mt-2 grid gap-2 text-xs sm:grid-cols-3">
                  <p className="rounded-lg border border-border bg-background px-2 py-1 text-muted">
                    ① 复制脚本：{bookmarkletCopied ? "已完成" : "未完成"}
                  </p>
                  <p className="rounded-lg border border-border bg-background px-2 py-1 text-muted">
                    ② 读取抓取：{captureMeta ? "已完成" : "未完成"}
                  </p>
                  <p className="rounded-lg border border-border bg-background px-2 py-1 text-muted">
                    ③ 导入入库：{researchCount >= 80 ? "可执行" : "待准备"}
                  </p>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void onCopyCaptureBookmarklet()}
                    className="inline-flex items-center justify-center rounded-xl border border-brand px-3 py-1.5 text-xs font-medium text-brand transition hover:bg-brand hover:text-white"
                  >
                    步骤1：复制书签脚本 URL
                  </button>
                  <button
                    type="button"
                    onClick={() => void onReadCaptureFromClipboard()}
                    disabled={captureLoading}
                    className="inline-flex items-center justify-center rounded-xl bg-brand px-3 py-1.5 text-xs font-medium text-white transition hover:bg-brand-strong disabled:opacity-50"
                  >
                    {captureLoading
                      ? "步骤2：读取中..."
                      : "步骤2：读取抓取结果（剪贴板）"}
                  </button>
                </div>
                <p className="mt-2 text-xs text-muted">
                  提示：豆包请先打开右侧“参考资料”栏，再点击书签，才能优先抓到外部文献链接。
                </p>
                <details className="mt-3 rounded-lg border border-border px-3 py-2 text-xs text-muted">
                  <summary className="cursor-pointer font-medium text-foreground">
                    B1.3 公司别名词典配置（影响自动补全）
                  </summary>
                  <div className="mt-3 space-y-3">
                    <p className="text-xs text-muted">
                      你可以维护公司名称与别名映射。保存后，B1.2 会基于这份词典生成公司建议。
                    </p>
                    <div className="grid gap-2 md:grid-cols-[1fr_1.4fr_auto]">
                      <input
                        className="rounded-lg border border-border bg-white px-2 py-1.5 text-xs outline-none"
                        placeholder="公司名称，如：字节跳动"
                        value={aliasDraftCompany}
                        onChange={(e) => setAliasDraftCompany(e.target.value)}
                      />
                      <input
                        className="rounded-lg border border-border bg-white px-2 py-1.5 text-xs outline-none"
                        placeholder="别名，逗号分隔，如：字节, 抖音, 飞书"
                        value={aliasDraftAliases}
                        onChange={(e) => setAliasDraftAliases(e.target.value)}
                      />
                      <button
                        type="button"
                        onClick={onAddCompanyAliasDraft}
                        className="rounded-lg border border-brand px-3 py-1.5 text-xs font-medium text-brand transition hover:bg-brand hover:text-white"
                      >
                        添加
                      </button>
                    </div>

                    {aliasLoading ? (
                      <p>正在加载词典...</p>
                    ) : (
                      <div className="max-h-56 space-y-2 overflow-auto rounded-lg border border-border bg-white p-2">
                        {companyAliasEntries.map((entry, index) => (
                          <div
                            key={`${entry.company}-${index}`}
                            className="grid gap-2 rounded-md border border-border bg-background p-2 md:grid-cols-[0.9fr_1.6fr_auto]"
                          >
                            <input
                              className="rounded-md border border-border bg-white px-2 py-1 text-xs"
                              value={entry.company}
                              onChange={(e) =>
                                onUpdateCompanyAliasCompany(index, e.target.value)
                              }
                            />
                            <input
                              className="rounded-md border border-border bg-white px-2 py-1 text-xs"
                              value={formatAliases(entry.aliases)}
                              onChange={(e) =>
                                onUpdateCompanyAliasAliases(index, e.target.value)
                              }
                            />
                            <button
                              type="button"
                              onClick={() => onRemoveCompanyAliasEntry(index)}
                              className="rounded-md border border-risk/40 px-2 py-1 text-xs text-risk transition hover:bg-risk hover:text-white"
                            >
                              删除
                            </button>
                          </div>
                        ))}
                        {companyAliasEntries.length === 0 && (
                          <p className="text-xs text-muted">词典为空，请先添加至少一条。</p>
                        )}
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void onSaveCompanyAliasDictionary()}
                        disabled={aliasSaving || aliasLoading}
                        className="rounded-lg border border-brand px-3 py-1.5 text-xs font-medium text-brand transition hover:bg-brand hover:text-white disabled:opacity-50"
                      >
                        {aliasSaving ? "保存中..." : "保存词典"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void loadCompanyAliasDictionary()}
                        disabled={aliasSaving || aliasLoading}
                        className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-background disabled:opacity-50"
                      >
                        重新加载
                      </button>
                      <button
                        type="button"
                        onClick={() => void onResetCompanyAliasDictionary()}
                        disabled={aliasSaving}
                        className="rounded-lg border border-warn/50 px-3 py-1.5 text-xs font-medium text-warn transition hover:bg-warn hover:text-white disabled:opacity-50"
                      >
                        恢复默认
                      </button>
                    </div>
                    {aliasMessage && (
                      <p className="rounded-md border border-ok/30 bg-ok/5 px-2 py-1 text-xs text-ok">
                        {aliasMessage}
                      </p>
                    )}
                    {aliasError && (
                      <p className="rounded-md border border-risk/30 bg-risk/5 px-2 py-1 text-xs text-risk">
                        {aliasError}
                      </p>
                    )}
                  </div>
                </details>
                <details className="mt-3 rounded-lg border border-border px-3 py-2 text-xs text-muted">
                  <summary className="cursor-pointer font-medium text-foreground">
                    查看/手动复制书签脚本 URL
                  </summary>
                  <textarea
                    className="mt-2 min-h-20 w-full rounded-lg border border-border bg-background px-2 py-2 text-[11px] leading-5 text-muted"
                    readOnly
                    value={captureBookmarklet}
                  />
                </details>
                {captureMessage && (
                  <p className="mt-3 rounded-lg border border-ok/30 bg-ok/5 px-3 py-2 text-sm text-ok">
                    {captureMessage}
                  </p>
                )}
                {captureError && (
                  <p className="mt-3 rounded-lg border border-risk/30 bg-risk/5 px-3 py-2 text-sm text-risk">
                    {captureError}
                  </p>
                )}
                {captureMeta && (
                  <div className="mt-3 space-y-3 rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted">
                    <div className="grid gap-2 md:grid-cols-2">
                    <p>页面标题：{captureMeta.pageTitle}</p>
                    <p>识别来源：{captureMeta.providerHint}</p>
                      <p>
                        字数变化：{captureMeta.rawCharCount} → {captureMeta.cleanedCharCount}
                      </p>
                      <p>去噪行数：{captureMeta.removedLineCount}</p>
                    <p>来源链接：{captureMeta.sourceUrlCount}</p>
                      <p className={captureMeta.citationReady ? "text-ok" : "text-risk"}>
                        文献外链：{captureMeta.citationReady ? "已提取" : "未提取"}
                      </p>
                    <p>
                      抓取时间：
                      {new Date(captureMeta.capturedAt).toLocaleString("zh-CN", {
                        hour12: false,
                      })}
                    </p>
                    {captureMeta.pageUrl && (
                      <p className="break-all">页面地址：{captureMeta.pageUrl}</p>
                    )}
                    </div>
                    {captureSuggestion && (
                      <div className="rounded-lg border border-border bg-white px-3 py-2 text-xs text-muted">
                        <p className="font-medium text-foreground">
                          B1.2 自动补全建议（置信度：{suggestionConfidenceLabel(captureSuggestion.confidence)}）
                        </p>
                        <div className="mt-2 space-y-2">
                          <div>
                            <p className="mb-1">岗位建议：</p>
                            <div className="flex flex-wrap gap-2">
                              {captureSuggestion.targetRoleSuggestions.map((role) => (
                                <button
                                  key={`role-${role}`}
                                  type="button"
                                  onClick={() => onApplyCaptureSuggestion("targetRole", role)}
                                  className="rounded-full border border-brand/40 bg-brand/5 px-2 py-0.5 text-xs text-brand hover:bg-brand hover:text-white"
                                >
                                  {role}
                                </button>
                              ))}
                              {captureSuggestion.targetRoleSuggestions.length === 0 && (
                                <span>未识别到岗位建议</span>
                              )}
                            </div>
                          </div>
                          <div>
                            <p className="mb-1">公司建议：</p>
                            <div className="flex flex-wrap gap-2">
                              {captureSuggestion.companySuggestions.map((company) => (
                                <button
                                  key={`company-${company}`}
                                  type="button"
                                  onClick={() => onApplyCaptureSuggestion("company", company)}
                                  className="rounded-full border border-border bg-background px-2 py-0.5 text-xs text-foreground hover:bg-foreground hover:text-white"
                                >
                                  {company}
                                </button>
                              ))}
                              {captureSuggestion.companySuggestions.length === 0 && (
                                <span>未识别到公司建议</span>
                              )}
                            </div>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={onApplyAllCaptureSuggestions}
                          className="mt-2 rounded-lg border border-brand px-2.5 py-1 text-xs font-medium text-brand transition hover:bg-brand hover:text-white"
                        >
                          一键应用建议
                        </button>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => onApplyCapturedText("cleaned")}
                        className="inline-flex items-center justify-center rounded-xl border border-brand px-3 py-1.5 text-xs font-medium text-brand transition hover:bg-brand hover:text-white"
                      >
                        使用清洗文本
                      </button>
                      <button
                        type="button"
                        onClick={() => onApplyCapturedText("raw")}
                        className="inline-flex items-center justify-center rounded-xl border border-border px-3 py-1.5 text-xs font-medium text-muted transition hover:bg-white hover:text-foreground"
                      >
                        使用原始文本
                      </button>
                    </div>
                    {captureCleanText && (
                      <details className="rounded-lg border border-border bg-white p-2">
                        <summary className="cursor-pointer font-medium text-foreground">
                          清洗后预览（前 1200 字）
                        </summary>
                        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-xs text-muted">
                          {captureCleanText.slice(0, 1200)}
                        </pre>
                      </details>
                    )}
                    {captureRawText && (
                      <details className="rounded-lg border border-border bg-white p-2">
                        <summary className="cursor-pointer font-medium text-foreground">
                          原始抓取预览（前 1200 字）
                        </summary>
                        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-xs text-muted">
                          {captureRawText.slice(0, 1200)}
                        </pre>
                      </details>
                    )}
                  </div>
                )}
              </div>
              <form className="mt-4 grid gap-3 md:grid-cols-2" onSubmit={onImportResearch}>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">研究来源</span>
                  <select
                    className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                    value={researchForm.provider}
                    onChange={(e) =>
                      setResearchForm((prev) => ({
                        ...prev,
                        provider: e.target.value as ResearchProvider,
                      }))
                    }
                  >
                    <option value="gemini">Gemini</option>
                    <option value="gpt">GPT</option>
                    <option value="doubao">豆包</option>
                    <option value="zhipu">智谱</option>
                    <option value="other">其他</option>
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">目标岗位</span>
                  <input
                    className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                    value={researchForm.targetRole}
                    onChange={(e) =>
                      setResearchForm((prev) => ({
                        ...prev,
                        targetRole: e.target.value,
                      }))
                    }
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">目标公司（可选）</span>
                  <input
                    className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                    value={researchForm.company}
                    onChange={(e) =>
                      setResearchForm((prev) => ({
                        ...prev,
                        company: e.target.value,
                      }))
                    }
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">面试轮次（可选）</span>
                  <input
                    className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                    value={researchForm.round}
                    onChange={(e) =>
                      setResearchForm((prev) => ({
                        ...prev,
                        round: e.target.value,
                      }))
                    }
                  />
                </label>
                <label className="block md:col-span-2">
                  <span className="mb-1 block text-sm font-medium">
                    来源 URL（每行一个，支持 8 条）
                  </span>
                  <textarea
                    className="min-h-24 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm leading-6 outline-none ring-brand/30 transition focus:ring-2"
                    placeholder="https://..."
                    value={researchForm.sourceUrls}
                    onChange={(e) =>
                      setResearchForm((prev) => ({
                        ...prev,
                        sourceUrls: e.target.value,
                      }))
                    }
                  />
                </label>
                <label className="block md:col-span-2">
                  <span className="mb-1 block text-sm font-medium">
                    Deep Research 报告文本
                  </span>
                  <textarea
                    className="min-h-48 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm leading-6 outline-none ring-brand/30 transition focus:ring-2"
                    placeholder="粘贴研究摘要、关键问题、建议回答和引用来源..."
                    value={researchForm.reportText}
                    onChange={(e) =>
                      setResearchForm((prev) => ({
                        ...prev,
                        reportText: e.target.value,
                      }))
                    }
                  />
                  <div className="mt-1 text-xs text-muted">
                    当前 {researchCount} 字，建议至少 200 字。
                  </div>
                </label>
                <label className="inline-flex items-center gap-2 text-sm md:col-span-2">
                  <input
                    type="checkbox"
                    checked={researchForm.verifySources}
                    onChange={(e) =>
                      setResearchForm((prev) => ({
                        ...prev,
                        verifySources: e.target.checked,
                      }))
                    }
                  />
                  启用来源复查（自动读取来源网页做交叉验证）
                </label>
                <div className="md:col-span-2">
                  <button
                    type="submit"
                    disabled={researchLoading || researchCount < 80}
                    className="inline-flex w-full items-center justify-center rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {researchLoading
                      ? "正在导入并复查来源..."
                      : "导入研究结果到经验库"}
                  </button>
                </div>
              </form>

              {researchError && (
                <p className="mt-3 rounded-lg border border-risk/30 bg-risk/5 px-3 py-2 text-sm text-risk">
                  {researchError}
                </p>
              )}
              {researchMessage && (
                <p className="mt-3 rounded-lg border border-ok/30 bg-ok/5 px-3 py-2 text-sm text-ok">
                  {researchMessage}
                </p>
              )}
              {researchStats && (
                <div className="mt-3 grid gap-2 text-xs text-muted md:grid-cols-5">
                  <p className="rounded-lg border border-border bg-white px-2 py-1">
                    证据支持：{researchStats.supported}
                  </p>
                  <p className="rounded-lg border border-border bg-white px-2 py-1">
                    证据偏弱：{researchStats.weak}
                  </p>
                  <p className="rounded-lg border border-border bg-white px-2 py-1">
                    冲突：{researchStats.conflict}
                  </p>
                  <p className="rounded-lg border border-border bg-white px-2 py-1">
                    待复核：{researchStats.unverified}
                  </p>
                  <p className="rounded-lg border border-border bg-white px-2 py-1">
                    不可达：{researchStats.unreachable}
                  </p>
                </div>
              )}
              {researchChecks.length > 0 && (
                <div className="mt-3 space-y-2 rounded-xl border border-border bg-white p-3 text-xs">
                  <p className="font-medium text-foreground">来源复查详情</p>
                  {researchChecks.map((item) => (
                    <article key={item.url} className="rounded-md border border-border px-2 py-2">
                      <p className="break-all text-foreground">{item.url}</p>
                      <p className={item.ok ? "text-ok" : "text-risk"}>
                        {item.ok
                          ? `可访问（${item.statusCode ?? "未知"}）`
                          : `不可访问：${item.error ?? "未知错误"}`}
                      </p>
                      {item.title && <p className="text-muted">标题：{item.title}</p>}
                    </article>
                  ))}
                </div>
              )}
            </div>

            <div className="grid gap-6 md:grid-cols-[1fr_1.1fr]">
              <div className="panel rounded-2xl border border-border bg-surface p-6 shadow-[0_10px_28px_rgba(21,42,61,0.06)]">
                <h2 className="text-lg font-semibold">新增经验到库</h2>
                <p className="mt-1 text-sm text-muted">
                  支持录入本人经历或他人面经，统一积累成可检索知识库。
                </p>
                <form className="mt-4 space-y-3" onSubmit={onSubmitLibraryEntry}>
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium">来源</span>
                    <select
                      className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                      value={libraryForm.source}
                      onChange={(e) =>
                        setLibraryForm((prev) => ({
                          ...prev,
                          source: e.target.value as LibrarySource,
                        }))
                      }
                    >
                      <option value="self">本人经历</option>
                      <option value="community">他人面经</option>
                      <option value="other">其他来源</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium">目标岗位</span>
                    <input
                      className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                      value={libraryForm.targetRole}
                      onChange={(e) =>
                        setLibraryForm((prev) => ({ ...prev, targetRole: e.target.value }))
                      }
                    />
                  </label>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-sm font-medium">公司</span>
                      <input
                        className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                        value={libraryForm.company}
                        onChange={(e) =>
                          setLibraryForm((prev) => ({ ...prev, company: e.target.value }))
                        }
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-sm font-medium">轮次</span>
                      <input
                        className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                        value={libraryForm.round}
                        onChange={(e) =>
                          setLibraryForm((prev) => ({ ...prev, round: e.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium">问题</span>
                    <textarea
                      className="min-h-20 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm leading-6 outline-none ring-brand/30 transition focus:ring-2"
                      value={libraryForm.question}
                      onChange={(e) =>
                        setLibraryForm((prev) => ({ ...prev, question: e.target.value }))
                      }
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium">常见坑点</span>
                    <textarea
                      className="min-h-20 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm leading-6 outline-none ring-brand/30 transition focus:ring-2"
                      value={libraryForm.pitfall}
                      onChange={(e) =>
                        setLibraryForm((prev) => ({ ...prev, pitfall: e.target.value }))
                      }
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium">推荐回答策略</span>
                    <textarea
                      className="min-h-20 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm leading-6 outline-none ring-brand/30 transition focus:ring-2"
                      value={libraryForm.betterAnswer}
                      onChange={(e) =>
                        setLibraryForm((prev) => ({ ...prev, betterAnswer: e.target.value }))
                      }
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium">标签（逗号分隔）</span>
                    <input
                      className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                      placeholder="例如：指标体系, 留存, AI Copilot"
                      value={libraryForm.tags}
                      onChange={(e) =>
                        setLibraryForm((prev) => ({ ...prev, tags: e.target.value }))
                      }
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={entryLoading}
                    className="inline-flex w-full items-center justify-center rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-strong disabled:opacity-50"
                  >
                    {entryLoading ? "正在入库..." : "保存到经验库"}
                  </button>
                  {entryMessage && <p className="text-sm text-ok">{entryMessage}</p>}
                  {entryError && <p className="text-sm text-risk">{entryError}</p>}
                </form>
              </div>

              <div className="panel rounded-2xl border border-border bg-surface p-6 shadow-[0_10px_28px_rgba(21,42,61,0.06)]">
                <h2 className="text-lg font-semibold">面试前策略生成</h2>
                <p className="mt-1 text-sm text-muted">
                  检索经验库并融合，生成面试前优先准备清单。
                </p>
                <form className="mt-4 space-y-3" onSubmit={onGeneratePrep}>
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium">目标岗位</span>
                    <input
                      className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                      value={prepForm.targetRole}
                      onChange={(e) =>
                        setPrepForm((prev) => ({ ...prev, targetRole: e.target.value }))
                      }
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium">目标公司（可选）</span>
                    <input
                      className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm outline-none ring-brand/30 transition focus:ring-2"
                      value={prepForm.company}
                      onChange={(e) =>
                        setPrepForm((prev) => ({ ...prev, company: e.target.value }))
                      }
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium">
                      关注点（可选）
                    </span>
                    <textarea
                      className="min-h-24 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm leading-6 outline-none ring-brand/30 transition focus:ring-2"
                      placeholder="例如：指标拆解、A/B 实验、模型质量排查"
                      value={prepForm.focus}
                      onChange={(e) =>
                        setPrepForm((prev) => ({ ...prev, focus: e.target.value }))
                      }
                    />
                  </label>
                  <div className="rounded-xl border border-border bg-white p-3">
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={prepForm.qualityGateEnabled}
                        onChange={(e) =>
                          setPrepForm((prev) => ({
                            ...prev,
                            qualityGateEnabled: e.target.checked,
                          }))
                        }
                      />
                      启用质量门槛开关（低于阈值先给“补证据动作”，不直接放行正式策略）
                    </label>
                    <div className="mt-2 flex items-center gap-2 text-xs text-muted">
                      <span>门槛阈值：</span>
                      <input
                        type="number"
                        min={40}
                        max={90}
                        step={1}
                        disabled={!prepForm.qualityGateEnabled}
                        className="w-24 rounded-lg border border-border bg-background px-2 py-1 text-xs outline-none ring-brand/30 transition focus:ring-2 disabled:opacity-50"
                        value={prepForm.qualityGateThreshold}
                        onChange={(e) => {
                          const next = Number(e.target.value);
                          if (!Number.isFinite(next)) return;
                          setPrepForm((prev) => ({
                            ...prev,
                            qualityGateThreshold: Math.max(
                              40,
                              Math.min(90, Math.round(next)),
                            ),
                          }));
                        }}
                      />
                      <span>（40-90，推荐 60）</span>
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={prepLoading}
                    className="inline-flex w-full items-center justify-center rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-strong disabled:opacity-50"
                  >
                    {prepLoading ? "正在融合经验库..." : "生成面试前准备策略"}
                  </button>
                </form>

                {prepError && (
                  <p className="mt-3 rounded-lg border border-risk/30 bg-risk/5 px-3 py-2 text-sm text-risk">
                    {prepError}
                  </p>
                )}
                {prepWarning && (
                  <p className="mt-3 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-sm text-warn">
                    {prepWarning}
                  </p>
                )}

                {prepPlan && (
                  <div className="mt-4 space-y-4">
                    <section className="rounded-xl border border-border bg-white p-4">
                      <h3 className="text-sm font-semibold text-brand">策略质量体检</h3>
                      <div className="mt-2 grid gap-2 text-xs text-muted md:grid-cols-4">
                        <p className="rounded-lg border border-border bg-background px-2 py-1">
                          证据得分：{prepPlan.quality.evidenceScore}
                        </p>
                        <p className="rounded-lg border border-border bg-background px-2 py-1">
                          质量等级：{prepPlan.quality.qualityLevel}
                        </p>
                        <p className="rounded-lg border border-border bg-background px-2 py-1">
                          平均置信度：{prepPlan.quality.avgConfidence}
                        </p>
                        <p className="rounded-lg border border-border bg-background px-2 py-1">
                          命中条目：{prepPlan.quality.matchedCount}
                        </p>
                      </div>
                      <div className="mt-2 grid gap-2 text-xs text-muted md:grid-cols-3">
                        <p className="rounded-lg border border-border bg-background px-2 py-1">
                          门槛开关：{prepPlan.quality.gateEnabled ? "开启" : "关闭"}
                        </p>
                        <p className="rounded-lg border border-border bg-background px-2 py-1">
                          阈值：{prepPlan.quality.gateThreshold}
                        </p>
                        <p
                          className={`rounded-lg border px-2 py-1 ${
                            prepPlan.quality.gatePassed
                              ? "border-ok/30 bg-ok/5 text-ok"
                              : "border-risk/30 bg-risk/5 text-risk"
                          }`}
                        >
                          门槛状态：{prepPlan.quality.gatePassed ? "通过" : "未通过"}
                        </p>
                      </div>
                      {!prepPlan.quality.gatePassed && prepPlan.quality.gateReason && (
                        <p className="mt-2 text-xs text-risk">
                          未通过原因：{prepPlan.quality.gateReason}
                        </p>
                      )}
                      <div className="mt-2 grid gap-2 text-xs text-muted md:grid-cols-5">
                        <p className="rounded-lg border border-border bg-background px-2 py-1">
                          支持：{prepPlan.quality.supportedCount}
                        </p>
                        <p className="rounded-lg border border-border bg-background px-2 py-1">
                          偏弱：{prepPlan.quality.weakCount}
                        </p>
                        <p className="rounded-lg border border-border bg-background px-2 py-1">
                          冲突：{prepPlan.quality.conflictCount}
                        </p>
                        <p className="rounded-lg border border-border bg-background px-2 py-1">
                          待复核：{prepPlan.quality.unverifiedCount}
                        </p>
                        <p className="rounded-lg border border-border bg-background px-2 py-1">
                          不可达：{prepPlan.quality.unreachableCount}
                        </p>
                      </div>
                      <p className="mt-2 text-xs text-muted">
                        来源结构：本人 {prepPlan.quality.sourceDiversity.self} / 他人面经{" "}
                        {prepPlan.quality.sourceDiversity.community} / 其他{" "}
                        {prepPlan.quality.sourceDiversity.other}
                      </p>
                      {prepPlan.quality.riskTips.length > 0 && (
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-warn">
                          {prepPlan.quality.riskTips.map((item, index) => (
                            <li key={`quality-risk-${index}`}>{item}</li>
                          ))}
                        </ul>
                      )}
                    </section>
                    <section className="rounded-xl border border-border bg-white p-4">
                      <h3 className="text-sm font-semibold text-brand">策略摘要</h3>
                      <p className="mt-1 text-xs text-muted">
                        每条策略下方的“证据”可点击：优先跳转原始来源链接；无外链时定位到下方经验库条目。
                      </p>
                      <p className="mt-2 text-sm leading-6">{prepPlan.strategySummary}</p>
                      {renderPrepSourceRefs(prepPlan.traceability?.summaryRefs)}
                    </section>
                    <section className="rounded-xl border border-border bg-white p-4">
                      <h3 className="text-sm font-semibold text-brand">高概率问题与应答</h3>
                      <div className="mt-2 space-y-2">
                        {prepPlan.likelyQuestions.map((item, index) => (
                          <article key={`${item.question}-${index}`} className="text-sm">
                            <p className="font-medium">{index + 1}. {item.question}</p>
                            <p className="text-muted">为什么会问：{item.whyLikely}</p>
                            <p className="text-muted">答题策略：{item.howToAnswer}</p>
                            {renderPrepSourceRefs(prepPlan.traceability?.questionRefs?.[index])}
                          </article>
                        ))}
                      </div>
                    </section>
                    <section className="rounded-xl border border-border bg-white p-4">
                      <h3 className="text-sm font-semibold text-brand">风险提醒</h3>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                        {prepPlan.redFlags.map((item, index) => (
                          <li key={`${item}-${index}`}>
                            <p>{item}</p>
                            {renderPrepSourceRefs(prepPlan.traceability?.redFlagRefs?.[index])}
                          </li>
                        ))}
                      </ul>
                    </section>
                    <section className="rounded-xl border border-border bg-white p-4">
                      <h3 className="text-sm font-semibold text-brand">行动清单</h3>
                      <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
                        {prepPlan.actionChecklist.map((item, index) => (
                          <li key={`${item}-${index}`}>
                            <p>{item}</p>
                            {renderPrepSourceRefs(prepPlan.traceability?.actionRefs?.[index])}
                          </li>
                        ))}
                      </ol>
                    </section>
                  </div>
                )}
              </div>
            </div>

            <div className="panel rounded-2xl border border-border bg-surface p-6 shadow-[0_10px_28px_rgba(21,42,61,0.06)]">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">经验库条目（最新 30 条）</h2>
                <button
                  onClick={() => void refreshEntries()}
                  className="rounded-lg border border-border px-3 py-1 text-sm text-foreground hover:bg-background"
                >
                  刷新
                </button>
              </div>
              {entriesLoading ? (
                <p className="mt-3 text-sm text-muted">正在加载经验库...</p>
              ) : entries.length === 0 ? (
                <p className="mt-3 text-sm text-muted">经验库为空，先录入 3-5 条再生成策略。</p>
              ) : (
                <div className="mt-3 grid gap-3">
                  {entries.map((entry) => (
                    <article
                      key={entry.id}
                      id={`entry-${entry.id}`}
                      className="rounded-xl border border-border bg-white p-4 text-sm"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-md bg-background px-2 py-0.5 text-xs text-muted">
                          {sourceLabel(entry.source)}
                        </span>
                        <span className="rounded-md bg-background px-2 py-0.5 text-xs text-muted">
                          {entry.targetRole}
                        </span>
                        <span
                          className={`rounded-md bg-background px-2 py-0.5 text-xs ${verificationColor(entry.verificationStatus)}`}
                        >
                          {verificationLabel(entry.verificationStatus)}
                        </span>
                        {entry.company && (
                          <span className="rounded-md bg-background px-2 py-0.5 text-xs text-muted">
                            {entry.company}
                          </span>
                        )}
                        {entry.round && (
                          <span className="rounded-md bg-background px-2 py-0.5 text-xs text-muted">
                            {entry.round}
                          </span>
                        )}
                      </div>
                      <p className="mt-2 font-medium">Q: {entry.question}</p>
                      <p className="mt-1 text-muted">坑点：{entry.pitfall}</p>
                      <p className="mt-1 text-muted">建议：{entry.betterAnswer}</p>
                      {entry.evidenceNote && (
                        <p className="mt-1 text-xs text-muted">复查备注：{entry.evidenceNote}</p>
                      )}
                      {typeof entry.confidence === "number" && (
                        <p className="mt-1 text-xs text-muted">
                          复查置信度：{Math.round(entry.confidence * 100)}%
                        </p>
                      )}
                      {entry.sourceUrl && (
                        <p className="mt-1 text-xs">
                          来源：
                          <a
                            href={entry.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="ml-1 break-all text-brand underline"
                          >
                            {entry.sourceUrl}
                          </a>
                        </p>
                      )}
                      {entry.tags.length > 0 && (
                        <p className="mt-1 text-xs text-muted">
                          标签：{entry.tags.join(" / ")}
                        </p>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
