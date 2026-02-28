import { callLlm } from "@/lib/llm";
import type {
  LibraryEntryInput,
  ResearchImportRequest,
  ResearchImportStats,
  SourceCheck,
  VerificationStatus,
} from "@/lib/types";

const MAX_REPORT_LENGTH = 30000;
const MAX_SOURCE_COUNT = 8;
const MAX_EXTRACT_COUNT = 12;
const SOURCE_FETCH_TIMEOUT_MS = 12000;
const SOURCE_FETCH_MAX_CHARS = 24000;
const SOURCE_EXCERPT_CHARS = 1400;

type ExtractedItem = {
  question: string;
  pitfall: string;
  betterAnswer: string;
  tags: string[];
  sourceUrl?: string;
  claim?: string;
};

type VerifyItem = {
  index: number;
  status: VerificationStatus;
  confidence: number;
  reason: string;
  citedUrls: string[];
};

type VerifyResult = {
  items: VerifyItem[];
};

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return JSON.parse(fenced[1].trim());
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  return JSON.parse(trimmed);
}

function normalizeText(value: unknown, maxLength = 500): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => normalizeText(item, 30))
        .filter((item) => item.length > 0)
        .slice(0, 8),
    ),
  );
}

function normalizeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function providerTag(provider: ResearchImportRequest["provider"]): string {
  if (provider === "gemini") return "Gemini";
  if (provider === "gpt") return "GPT";
  if (provider === "doubao") return "豆包";
  if (provider === "zhipu") return "智谱";
  return "其他研究源";
}

function normalizeExtractItems(value: unknown): ExtractedItem[] {
  if (!Array.isArray(value)) return [];
  const mapped: Array<ExtractedItem | null> = value.map((item) => {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    const question = normalizeText(row.question, 200);
    const pitfall = normalizeText(row.pitfall, 260);
    const betterAnswer = normalizeText(row.betterAnswer, 320);
    if (!question) return null;
    return {
      question,
      pitfall,
      betterAnswer,
      tags: normalizeTags(row.tags),
      sourceUrl: normalizeUrl(row.sourceUrl),
      claim: normalizeText(row.claim, 220),
    };
  });
  return mapped
    .filter((item): item is ExtractedItem => item !== null)
    .slice(0, MAX_EXTRACT_COUNT);
}

function normalizeVerifyItems(value: unknown): VerifyItem[] {
  if (!Array.isArray(value)) return [];
  const mapped: Array<VerifyItem | null> = value.map((item) => {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    const index = Number(row.index);
    if (!Number.isInteger(index) || index < 0) return null;

    const statusRaw = normalizeText(row.status, 20).toLowerCase();
    const status: VerificationStatus =
      statusRaw === "supported"
        ? "supported"
        : statusRaw === "weak"
          ? "weak"
          : statusRaw === "conflict"
            ? "conflict"
            : statusRaw === "unreachable"
              ? "unreachable"
              : "unverified";

    const confidenceRaw = Number(row.confidence);
    const confidence = Number.isFinite(confidenceRaw)
      ? Math.min(Math.max(confidenceRaw, 0), 1)
      : 0.5;

    const reason = normalizeText(row.reason, 220);
    const citedUrls = Array.isArray(row.citedUrls)
      ? row.citedUrls
          .map((url) => normalizeUrl(url))
          .filter((url): url is string => Boolean(url))
          .slice(0, 3)
      : [];
    return { index, status, confidence, reason, citedUrls };
  });
  return mapped.filter((item): item is VerifyItem => item !== null);
}

function splitHtmlTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) return undefined;
  return normalizeText(match[1], 120);
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchSource(url: string): Promise<SourceCheck> {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent":
          "InterviewPrepResearchBot/1.0 (manual verification only; non-crawling)",
      },
      signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS),
    });
    const rawText = await response.text();
    const text = rawText.slice(0, SOURCE_FETCH_MAX_CHARS);
    const title = splitHtmlTitle(text);
    const excerpt = htmlToText(text).slice(0, SOURCE_EXCERPT_CHARS);
    if (!response.ok) {
      return {
        url,
        ok: false,
        statusCode: response.status,
        title,
        excerpt,
        error: `HTTP ${response.status}`,
      };
    }

    if (!excerpt || excerpt.length < 80) {
      return {
        url,
        ok: false,
        statusCode: response.status,
        title,
        excerpt,
        error: "页面文本过少，无法复核。",
      };
    }

    return {
      url,
      ok: true,
      statusCode: response.status,
      title,
      excerpt,
    };
  } catch (error) {
    return {
      url,
      ok: false,
      error: error instanceof Error ? error.message : "来源抓取失败",
    };
  }
}

function normalizeSourceUrls(urls: string[]): string[] {
  return Array.from(
    new Set(
      urls
        .map((item) => normalizeUrl(item))
        .filter((item): item is string => Boolean(item)),
    ),
  ).slice(0, MAX_SOURCE_COUNT);
}

const EXTRACT_SYSTEM_PROMPT = `
你是“求职面经研究报告解析器”。
目标：把研究报告提炼成可入库的面试经验条目。
只输出 JSON，不要输出额外解释。

输出结构：
{
  "items": [
    {
      "question": "string",
      "pitfall": "string",
      "betterAnswer": "string",
      "tags": ["string"],
      "sourceUrl": "string",
      "claim": "string"
    }
  ]
}

规则：
- 只提炼报告中明确出现或可直接归纳的信息，不编造。
- item 数量 3-12 条，优先高频问题。
- pitfall 和 betterAnswer 要可执行，避免空泛套话。
- sourceUrl 只能从用户提供的候选 URL 中选择。
`.trim();

function buildExtractPrompt(input: ResearchImportRequest, sourceUrls: string[]): string {
  const candidateUrls = sourceUrls.length > 0 ? sourceUrls.join("\n") : "未提供";
  return [
    `研究来源：${providerTag(input.provider)}`,
    `目标岗位：${input.targetRole}`,
    `目标公司：${input.company?.trim() || "未提供"}`,
    `面试轮次：${input.round?.trim() || "未提供"}`,
    "",
    "候选来源 URL（仅可在这些 URL 内引用 sourceUrl）：",
    candidateUrls,
    "",
    "研究报告原文：",
    input.reportText.slice(0, MAX_REPORT_LENGTH),
  ].join("\n");
}

async function extractItemsFromReport(
  input: ResearchImportRequest,
  sourceUrls: string[],
): Promise<ExtractedItem[]> {
  try {
    const response = await callLlm({
      messages: [
        { role: "system", content: EXTRACT_SYSTEM_PROMPT },
        { role: "user", content: buildExtractPrompt(input, sourceUrls) },
      ],
      temperature: 0.2,
    });
    const parsed = extractJson(response.content) as Record<string, unknown>;
    const items = normalizeExtractItems(parsed.items);
    if (items.length > 0) return items;
  } catch {
    // fallback below
  }

  const preview = normalizeText(input.reportText, 480);
  if (!preview) return [];
  return [
    {
      question: "请复述该岗位最核心的业务目标，并说明你会如何落地。",
      pitfall: "报告导入失败时，常见问题是结论多、证据少，回答容易空泛。",
      betterAnswer:
        "先给出岗位目标理解，再给出一段可量化案例（目标-动作-结果-复盘）。",
      tags: ["DeepResearch", "待人工复核"],
      sourceUrl: sourceUrls[0],
      claim: preview,
    },
  ];
}

const VERIFY_SYSTEM_PROMPT = `
你是“来源复核器”。你会拿到：
1) 面经条目（question/pitfall/betterAnswer/claim）
2) 多个来源网页的标题和摘录

任务：为每个条目标记证据状态。
只输出 JSON。

输出结构：
{
  "items": [
    {
      "index": 0,
      "status": "supported|weak|conflict|unverified|unreachable",
      "confidence": 0.0,
      "reason": "string",
      "citedUrls": ["https://..."]
    }
  ]
}

判定标准：
- supported：来源摘录与条目核心结论明显一致
- weak：只部分支持，证据不充分
- conflict：来源信息与条目明显冲突
- unreachable：该条目依赖来源无法访问或内容不足
- unverified：暂时无法判断
`.trim();

function buildVerifyPrompt(
  items: ExtractedItem[],
  sourceChecks: SourceCheck[],
): string {
  const itemText = items
    .map((item, index) => {
      return [
        `#${index}`,
        `question=${item.question}`,
        `pitfall=${item.pitfall || "未提供"}`,
        `betterAnswer=${item.betterAnswer || "未提供"}`,
        `claim=${item.claim || "未提供"}`,
        `sourceUrl=${item.sourceUrl || "未指定"}`,
      ].join("\n");
    })
    .join("\n\n");

  const sourceText = sourceChecks
    .map((source, index) => {
      return [
        `S${index + 1}`,
        `url=${source.url}`,
        `ok=${source.ok}`,
        `statusCode=${source.statusCode ?? "未知"}`,
        `title=${source.title ?? "未解析"}`,
        `error=${source.error ?? "无"}`,
        `excerpt=${source.excerpt ?? "无可用摘录"}`,
      ].join("\n");
    })
    .join("\n\n");

  return [
    "条目：",
    itemText,
    "",
    "来源：",
    sourceText,
  ].join("\n");
}

async function verifyItems(
  items: ExtractedItem[],
  sourceChecks: SourceCheck[],
): Promise<VerifyResult> {
  const reachableCount = sourceChecks.filter((item) => item.ok).length;
  if (reachableCount === 0) {
    return {
      items: items.map((_, index) => ({
        index,
        status: "unreachable",
        confidence: 0.3,
        reason: "来源 URL 均不可访问或不可解析。",
        citedUrls: [],
      })),
    };
  }

  try {
    const response = await callLlm({
      messages: [
        { role: "system", content: VERIFY_SYSTEM_PROMPT },
        { role: "user", content: buildVerifyPrompt(items, sourceChecks) },
      ],
      temperature: 0.1,
    });
    const parsed = extractJson(response.content) as Record<string, unknown>;
    const normalized = normalizeVerifyItems(parsed.items);
    if (normalized.length > 0) return { items: normalized };
  } catch {
    // fallback below
  }

  return {
    items: items.map((item, index) => ({
      index,
      status: item.sourceUrl ? "weak" : "unverified",
      confidence: item.sourceUrl ? 0.55 : 0.45,
      reason: "自动复核降级，建议人工抽检该条目。",
      citedUrls: item.sourceUrl ? [item.sourceUrl] : [],
    })),
  };
}

function buildStats(statuses: VerificationStatus[]): ResearchImportStats {
  return statuses.reduce<ResearchImportStats>(
    (acc, status) => {
      if (status === "supported") acc.supported += 1;
      else if (status === "weak") acc.weak += 1;
      else if (status === "conflict") acc.conflict += 1;
      else if (status === "unreachable") acc.unreachable += 1;
      else acc.unverified += 1;
      return acc;
    },
    { supported: 0, weak: 0, conflict: 0, unverified: 0, unreachable: 0 },
  );
}

function ensureStrategyText(value: string, fallback: string): string {
  const normalized = value.trim();
  if (!normalized) return fallback;
  return normalized;
}

function findVerificationByIndex(
  verifyItems: VerifyItem[],
  index: number,
): VerifyItem | undefined {
  return verifyItems.find((item) => item.index === index);
}

export async function transformResearchToLibraryEntries(
  input: ResearchImportRequest,
): Promise<{
  entries: LibraryEntryInput[];
  sourceChecks: SourceCheck[];
  stats: ResearchImportStats;
}> {
  const sourceUrls = normalizeSourceUrls(input.sourceUrls);
  const items = await extractItemsFromReport(input, sourceUrls);
  if (items.length === 0) {
    return {
      entries: [],
      sourceChecks: [],
      stats: { supported: 0, weak: 0, conflict: 0, unverified: 0, unreachable: 0 },
    };
  }

  const sourceChecks = input.verifySources
    ? await Promise.all(sourceUrls.map((url) => fetchSource(url)))
    : [];
  const verifyResult =
    input.verifySources && sourceChecks.length > 0
      ? await verifyItems(items, sourceChecks)
      : {
          items: items.map((_, index) => ({
            index,
            status: "unverified" as VerificationStatus,
            confidence: 0.5,
            reason: "未启用来源复核。",
            citedUrls: [],
          })),
        };

  const entries: LibraryEntryInput[] = items.map((item, index) => {
    const verify = findVerificationByIndex(verifyResult.items, index);
    const status = verify?.status ?? "unverified";
    const confidence = verify?.confidence ?? 0.5;
    const reason = verify?.reason ?? "待人工复核";
    const sourceUrl =
      verify?.citedUrls?.[0] ??
      item.sourceUrl ??
      (sourceUrls.length > 0 ? sourceUrls[0] : undefined);

    return {
      source: "other",
      targetRole: input.targetRole.trim(),
      company: input.company?.trim() ?? "",
      round: input.round?.trim() ?? "",
      question: item.question,
      pitfall: ensureStrategyText(item.pitfall, "原报告未明确坑点，建议人工补充。"),
      betterAnswer: ensureStrategyText(
        item.betterAnswer,
        "原报告未明确答题策略，建议人工补充。",
      ),
      tags: Array.from(
        new Set([
          "DeepResearch",
          providerTag(input.provider),
          ...item.tags,
          status === "supported"
            ? "已复核"
            : status === "conflict"
              ? "冲突待处理"
              : status === "weak"
                ? "证据偏弱"
                : "待复核",
        ]),
      ),
      sourceUrl,
      evidenceNote: reason,
      verificationStatus: status,
      confidence,
    };
  });

  return {
    entries,
    sourceChecks,
    stats: buildStats(entries.map((item) => item.verificationStatus ?? "unverified")),
  };
}
