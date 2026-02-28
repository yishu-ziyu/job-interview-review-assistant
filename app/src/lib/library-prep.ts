import { callLlm } from "@/lib/llm";
import type {
  LibraryEntry,
  PrepPlan,
  PrepQuality,
  PrepQuestion,
  PrepRequest,
  PrepSourceRef,
  PrepTraceability,
  VerificationStatus,
} from "@/lib/types";

type ScoredEntry = {
  entry: LibraryEntry;
  score: number;
};

type QualityGateConfig = {
  enabled: boolean;
  threshold: number;
};

const DEFAULT_GATE_THRESHOLD = 60;
const MIN_GATE_THRESHOLD = 40;
const MAX_GATE_THRESHOLD = 90;

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function tokenize(value: string | undefined): string[] {
  return normalize(value)
    .split(/[\s,，。；;、|/]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function scoreEntry(entry: LibraryEntry, request: PrepRequest): number {
  const role = normalize(request.targetRole);
  const company = normalize(request.company);
  const focusTokens = tokenize(request.focus);
  const content = [
    entry.targetRole,
    entry.company ?? "",
    entry.round ?? "",
    entry.question,
    entry.pitfall,
    entry.betterAnswer,
    entry.tags.join(" "),
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  const entryRole = normalize(entry.targetRole);
  const entryCompany = normalize(entry.company);

  if (role && (entryRole.includes(role) || role.includes(entryRole))) score += 6;
  if (company && entryCompany && entryCompany.includes(company)) score += 4;

  for (const token of focusTokens) {
    if (content.includes(token)) score += 1;
  }

  const verificationWeight = scoreByVerification(entry.verificationStatus);
  const confidenceWeight = confidenceValue(entry) * 1.4;
  const recency = recencyBonus(entry.createdAt);

  score += verificationWeight + confidenceWeight + recency;
  if (entry.source === "self") score += 0.2;
  return score;
}

function scoreByVerification(status: VerificationStatus | undefined): number {
  if (status === "supported") return 2.2;
  if (status === "weak") return 1.1;
  if (status === "unverified") return 0.35;
  if (status === "unreachable") return -0.2;
  if (status === "conflict") return -1.2;
  return 0.3;
}

function confidenceValue(entry: LibraryEntry): number {
  if (typeof entry.confidence !== "number" || !Number.isFinite(entry.confidence)) {
    return 0.5;
  }
  if (entry.confidence < 0) return 0;
  if (entry.confidence > 1) return 1;
  return entry.confidence;
}

function recencyBonus(createdAt: string): number {
  const ts = Date.parse(createdAt);
  if (!Number.isFinite(ts)) return 0;
  const days = (Date.now() - ts) / (1000 * 60 * 60 * 24);
  if (days <= 14) return 0.4;
  if (days <= 60) return 0.2;
  return 0;
}

function toFixed(value: number, digits = 1): number {
  return Number(value.toFixed(digits));
}

function normalizeGateConfig(request: PrepRequest): QualityGateConfig {
  const enabled = request.qualityGateEnabled === true;
  const thresholdRaw = request.qualityGateThreshold;
  if (typeof thresholdRaw !== "number" || !Number.isFinite(thresholdRaw)) {
    return {
      enabled,
      threshold: DEFAULT_GATE_THRESHOLD,
    };
  }
  return {
    enabled,
    threshold: Math.max(MIN_GATE_THRESHOLD, Math.min(MAX_GATE_THRESHOLD, Math.round(thresholdRaw))),
  };
}

function buildPrepQuality(
  matchedEntries: LibraryEntry[],
  gateConfig: QualityGateConfig,
): PrepQuality {
  const total = matchedEntries.length;
  const status = {
    supported: 0,
    weak: 0,
    conflict: 0,
    unverified: 0,
    unreachable: 0,
  };
  const source = {
    self: 0,
    community: 0,
    other: 0,
  };

  let confidenceTotal = 0;
  for (const entry of matchedEntries) {
    const verification = entry.verificationStatus ?? "unverified";
    if (verification === "supported") status.supported += 1;
    else if (verification === "weak") status.weak += 1;
    else if (verification === "conflict") status.conflict += 1;
    else if (verification === "unreachable") status.unreachable += 1;
    else status.unverified += 1;

    if (entry.source === "self") source.self += 1;
    else if (entry.source === "community") source.community += 1;
    else source.other += 1;

    confidenceTotal += confidenceValue(entry);
  }

  const avgConfidence = total > 0 ? toFixed(confidenceTotal / total, 2) : 0;
  const weightedStatus =
    total > 0
      ? (status.supported * 1 +
          status.weak * 0.65 +
          status.unverified * 0.4 +
          status.unreachable * 0.18 +
          status.conflict * 0.05) /
        total
      : 0;
  const activeSourceKinds =
    Number(source.self > 0) + Number(source.community > 0) + Number(source.other > 0);
  const sourceDiversityScore = (activeSourceKinds / 3) * 100;
  const evidenceScore = toFixed(
    weightedStatus * 100 * 0.62 + avgConfidence * 100 * 0.25 + sourceDiversityScore * 0.13,
    1,
  );
  const qualityLevel: "高" | "中" | "低" =
    evidenceScore >= 75 ? "高" : evidenceScore >= 55 ? "中" : "低";

  const gateFailedByScore = gateConfig.enabled && evidenceScore < gateConfig.threshold;
  const gateFailedByConflict = gateConfig.enabled && status.conflict > 0;
  const gatePassed = gateConfig.enabled
    ? !gateFailedByScore && !gateFailedByConflict
    : true;
  const gateReason = gateFailedByScore
    ? `证据得分 ${evidenceScore} 低于门槛 ${gateConfig.threshold}`
    : gateFailedByConflict
      ? `命中条目存在 ${status.conflict} 条证据冲突`
      : undefined;

  const riskTips: string[] = [];
  if (total <= 3) riskTips.push("命中样本偏少，建议至少补到 8 条同岗位条目。");
  if (status.supported === 0) riskTips.push("当前命中条目缺少“证据支持”项，建议先做来源复查。");
  if (status.conflict > 0) riskTips.push("存在证据冲突条目，建议先人工仲裁再作为主策略依据。");
  if (avgConfidence < 0.58) riskTips.push("条目平均置信度偏低，建议补充高质量来源。");
  if (source.community + source.other === 0) {
    riskTips.push("来源结构单一（仅本人经验），建议补充外部面经做交叉验证。");
  }

  return {
    matchedCount: total,
    supportedCount: status.supported,
    weakCount: status.weak,
    conflictCount: status.conflict,
    unverifiedCount: status.unverified,
    unreachableCount: status.unreachable,
    avgConfidence,
    evidenceScore,
    qualityLevel,
    sourceDiversity: source,
    gateEnabled: gateConfig.enabled,
    gateThreshold: gateConfig.threshold,
    gatePassed,
    gateReason,
    riskTips: riskTips.slice(0, 5),
  };
}

export function retrieveLibraryEntries(
  allEntries: LibraryEntry[],
  request: PrepRequest,
): LibraryEntry[] {
  const topK = Math.min(Math.max(request.topK ?? 8, 3), 20);
  const scored: ScoredEntry[] = allEntries
    .map((entry) => ({
      entry,
      score: scoreEntry(entry, request),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.createdAt.localeCompare(a.entry.createdAt));

  if (scored.length > 0) {
    return scored.slice(0, topK).map((item) => item.entry);
  }

  return allEntries
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, topK);
}

function fallbackPlan(
  request: PrepRequest,
  matchedEntries: LibraryEntry[],
  quality: PrepQuality,
): PrepPlan {
  const likelyQuestions: PrepQuestion[] = matchedEntries.slice(0, 5).map((entry) => ({
    question: entry.question,
    whyLikely: `该问题在经验库中多次出现，且与目标岗位「${request.targetRole}」相关。`,
    howToAnswer: entry.betterAnswer,
  }));

  const redFlags = matchedEntries
    .slice(0, 5)
    .map((entry) => entry.pitfall)
    .filter((item) => item.length > 0);

  const actionChecklist = [
    "将高频问题按 STAR 结构写出 90 秒口述版答案。",
    "对每个问题准备一条可量化结果（指标/增长/效率）。",
    "对每条经验补充一个反例与修正动作，避免面试中被追问卡住。",
  ];

  return {
    strategySummary:
      matchedEntries.length > 0
        ? `已基于经验库命中 ${matchedEntries.length} 条相关面经，建议优先准备高频问题与薄弱项。`
        : "经验库暂无匹配条目，建议先补充 5-10 条同岗位面经后再生成策略。",
    likelyQuestions,
    redFlags,
    actionChecklist,
    matchedEntries,
    quality,
  };
}

function buildGateRecoveryChecklist(quality: PrepQuality): string[] {
  const actions: string[] = [];
  if (quality.supportedCount < 5) {
    actions.push("补齐至少 5 条“证据支持（supported）”条目，再重新生成策略。");
  }
  if (quality.conflictCount > 0) {
    actions.push("逐条处理冲突项：核对来源并手动保留可信版本。");
  }
  if (quality.sourceDiversity.community + quality.sourceDiversity.other < 3) {
    actions.push("补充外部面经/公开资料，避免来源单一。");
  }
  if (quality.avgConfidence < 0.6) {
    actions.push("优先替换低置信度条目（confidence < 0.6）。");
  }
  actions.push("完成以上动作后，再点击“生成面试前准备策略”。");
  return Array.from(new Set(actions)).slice(0, 6);
}

function mergeWarning(base: string | undefined, extra: string | undefined): string | undefined {
  if (!base && !extra) return undefined;
  if (!base) return extra;
  if (!extra) return base;
  return `${base} ${extra}`;
}

function extractTraceTerms(value: string): string[] {
  const text = value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!text) return [];
  const chunks = text.match(/[\u4e00-\u9fa5a-z0-9]{2,}/gi) ?? [];
  const terms: string[] = [];
  for (const chunk of chunks) {
    terms.push(chunk);
    const isChinese = /[\u4e00-\u9fa5]/.test(chunk);
    if (isChinese && chunk.length >= 4) {
      for (let size = 2; size <= 4; size += 1) {
        if (chunk.length <= size) continue;
        for (let index = 0; index <= chunk.length - size; index += 1) {
          terms.push(chunk.slice(index, index + size));
          if (terms.length >= 48) break;
        }
        if (terms.length >= 48) break;
      }
    }
    if (terms.length >= 48) break;
  }
  return Array.from(new Set(terms)).slice(0, 48);
}

function scoreTraceMatch(statement: string, entry: LibraryEntry): number {
  const terms = extractTraceTerms(statement);
  if (terms.length === 0) return 0;
  const content = [
    entry.targetRole,
    entry.company ?? "",
    entry.round ?? "",
    entry.question,
    entry.pitfall,
    entry.betterAnswer,
    entry.tags.join(" "),
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (content.includes(term)) score += 1;
  }
  if (entry.company && statement.includes(entry.company)) score += 2;
  if (entry.round && statement.includes(entry.round)) score += 1;
  if (entry.verificationStatus === "supported") score += 0.8;
  if (entry.verificationStatus === "conflict") score -= 0.6;
  score += confidenceValue(entry) * 0.5;
  return score;
}

function toSourceRef(entry: LibraryEntry, rank: number): PrepSourceRef {
  const head = `${entry.company ?? entry.targetRole}${entry.round ? `-${entry.round}` : ""}`;
  return {
    entryId: entry.id,
    rank,
    label: `证据#${rank} ${head}`,
    sourceUrl: entry.sourceUrl,
    source: entry.source,
    company: entry.company,
    round: entry.round,
    verificationStatus: entry.verificationStatus,
    confidence: entry.confidence,
  };
}

function selectSourceRefsForText(
  text: string,
  matchedEntries: LibraryEntry[],
  maxCount = 3,
): PrepSourceRef[] {
  if (!text.trim() || matchedEntries.length === 0) return [];
  const scored = matchedEntries
    .map((entry, index) => ({
      entry,
      rank: index + 1,
      score: scoreTraceMatch(text, entry),
    }))
    .sort((left, right) => right.score - left.score);

  const selected = scored
    .filter((item) => item.score > 0.8)
    .slice(0, maxCount)
    .map((item) => toSourceRef(item.entry, item.rank));

  if (selected.length > 0) return selected;
  return [toSourceRef(matchedEntries[0], 1)];
}

function buildTraceability(plan: PrepPlan): PrepTraceability {
  return {
    summaryRefs: selectSourceRefsForText(plan.strategySummary, plan.matchedEntries, 3),
    questionRefs: plan.likelyQuestions.map((item) =>
      selectSourceRefsForText(
        `${item.question}\n${item.whyLikely}\n${item.howToAnswer}`,
        plan.matchedEntries,
        3,
      ),
    ),
    redFlagRefs: plan.redFlags.map((item) =>
      selectSourceRefsForText(item, plan.matchedEntries, 2),
    ),
    actionRefs: plan.actionChecklist.map((item) =>
      selectSourceRefsForText(item, plan.matchedEntries, 2),
    ),
  };
}

function withTraceability(plan: PrepPlan): PrepPlan {
  return {
    ...plan,
    traceability: buildTraceability(plan),
  };
}

function applyQualityGateToPlan(
  plan: PrepPlan,
  quality: PrepQuality,
): { plan: PrepPlan; warning?: string } {
  if (!quality.gateEnabled || quality.gatePassed) {
    return { plan };
  }
  const reason = quality.gateReason ?? "策略质量门槛未通过";
  const blockedSummary = `策略门槛未通过：${reason}。请先执行补证据动作，再生成正式面试策略。`;
  const nextPlan: PrepPlan = {
    ...plan,
    strategySummary: blockedSummary,
    redFlags: Array.from(new Set([reason, ...plan.redFlags])).slice(0, 8),
    actionChecklist: buildGateRecoveryChecklist(quality),
  };
  return {
    plan: nextPlan,
    warning: `质量门槛触发：${reason}`,
  };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return JSON.parse(fenced[1].trim());
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  return JSON.parse(trimmed);
}

function normalizeStringList(value: unknown, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0)
    .slice(0, maxLength);
}

function normalizeLikelyQuestions(value: unknown): PrepQuestion[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const question = typeof row.question === "string" ? row.question.trim() : "";
      const whyLikely =
        typeof row.whyLikely === "string" ? row.whyLikely.trim() : "";
      const howToAnswer =
        typeof row.howToAnswer === "string" ? row.howToAnswer.trim() : "";
      if (!question || !whyLikely || !howToAnswer) return null;
      return { question, whyLikely, howToAnswer };
    })
    .filter((item): item is PrepQuestion => item !== null)
    .slice(0, 8);
}

const PREP_SYSTEM_PROMPT = `
你是“面试前策略助手”，基于提供的经验库条目给出可执行准备方案。
只输出 JSON，不输出额外文字。

返回结构：
{
  "strategySummary": "string",
  "likelyQuestions": [
    {
      "question": "string",
      "whyLikely": "string",
      "howToAnswer": "string"
    }
  ],
  "redFlags": ["string"],
  "actionChecklist": ["string"]
}

要求：
- 结论必须基于经验库，不可编造公司/岗位事实
- likelyQuestions 最多 8 条
- redFlags 最多 8 条
- actionChecklist 最多 8 条
- 内容要具体，可直接执行
`.trim();

function buildPrepUserPrompt(
  request: PrepRequest,
  matchedEntries: LibraryEntry[],
  quality: PrepQuality,
): string {
  const entriesText = matchedEntries
    .map((entry, index) => {
      return [
        `#${index + 1}`,
        `source=${entry.source}`,
        `targetRole=${entry.targetRole}`,
        `company=${entry.company ?? "未提供"}`,
        `round=${entry.round ?? "未提供"}`,
        `question=${entry.question}`,
        `pitfall=${entry.pitfall}`,
        `betterAnswer=${entry.betterAnswer}`,
        `verificationStatus=${entry.verificationStatus ?? "unverified"}`,
        `confidence=${confidenceValue(entry)}`,
        `tags=${entry.tags.join(",")}`,
      ].join("\n");
    })
    .join("\n\n");

  return [
    `目标岗位：${request.targetRole}`,
    `目标公司：${request.company?.trim() || "未提供"}`,
    `当前关注点：${request.focus?.trim() || "未提供"}`,
    `质量信号：evidenceScore=${quality.evidenceScore} level=${quality.qualityLevel} supported=${quality.supportedCount} weak=${quality.weakCount} conflict=${quality.conflictCount}`,
    "",
    "经验库命中条目：",
    entriesText || "暂无命中条目",
  ].join("\n");
}

export async function generatePrepPlan(
  request: PrepRequest,
  matchedEntries: LibraryEntry[],
): Promise<{ plan: PrepPlan; warning?: string }> {
  const gateConfig = normalizeGateConfig(request);
  const quality = buildPrepQuality(matchedEntries, gateConfig);
  const qualityWarning =
    quality.evidenceScore < 55
      ? "当前命中条目证据质量偏低，建议先补充来源复查后再依赖策略。"
      : quality.conflictCount > 0
        ? "命中条目存在证据冲突，请优先核验冲突项。"
        : undefined;

  if (matchedEntries.length === 0) {
    const basePlan = fallbackPlan(request, matchedEntries, quality);
    const gated = applyQualityGateToPlan(basePlan, quality);
    return {
      plan: withTraceability(gated.plan),
      warning: mergeWarning(qualityWarning, gated.warning),
    };
  }

  try {
    const response = await callLlm({
      messages: [
        { role: "system", content: PREP_SYSTEM_PROMPT },
        { role: "user", content: buildPrepUserPrompt(request, matchedEntries, quality) },
      ],
      temperature: 0.25,
    });

    const parsed = extractJson(response.content) as Record<string, unknown>;
    const strategySummary =
      typeof parsed.strategySummary === "string"
        ? parsed.strategySummary.trim()
        : "";
    const likelyQuestions = normalizeLikelyQuestions(parsed.likelyQuestions);
    const redFlags = normalizeStringList(parsed.redFlags, 8);
    const actionChecklist = normalizeStringList(parsed.actionChecklist, 8);

    if (!strategySummary || likelyQuestions.length === 0 || actionChecklist.length === 0) {
      const basePlan = fallbackPlan(request, matchedEntries, quality);
      const gated = applyQualityGateToPlan(basePlan, quality);
      return {
        plan: withTraceability(gated.plan),
        warning: mergeWarning(
          qualityWarning,
          mergeWarning(
            gated.warning,
            "模型返回内容不完整，已回退到规则策略。",
          ),
        ),
      };
    }

    const basePlan: PrepPlan = {
      strategySummary,
      likelyQuestions,
      redFlags,
      actionChecklist,
      matchedEntries,
      quality,
    };
    const gated = applyQualityGateToPlan(basePlan, quality);
    return {
      plan: withTraceability(gated.plan),
      warning: mergeWarning(qualityWarning, gated.warning),
    };
  } catch (error) {
    const basePlan = fallbackPlan(request, matchedEntries, quality);
    const gated = applyQualityGateToPlan(basePlan, quality);
    return {
      plan: withTraceability(gated.plan),
      warning: mergeWarning(
        qualityWarning,
        mergeWarning(
          gated.warning,
          error instanceof Error
            ? `模型生成失败，已回退规则策略：${error.message}`
            : "模型生成失败，已回退规则策略。",
        ),
      ),
    };
  }
}
