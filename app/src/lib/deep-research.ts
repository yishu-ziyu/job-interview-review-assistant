import { search, SafeSearchType } from "duck-duck-scrape";
import { isLikelyConversationOrAppUrl } from "@/lib/browser-capture";
import { callLlm } from "@/lib/llm";
import type {
  DeepResearchChannel,
  DeepResearchEvidenceCluster,
  DeepResearchProfile,
  DeepResearchRequest,
  DeepResearchResult,
  DeepResearchSearchEngine,
  DeepResearchSource,
  DeepResearchSourceQuality,
  LlmProvider,
} from "@/lib/types";

const DEFAULT_MAX_PER_CHANNEL = 8;
const MAX_QUERIES_PER_CHANNEL = 3;
const DEFAULT_REFLECTION_ENABLED = true;
const DEFAULT_REFLECTION_QUERIES_PER_CHANNEL = 1;
const MAX_REFLECTION_QUERIES_PER_CHANNEL = 3;
const DEFAULT_CROSS_VALIDATION_ENABLED = false;
const MAX_TOTAL_SOURCES = 36;
const MAX_SOURCES_FOR_SYNTHESIS = 28;
const MIN_CHANNEL_SOURCE_FLOOR = 2;
const READINESS_MIN_AVG_SCORE = 68;
const READINESS_MIN_A_GRADE_COUNT = 5;
const READINESS_MIN_UNIQUE_DOMAIN_COUNT = 8;
const READINESS_MIN_COVERED_CHANNELS = 4;
const READINESS_MIN_ALIGNMENT = 60;
const READINESS_MIN_ACCEPTED_CLUSTER_COUNT = 4;
const EVIDENCE_CLUSTER_MIN_SUPPORT_DOMAINS = 2;
const EVIDENCE_CLUSTER_MATCH_THRESHOLD = 0.3;

const CHANNELS: DeepResearchChannel[] = [
  "job",
  "interview",
  "community",
  "knowledge",
  "salary",
];

const HIGH_TRUST_DOMAIN_KEYWORDS = [
  "gov.cn",
  ".gov",
  "edu.cn",
  ".edu",
  "github.com",
];

const MEDIUM_TRUST_DOMAIN_KEYWORDS = [
  "zhipin.com",
  "liepin.com",
  "zhaopin.com",
  "51job.com",
  "nowcoder.com",
  "lagou.com",
  "maimai.cn",
  "36kr.com",
  "huxiu.com",
  "geekpark.net",
];

const NOISY_DOMAIN_KEYWORDS = [
  "douyin.com",
  "xiaohongshu.com",
  "xhslink.com",
  "toutiao.com",
  "weibo.com",
  "sohu.com",
];

const CHANNEL_KEYWORDS: Record<DeepResearchChannel, string[]> = {
  job: ["岗位", "职责", "任职", "JD", "招聘", "要求", "KPI", "工作内容"],
  interview: ["面试", "面经", "一面", "二面", "终面", "追问", "题", "复盘"],
  community: ["讨论", "吐槽", "反馈", "经验", "社区", "网友", "看法"],
  knowledge: ["方法论", "框架", "能力模型", "学习路径", "案例", "模型"],
  salary: ["薪资", "年包", "职级", "薪酬", "涨薪", "待遇", "区间"],
};

const TOPIC_CLUSTER_CONFIGS: Array<{
  id: string;
  label: string;
  keywords: string[];
}> = [
  {
    id: "role-responsibility",
    label: "岗位职责与目标口径",
    keywords: ["岗位", "职责", "任职", "工作内容", "kpi", "目标", "jd", "招聘要求"],
  },
  {
    id: "interview-flow",
    label: "面试流程与高频追问",
    keywords: ["面试", "面经", "一面", "二面", "终面", "追问", "复盘", "题型"],
  },
  {
    id: "skill-model",
    label: "能力模型与核心技能",
    keywords: ["能力模型", "能力", "技能", "方法论", "框架", "案例", "产品经理"],
  },
  {
    id: "salary-level",
    label: "薪资职级与市场信号",
    keywords: ["薪资", "年包", "职级", "薪酬", "待遇", "涨薪", "市场"],
  },
  {
    id: "ai-domain",
    label: "AI 领域背景与行业趋势",
    keywords: ["ai", "人工智能", "大模型", "智能体", "agent", "模型"],
  },
];

type ChannelPlan = {
  channel: DeepResearchChannel;
  queries: string[];
};

type SearchResultRow = {
  title: string;
  url: string;
  description: string;
  hostname: string;
};

type SearchEngineRunResult = {
  rows: SearchResultRow[];
  engineUsed?: DeepResearchSearchEngine;
};

type SearchTelemetryAccumulator = {
  totalQueries: number;
  primarySuccess: number;
  fallbackSuccess: number;
  failedQueries: number;
  engineUsage: Record<DeepResearchSearchEngine, number>;
};

type ReflectionQuery = {
  channel: DeepResearchChannel;
  query: string;
  reason: string;
};

type SourceCountByChannel = Record<DeepResearchChannel, number>;

type SourceBuckets = Record<DeepResearchChannel, DeepResearchSource[]>;

type EvidenceClusterInternal = {
  id: string;
  claim: string;
  tokens: Set<string>;
  sourceIndexes: number[];
  domains: Set<string>;
  channels: Set<DeepResearchChannel>;
};

type EvidenceClusterBuildResult = {
  minSupportDomains: number;
  total: number;
  accepted: number;
  clusters: DeepResearchEvidenceCluster[];
  acceptedSourceIndexes: Set<number>;
};

function createEmptyBuckets(): SourceBuckets {
  return {
    job: [],
    interview: [],
    community: [],
    knowledge: [],
    salary: [],
  };
}

function createEmptySourceCount(): SourceCountByChannel {
  return {
    job: 0,
    interview: 0,
    community: 0,
    knowledge: 0,
    salary: 0,
  };
}

function createEmptySearchTelemetry(): SearchTelemetryAccumulator {
  return {
    totalQueries: 0,
    primarySuccess: 0,
    fallbackSuccess: 0,
    failedQueries: 0,
    engineUsage: {
      "duck-duck-scrape": 0,
      "duckduckgo-html": 0,
      "bing-html": 0,
    },
  };
}

function normalizeText(value: unknown, maxLength = 300): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function dedupQueries(queries: string[]): string[] {
  return queries
    .map((query) => query.replace(/\s+/g, " ").trim())
    .filter((query, index, array) => query.length > 0 && array.indexOf(query) === index);
}

function buildChannelQueries(input: DeepResearchRequest): ChannelPlan[] {
  const role = input.targetRole.trim();
  const company = input.company?.trim() ?? "";
  const focus = input.focus?.trim() ?? "";
  const companyPrefix = company ? `${company} ` : "";
  const focusSuffix = focus ? ` ${focus}` : "";

  const plan: ChannelPlan[] = [
    {
      channel: "job",
      queries: [
        `${companyPrefix}${role} 岗位职责 任职要求 JD`,
        `${companyPrefix}${role} 招聘 要求`,
        `${role}${focusSuffix} 核心工作内容`,
      ],
    },
    {
      channel: "interview",
      queries: [
        `${companyPrefix}${role} 面经 面试问题`,
        `${role} 高频面试题 回答思路`,
        `${role}${focusSuffix} 面试 复盘`,
      ],
    },
    {
      channel: "community",
      queries: [
        `${role} 知乎 讨论`,
        `${role} 牛客 小红书 经验`,
        `${companyPrefix}${role} 社区反馈`,
      ],
    },
    {
      channel: "knowledge",
      queries: [
        `${role} 能力模型 技能框架`,
        `${role}${focusSuffix} 方法论`,
        `${role} 职业发展 路径`,
      ],
    },
    {
      channel: "salary",
      queries: [
        `${companyPrefix}${role} 薪资`,
        `${role} 职级 薪酬 范围`,
        `${role}${focusSuffix} 岗位价值`,
      ],
    },
  ];

  return plan.map((item) => ({
    channel: item.channel,
    queries: dedupQueries(item.queries).slice(0, MAX_QUERIES_PER_CHANNEL),
  }));
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

function stripHtml(input: string): string {
  return decodeHtmlEntities(input.replace(/<[^>]+>/g, " "));
}

function unwrapDuckDuckGoRedirect(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  try {
    const candidate = trimmed.startsWith("http")
      ? new URL(trimmed)
      : new URL(trimmed, "https://duckduckgo.com");
    if (candidate.hostname.includes("duckduckgo.com")) {
      const uddg = candidate.searchParams.get("uddg");
      if (uddg) {
        const decoded = decodeURIComponent(uddg);
        if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
          return decoded;
        }
      }
    }
    return candidate.toString();
  } catch {
    return trimmed;
  }
}

async function searchDuckDuckScrape(query: string): Promise<SearchResultRow[]> {
  try {
    const result = await search(query, {
      safeSearch: SafeSearchType.MODERATE,
      locale: "zh-cn",
      region: "wt-wt",
    });
    return result.results
      .map((item) => ({
        title: normalizeText(item.title, 180),
        url: unwrapDuckDuckGoRedirect(item.url),
        description: normalizeText(item.description ?? item.rawDescription ?? "", 360),
        hostname: normalizeText(item.hostname ?? "", 120),
      }))
      .filter((item) => item.title && item.url && item.description);
  } catch {
    return [];
  }
}

async function searchDuckDuckHtml(query: string): Promise<SearchResultRow[]> {
  try {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=cn-zh`;
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; DeepResearchBot/1.0)" },
      redirect: "follow",
    });
    if (!response.ok) return [];
    const html = await response.text();
    const rows: SearchResultRow[] = [];
    const regex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null = regex.exec(html);
    while (match) {
      const rawHref = decodeHtmlEntities(match[1] ?? "");
      const title = normalizeText(stripHtml(match[2] ?? ""), 180);
      const normalizedHref = unwrapDuckDuckGoRedirect(rawHref);
      const normalizedUrl = normalizeUrl(normalizedHref);
      if (normalizedUrl && title) {
        const hostname = new URL(normalizedUrl).hostname;
        rows.push({
          title,
          url: normalizedUrl,
          description: title,
          hostname,
        });
      }
      if (rows.length >= 30) break;
      match = regex.exec(html);
    }
    return rows;
  } catch {
    return [];
  }
}

async function searchBingHtml(query: string): Promise<SearchResultRow[]> {
  try {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-Hans`;
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; DeepResearchBot/1.0)" },
      redirect: "follow",
    });
    if (!response.ok) return [];
    const html = await response.text();
    const rows: SearchResultRow[] = [];
    const blockRegex = /<li class="b_algo"[\s\S]*?<\/li>/gi;
    let block: RegExpExecArray | null = blockRegex.exec(html);
    while (block) {
      const chunk = block[0];
      const linkMatch = chunk.match(
        /<h2[^>]*>\s*<a[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i,
      );
      const snippetMatch = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      const rawHref = decodeHtmlEntities(linkMatch?.[1] ?? linkMatch?.[2] ?? "");
      const normalizedUrl = normalizeUrl(rawHref);
      const title = normalizeText(stripHtml(linkMatch?.[3] ?? ""), 180);
      const description = normalizeText(stripHtml(snippetMatch?.[1] ?? title), 360);
      if (normalizedUrl && title && description) {
        rows.push({
          title,
          url: normalizedUrl,
          description,
          hostname: new URL(normalizedUrl).hostname,
        });
      }
      if (rows.length >= 30) break;
      block = blockRegex.exec(html);
    }
    return rows;
  } catch {
    return [];
  }
}

async function searchWeb(query: string): Promise<SearchEngineRunResult> {
  const primaryRows = await searchDuckDuckScrape(query);
  if (primaryRows.length > 0) {
    return { rows: primaryRows, engineUsed: "duck-duck-scrape" };
  }

  const fallbackDuckRows = await searchDuckDuckHtml(query);
  if (fallbackDuckRows.length > 0) {
    return { rows: fallbackDuckRows, engineUsed: "duckduckgo-html" };
  }

  const fallbackBingRows = await searchBingHtml(query);
  if (fallbackBingRows.length > 0) {
    return { rows: fallbackBingRows, engineUsed: "bing-html" };
  }

  return { rows: [] };
}

function shouldFilterSource(url: string): boolean {
  const parsed = normalizeUrl(url);
  if (!parsed) return true;
  if (isLikelyConversationOrAppUrl(parsed)) return true;
  return false;
}

function hasDomainKeyword(domain: string, keywords: string[]): boolean {
  const normalized = domain.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword));
}

function tokenizeQuery(query: string): string[] {
  return query
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 12);
}

function countContains(text: string, keywords: string[]): number {
  let count = 0;
  for (const keyword of keywords) {
    if (text.includes(keyword)) count += 1;
  }
  return count;
}

function scoreSourceQuality(input: {
  channel: DeepResearchChannel;
  query: string;
  domain: string;
  title: string;
  snippet: string;
}): DeepResearchSourceQuality {
  const reasons: string[] = [];
  let score = 50;
  const mergedText = `${input.title} ${input.snippet}`.toLowerCase();

  if (hasDomainKeyword(input.domain, HIGH_TRUST_DOMAIN_KEYWORDS)) {
    score += 28;
    reasons.push("域名可信度高");
  } else if (hasDomainKeyword(input.domain, MEDIUM_TRUST_DOMAIN_KEYWORDS)) {
    score += 16;
    reasons.push("域名可信度中高");
  } else {
    score += 7;
    reasons.push("域名可信度一般");
  }

  if (hasDomainKeyword(input.domain, NOISY_DOMAIN_KEYWORDS)) {
    score -= 10;
    reasons.push("内容平台噪声风险较高");
  }

  const channelKeywordHits = countContains(
    mergedText,
    CHANNEL_KEYWORDS[input.channel].map((item) => item.toLowerCase()),
  );
  if (channelKeywordHits >= 3) {
    score += 14;
    reasons.push("与检索通道高度匹配");
  } else if (channelKeywordHits >= 1) {
    score += 7;
    reasons.push("与检索通道基本匹配");
  } else {
    score -= 8;
    reasons.push("与检索通道匹配度偏低");
  }

  const snippetLength = input.snippet.length;
  if (snippetLength >= 220) {
    score += 10;
    reasons.push("摘要信息量充足");
  } else if (snippetLength >= 140) {
    score += 6;
    reasons.push("摘要信息量中等");
  } else if (snippetLength >= 80) {
    score += 3;
    reasons.push("摘要信息量有限");
  } else {
    score -= 5;
    reasons.push("摘要信息量不足");
  }

  const queryTokens = tokenizeQuery(input.query);
  const queryHitCount = queryTokens.filter((token) => mergedText.includes(token.toLowerCase())).length;
  const queryHitRatio = queryTokens.length > 0 ? queryHitCount / queryTokens.length : 0;
  if (queryHitRatio >= 0.6) {
    score += 8;
    reasons.push("与检索意图一致性高");
  } else if (queryHitRatio >= 0.3) {
    score += 4;
    reasons.push("与检索意图一致性中等");
  } else {
    score -= 5;
    reasons.push("与检索意图一致性偏低");
  }

  if (mergedText.includes("广告") || mergedText.includes("推广")) {
    score -= 6;
    reasons.push("可能存在推广内容");
  }

  const normalizedScore = Math.max(0, Math.min(100, Math.round(score)));
  const grade = normalizedScore >= 80 ? "A" : normalizedScore >= 60 ? "B" : "C";
  return {
    score: normalizedScore,
    grade,
    reasons: reasons.slice(0, 4),
  };
}

function mapToSource(
  channel: DeepResearchChannel,
  query: string,
  row: SearchResultRow,
): DeepResearchSource | null {
  const url = normalizeUrl(row.url);
  if (!url) return null;
  if (shouldFilterSource(url)) return null;
  const title = normalizeText(row.title, 160);
  const snippet = normalizeText(row.description, 360);
  const domain = (normalizeText(row.hostname, 80) || new URL(url).hostname).toLowerCase();
  if (!title || !snippet) return null;
  const quality = scoreSourceQuality({ channel, query, domain, title, snippet });
  return {
    title,
    url,
    domain,
    snippet,
    channel,
    query,
    quality,
  };
}

function dedupSources(sources: DeepResearchSource[]): DeepResearchSource[] {
  const byUrl = new Map<string, DeepResearchSource>();
  for (const source of sources) {
    const existing = byUrl.get(source.url);
    if (!existing || source.quality.score > existing.quality.score) {
      byUrl.set(source.url, source);
    }
  }
  return Array.from(byUrl.values())
    .sort((left, right) => right.quality.score - left.quality.score)
    .slice(0, MAX_TOTAL_SOURCES);
}

function countSourcesByChannel(sources: DeepResearchSource[]): SourceCountByChannel {
  const counts = createEmptySourceCount();
  for (const source of sources) {
    counts[source.channel] += 1;
  }
  return counts;
}

function inferWeakChannels(
  maxSourcesPerChannel: number,
  sourceCountByChannel: SourceCountByChannel,
  firstPassProfile: DeepResearchProfile,
): DeepResearchChannel[] {
  const weak = new Set<DeepResearchChannel>();
  const channelFloor = Math.max(
    MIN_CHANNEL_SOURCE_FLOOR,
    Math.floor(maxSourcesPerChannel * 0.5),
  );

  for (const channel of CHANNELS) {
    if (sourceCountByChannel[channel] < channelFloor) {
      weak.add(channel);
    }
  }

  if (firstPassProfile.coreResponsibilities.length < 3) weak.add("job");
  if (firstPassProfile.interviewQuestionThemes.length < 3) weak.add("interview");
  if (firstPassProfile.coreSkills.length < 4) weak.add("knowledge");
  if (firstPassProfile.marketSignals.length < 2) weak.add("salary");
  if (firstPassProfile.risks.length < 3) weak.add("community");

  return CHANNELS.filter((channel) => weak.has(channel));
}

function buildGapHypotheses(
  maxSourcesPerChannel: number,
  sourceCountByChannel: SourceCountByChannel,
  firstPassProfile: DeepResearchProfile,
  weakChannels: DeepResearchChannel[],
): string[] {
  const hypotheses: string[] = [];

  for (const channel of weakChannels) {
    hypotheses.push(
      `${channel} 渠道覆盖偏弱（${sourceCountByChannel[channel]}/${maxSourcesPerChannel}），需要补充证据。`,
    );
  }

  if (firstPassProfile.interviewQuestionThemes.length < 3) {
    hypotheses.push("面试题型覆盖偏少，可能遗漏高轮次追问场景。");
  }
  if (firstPassProfile.coreSkills.length < 4) {
    hypotheses.push("技能模型颗粒度不足，可能影响后续行动清单的准确性。");
  }
  if (firstPassProfile.marketSignals.length < 2) {
    hypotheses.push("市场信号样本不足，薪资/职级判断可能偏差较大。");
  }
  if (firstPassProfile.risks.length < 3) {
    hypotheses.push("风险项偏少，容易低估岗位与面试中的关键盲区。");
  }

  return dedupQueries(hypotheses).slice(0, 8);
}

function buildReflectionCandidates(input: DeepResearchRequest): Record<
  DeepResearchChannel,
  Array<{ query: string; reason: string }>
> {
  const role = input.targetRole.trim();
  const company = input.company?.trim() ?? "";
  const focus = input.focus?.trim() ?? "";
  const companyPrefix = company ? `${company} ` : "";
  const focusSuffix = focus ? ` ${focus}` : "";

  return {
    job: [
      {
        query: `${companyPrefix}${role} 真实JD 关键职责 KPI`,
        reason: "补齐岗位职责与考核口径",
      },
      {
        query: `${role}${focusSuffix} 日常工作流程 产出物`,
        reason: "补齐岗位真实执行场景",
      },
      {
        query: `${companyPrefix}${role} 试用期目标 转正标准`,
        reason: "补齐入职后 3 个月的目标预期",
      },
    ],
    interview: [
      {
        query: `${companyPrefix}${role} 二面 终面 复盘`,
        reason: "补齐中高轮面试追问模式",
      },
      {
        query: `${role} 结构化面试题 追问`,
        reason: "补齐高概率追问题型",
      },
      {
        query: `${role} 面试失败 复盘 原因`,
        reason: "识别常见失分与踩坑点",
      },
    ],
    community: [
      {
        query: `${companyPrefix}${role} 入职体验 吐槽 反馈`,
        reason: "补齐从业者真实反馈",
      },
      {
        query: `${role} 社区讨论 踩坑 经验`,
        reason: "补齐社区讨论中的高频问题",
      },
      {
        query: `${role} 工作强度 团队协作 评价`,
        reason: "补齐团队协作与工作强度信号",
      },
    ],
    knowledge: [
      {
        query: `${role}${focusSuffix} 能力模型 拆解 实战案例`,
        reason: "补齐能力模型和案例映射",
      },
      {
        query: `${role} 方法论 框架 模板`,
        reason: "补齐可执行方法论",
      },
      {
        query: `${role} 学习路径 从0到1`,
        reason: "补齐学习路径与成长节奏",
      },
    ],
    salary: [
      {
        query: `${companyPrefix}${role} 职级 薪资 年包`,
        reason: "补齐职级与薪酬区间",
      },
      {
        query: `${role} 薪资区间 城市 对比`,
        reason: "补齐地域差异和市场横向对比",
      },
      {
        query: `${role} 晋升路径 职级标准`,
        reason: "补齐薪资与晋升关系",
      },
    ],
  };
}

function buildReflectionQueries(
  input: DeepResearchRequest,
  weakChannels: DeepResearchChannel[],
  firstPassPlan: ChannelPlan[],
  reflectionQueriesPerChannel: number,
): ReflectionQuery[] {
  if (weakChannels.length === 0) return [];

  const alreadyQueried = new Set<string>(
    firstPassPlan.flatMap((item) => item.queries.map((query) => query.trim())),
  );
  const candidates = buildReflectionCandidates(input);
  const output: ReflectionQuery[] = [];

  for (const channel of weakChannels) {
    const chosen: ReflectionQuery[] = [];
    for (const candidate of candidates[channel]) {
      const query = candidate.query.replace(/\s+/g, " ").trim();
      if (!query) continue;
      if (alreadyQueried.has(query)) continue;
      if (chosen.some((item) => item.query === query)) continue;
      chosen.push({ channel, query, reason: candidate.reason });
      if (chosen.length >= reflectionQueriesPerChannel) break;
    }
    output.push(...chosen);
  }

  return output;
}

function groupReflectionQueriesByChannel(
  reflectionQueries: ReflectionQuery[],
): ChannelPlan[] {
  const queryMap = new Map<DeepResearchChannel, string[]>();
  for (const item of reflectionQueries) {
    if (!queryMap.has(item.channel)) queryMap.set(item.channel, []);
    queryMap.get(item.channel)?.push(item.query);
  }
  return CHANNELS.map((channel) => ({
    channel,
    queries: dedupQueries(queryMap.get(channel) ?? []),
  })).filter((item) => item.queries.length > 0);
}

function mergeQueryPlans(
  firstPassPlan: ChannelPlan[],
  reflectionQueries: ReflectionQuery[],
): ChannelPlan[] {
  const queryMap = new Map<DeepResearchChannel, string[]>();
  for (const channel of CHANNELS) {
    queryMap.set(channel, []);
  }
  for (const item of firstPassPlan) {
    queryMap.set(item.channel, [...(queryMap.get(item.channel) ?? []), ...item.queries]);
  }
  for (const item of reflectionQueries) {
    queryMap.set(item.channel, [...(queryMap.get(item.channel) ?? []), item.query]);
  }
  return CHANNELS.map((channel) => ({
    channel,
    queries: dedupQueries(queryMap.get(channel) ?? []),
  }));
}

async function runSearchPass(
  plan: ChannelPlan[],
  maxSourcesPerChannel: number,
  globalSeenUrls: Set<string>,
  telemetry: SearchTelemetryAccumulator,
): Promise<DeepResearchSource[]> {
  const buckets = createEmptyBuckets();
  await Promise.all(
    plan.map(async (item) => {
      const bucket = buckets[item.channel];
      for (const query of item.queries) {
        telemetry.totalQueries += 1;
        const { rows, engineUsed } = await searchWeb(query);
        if (engineUsed) {
          telemetry.engineUsage[engineUsed] += 1;
          if (engineUsed === "duck-duck-scrape") telemetry.primarySuccess += 1;
          else telemetry.fallbackSuccess += 1;
        } else {
          telemetry.failedQueries += 1;
        }
        for (const row of rows) {
          const mapped = mapToSource(item.channel, query, row);
          if (!mapped) continue;
          if (globalSeenUrls.has(mapped.url)) continue;
          if (bucket.some((source) => source.url === mapped.url)) continue;
          bucket.push(mapped);
          globalSeenUrls.add(mapped.url);
          if (bucket.length >= maxSourcesPerChannel) break;
        }
        if (bucket.length >= maxSourcesPerChannel) break;
      }
    }),
  );
  return CHANNELS.flatMap((channel) => buckets[channel]);
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

function normalizeStringArray(value: unknown, maxItems = 8, maxItemLength = 180): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeText(item, maxItemLength))
    .filter((item) => item.length > 0)
    .slice(0, maxItems);
}

function normalizeProfile(value: unknown): DeepResearchProfile {
  if (!value || typeof value !== "object") {
    return {
      roleSummary: "暂无足够信息，请扩大检索范围后重试。",
      coreResponsibilities: [],
      coreSkills: [],
      interviewQuestionThemes: [],
      marketSignals: [],
      risks: [],
      actionPlan: [],
    };
  }
  const row = value as Record<string, unknown>;
  const coreSkills = Array.isArray(row.coreSkills)
    ? row.coreSkills
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const skillRow = item as Record<string, unknown>;
          const skill = normalizeText(skillRow.skill, 60);
          const reason = normalizeText(skillRow.reason, 180);
          const priorityRaw = normalizeText(skillRow.priority, 3);
          const priority: "高" | "中" | "低" =
            priorityRaw === "高" || priorityRaw === "中" || priorityRaw === "低"
              ? priorityRaw
              : "中";
          if (!skill) return null;
          return { skill, reason, priority };
        })
        .filter((item): item is { skill: string; reason: string; priority: "高" | "中" | "低" } => item !== null)
        .slice(0, 10)
    : [];

  const interviewQuestionThemes = Array.isArray(row.interviewQuestionThemes)
    ? row.interviewQuestionThemes
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const qRow = item as Record<string, unknown>;
          const theme = normalizeText(qRow.theme, 80);
          const whyImportant = normalizeText(qRow.whyImportant, 180);
          const sampleQuestions = normalizeStringArray(qRow.sampleQuestions, 4, 120);
          if (!theme) return null;
          return { theme, whyImportant, sampleQuestions };
        })
        .filter(
          (
            item,
          ): item is {
            theme: string;
            whyImportant: string;
            sampleQuestions: string[];
          } => item !== null,
        )
        .slice(0, 8)
    : [];

  return {
    roleSummary: normalizeText(row.roleSummary, 600) || "暂无足够信息，请扩大检索范围后重试。",
    coreResponsibilities: normalizeStringArray(row.coreResponsibilities, 10, 180),
    coreSkills,
    interviewQuestionThemes,
    marketSignals: normalizeStringArray(row.marketSignals, 8, 180),
    risks: normalizeStringArray(row.risks, 8, 180),
    actionPlan: normalizeStringArray(row.actionPlan, 10, 180),
  };
}

function pickSynthesisSources(sources: DeepResearchSource[]): DeepResearchSource[] {
  if (sources.length <= MAX_SOURCES_FOR_SYNTHESIS) return sources;

  const selected: DeepResearchSource[] = [];
  const selectedUrls = new Set<string>();
  const byChannel = new Map<DeepResearchChannel, DeepResearchSource[]>();

  for (const channel of CHANNELS) {
    const bucket = sources
      .filter((item) => item.channel === channel)
      .sort((left, right) => right.quality.score - left.quality.score);
    byChannel.set(channel, bucket);
  }

  // 先保证每个渠道至少有一个高质量证据，避免单一渠道主导总结。
  for (const channel of CHANNELS) {
    const candidate = byChannel.get(channel)?.[0];
    if (!candidate) continue;
    if (selectedUrls.has(candidate.url)) continue;
    selected.push(candidate);
    selectedUrls.add(candidate.url);
  }

  const remaining = [...sources].sort((left, right) => right.quality.score - left.quality.score);
  for (const source of remaining) {
    if (selected.length >= MAX_SOURCES_FOR_SYNTHESIS) break;
    if (selectedUrls.has(source.url)) continue;
    selected.push(source);
    selectedUrls.add(source.url);
  }

  return selected;
}

function buildQualityStats(sources: DeepResearchSource[]): DeepResearchResult["qualityStats"] {
  if (sources.length === 0) {
    return {
      avgScore: 0,
      highQualityCount: 0,
      mediumQualityCount: 0,
      lowQualityCount: 0,
      channelAvgScores: CHANNELS.map((channel) => ({
        channel,
        avgScore: 0,
        sourceCount: 0,
      })),
    };
  }

  const scoreTotal = sources.reduce((acc, item) => acc + item.quality.score, 0);
  const highQualityCount = sources.filter((item) => item.quality.grade === "A").length;
  const mediumQualityCount = sources.filter((item) => item.quality.grade === "B").length;
  const lowQualityCount = sources.filter((item) => item.quality.grade === "C").length;

  return {
    avgScore: Number((scoreTotal / sources.length).toFixed(1)),
    highQualityCount,
    mediumQualityCount,
    lowQualityCount,
    channelAvgScores: CHANNELS.map((channel) => {
      const bucket = sources.filter((item) => item.channel === channel);
      const total = bucket.reduce((acc, item) => acc + item.quality.score, 0);
      return {
        channel,
        avgScore: bucket.length > 0 ? Number((total / bucket.length).toFixed(1)) : 0,
        sourceCount: bucket.length,
      };
    }),
  };
}

function splitClaimCandidate(text: string): string {
  const normalized = normalizeText(text, 260);
  if (!normalized) return "";
  const parts = normalized
    .split(/[。；;！？!?]/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 8);
  if (parts.length === 0) return normalized;
  return parts.sort((left, right) => right.length - left.length)[0].slice(0, 180);
}

function tokenizeClaim(text: string): Set<string> {
  const raw = normalizeText(text, 360).toLowerCase();
  if (!raw) return new Set();

  const output = new Set<string>();

  // 英文/数字词元：用于英文标题、术语、品牌名。
  const latinTokens = raw.match(/[a-z0-9]{2,}/g) ?? [];
  for (const token of latinTokens) {
    if (output.size >= 64) break;
    output.add(token);
  }

  // 中文片段转 2~3gram，提升中文语句间的相似性判断稳定性。
  const hanSegments = raw.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  for (const segment of hanSegments) {
    for (let size = 2; size <= 3; size += 1) {
      if (segment.length < size) continue;
      for (let i = 0; i <= segment.length - size; i += 1) {
        output.add(segment.slice(i, i + size));
        if (output.size >= 64) break;
      }
      if (output.size >= 64) break;
    }
    if (output.size >= 64) break;
  }

  return output;
}

function buildTopicClusters(
  sources: DeepResearchSource[],
  minSupportDomains: number,
): DeepResearchEvidenceCluster[] {
  const topicBuckets = new Map<
    string,
    {
      claim: string;
      sourceIndexes: number[];
      domains: Set<string>;
      channels: Set<DeepResearchChannel>;
    }
  >();

  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const text = `${source.title} ${source.snippet}`.toLowerCase();
    for (const topic of TOPIC_CLUSTER_CONFIGS) {
      const matched = topic.keywords.some((keyword) => text.includes(keyword.toLowerCase()));
      if (!matched) continue;
      if (!topicBuckets.has(topic.id)) {
        topicBuckets.set(topic.id, {
          claim: `高频论点：${topic.label}`,
          sourceIndexes: [],
          domains: new Set(),
          channels: new Set(),
        });
      }
      const bucket = topicBuckets.get(topic.id);
      if (!bucket) continue;
      bucket.sourceIndexes.push(index);
      bucket.domains.add(source.domain.toLowerCase());
      bucket.channels.add(source.channel);
    }
  }

  const clusters = TOPIC_CLUSTER_CONFIGS.map((topic, orderIndex) => {
    const bucket = topicBuckets.get(topic.id);
    if (!bucket) return null;
    const supportDomainCount = bucket.domains.size;
    return {
      id: `topic-${orderIndex + 1}`,
      claim: bucket.claim,
      supportDomainCount,
      supportDomains: Array.from(bucket.domains).slice(0, 8),
      supportSourceCount: bucket.sourceIndexes.length,
      channels: Array.from(bucket.channels),
      sourceIndexes: bucket.sourceIndexes,
      accepted: supportDomainCount >= minSupportDomains,
    } satisfies DeepResearchEvidenceCluster;
  })
    .filter((item): item is DeepResearchEvidenceCluster => item !== null)
    .sort(
      (left, right) =>
        Number(right.accepted) - Number(left.accepted) ||
        right.supportDomainCount - left.supportDomainCount ||
        right.supportSourceCount - left.supportSourceCount,
    )
    .slice(0, 20);

  return clusters;
}

function clusterSourcesByClaim(sources: DeepResearchSource[]): EvidenceClusterBuildResult {
  const clusters: EvidenceClusterInternal[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const claimSeed = splitClaimCandidate(`${source.title}。${source.snippet}`);
    const tokens = tokenizeClaim(claimSeed);
    if (tokens.size === 0) continue;

    let target: EvidenceClusterInternal | null = null;
    let bestScore = 0;
    for (const cluster of clusters) {
      const score = jaccardFromSet(tokens, cluster.tokens);
      if (score > bestScore) {
        bestScore = score;
        target = cluster;
      }
    }

    if (!target || bestScore < EVIDENCE_CLUSTER_MATCH_THRESHOLD) {
      const created: EvidenceClusterInternal = {
        id: `cluster-${clusters.length + 1}`,
        claim: claimSeed || source.title,
        tokens,
        sourceIndexes: [index],
        domains: new Set([source.domain.toLowerCase()]),
        channels: new Set([source.channel]),
      };
      clusters.push(created);
      continue;
    }

    target.sourceIndexes.push(index);
    target.domains.add(source.domain.toLowerCase());
    target.channels.add(source.channel);
    target.tokens = new Set([...target.tokens, ...tokens]);
    if (claimSeed.length > target.claim.length) {
      target.claim = claimSeed;
    }
  }

  const semanticClusters: DeepResearchEvidenceCluster[] = clusters
    .map((cluster) => {
      const supportDomainCount = cluster.domains.size;
      return {
        id: cluster.id,
        claim: cluster.claim,
        supportDomainCount,
        supportDomains: Array.from(cluster.domains).slice(0, 8),
        supportSourceCount: cluster.sourceIndexes.length,
        channels: Array.from(cluster.channels),
        sourceIndexes: cluster.sourceIndexes,
        accepted: supportDomainCount >= EVIDENCE_CLUSTER_MIN_SUPPORT_DOMAINS,
      };
    })
    .sort(
      (left, right) =>
        right.supportDomainCount - left.supportDomainCount ||
        right.supportSourceCount - left.supportSourceCount,
    )
    .slice(0, 30);

  const topicClusters = buildTopicClusters(sources, EVIDENCE_CLUSTER_MIN_SUPPORT_DOMAINS);
  const normalizedClusters = [...semanticClusters, ...topicClusters]
    .sort(
      (left, right) =>
        Number(right.accepted) - Number(left.accepted) ||
        right.supportDomainCount - left.supportDomainCount ||
        right.supportSourceCount - left.supportSourceCount,
    )
    .slice(0, 40);

  const acceptedSourceIndexes = new Set<number>();
  for (const cluster of normalizedClusters) {
    if (!cluster.accepted) continue;
    for (const index of cluster.sourceIndexes) acceptedSourceIndexes.add(index);
  }

  return {
    minSupportDomains: EVIDENCE_CLUSTER_MIN_SUPPORT_DOMAINS,
    total: normalizedClusters.length,
    accepted: normalizedClusters.filter((item) => item.accepted).length,
    clusters: normalizedClusters,
    acceptedSourceIndexes,
  };
}

function buildReadiness(
  sources: DeepResearchSource[],
  qualityStats: DeepResearchResult["qualityStats"],
  crossValidation: DeepResearchResult["crossValidation"],
  evidenceClusters: EvidenceClusterBuildResult,
): DeepResearchResult["readiness"] {
  const uniqueDomainCount = new Set(sources.map((item) => item.domain.toLowerCase())).size;
  const coveredChannels = CHANNELS.filter((channel) =>
    sources.some((item) => item.channel === channel),
  ).length;
  const avgSourceScore = qualityStats.avgScore;
  const aGradeSourceCount = qualityStats.highQualityCount;
  const acceptedClusterCount = evidenceClusters.accepted;
  const alignmentUsed = crossValidation.used ? crossValidation.alignmentScore : undefined;

  const coverageScore = Math.min(100, Math.round((coveredChannels / CHANNELS.length) * 100));
  const domainScore = Math.min(
    100,
    Math.round((uniqueDomainCount / READINESS_MIN_UNIQUE_DOMAIN_COUNT) * 100),
  );
  const aGradeScore = Math.min(
    100,
    Math.round((aGradeSourceCount / READINESS_MIN_A_GRADE_COUNT) * 100),
  );

  let score =
    avgSourceScore * 0.45 + coverageScore * 0.2 + domainScore * 0.2 + aGradeScore * 0.15;
  if (typeof alignmentUsed === "number") {
    score = score * 0.8 + alignmentUsed * 0.2;
  }
  score = Number(Math.max(0, Math.min(100, score)).toFixed(1));

  const blockers: string[] = [];
  const suggestions: string[] = [];

  if (avgSourceScore < READINESS_MIN_AVG_SCORE) {
    blockers.push(
      `来源平均质量分 ${avgSourceScore} 低于门槛 ${READINESS_MIN_AVG_SCORE}`,
    );
    suggestions.push("优先补充 A/B 级来源，减少低质量平台内容占比。");
  }
  if (aGradeSourceCount < READINESS_MIN_A_GRADE_COUNT) {
    blockers.push(
      `A 级来源仅 ${aGradeSourceCount} 条，低于门槛 ${READINESS_MIN_A_GRADE_COUNT} 条`,
    );
    suggestions.push("补查高可信渠道（官方 JD、权威招聘平台、行业报告）。");
  }
  if (coveredChannels < READINESS_MIN_COVERED_CHANNELS) {
    blockers.push(
      `覆盖渠道仅 ${coveredChannels} 个，低于门槛 ${READINESS_MIN_COVERED_CHANNELS} 个`,
    );
    suggestions.push("补齐岗位/面经/社区/知识/薪资五类中的缺失渠道。");
  }
  if (uniqueDomainCount < READINESS_MIN_UNIQUE_DOMAIN_COUNT) {
    blockers.push(
      `独立域名仅 ${uniqueDomainCount} 个，低于门槛 ${READINESS_MIN_UNIQUE_DOMAIN_COUNT} 个`,
    );
    suggestions.push("增加不同站点来源，避免单一媒体回音室。");
  }
  if (acceptedClusterCount < READINESS_MIN_ACCEPTED_CLUSTER_COUNT) {
    blockers.push(
      `双域名支撑论点仅 ${acceptedClusterCount} 条，低于门槛 ${READINESS_MIN_ACCEPTED_CLUSTER_COUNT} 条`,
    );
    suggestions.push("继续补充可交叉验证来源，提升论点级共识密度。");
  }
  if (crossValidation.enabled && !crossValidation.used) {
    blockers.push("已开启多模型交叉验证，但本次未成功执行。");
    suggestions.push("补充可用的复核模型名，并重跑 B2.3。");
  } else if (
    crossValidation.enabled &&
    crossValidation.used &&
    crossValidation.alignmentScore < READINESS_MIN_ALIGNMENT
  ) {
    blockers.push(
      `多模型一致度 ${crossValidation.alignmentScore} 低于门槛 ${READINESS_MIN_ALIGNMENT}`,
    );
    suggestions.push("优先处理模型冲突点，再输出最终准备策略。");
  }

  const gatePassed = blockers.length === 0 && score >= 65;
  if (!gatePassed && blockers.length === 0) {
    blockers.push(`研究准备度 ${score} 偏低，建议继续补充证据。`);
  }

  const level: "高" | "中" | "低" = score >= 80 ? "高" : score >= 65 ? "中" : "低";

  return {
    gatePassed,
    score,
    level,
    blockers: blockers.slice(0, 6),
    suggestions: Array.from(new Set(suggestions)).slice(0, 6),
    metrics: {
      uniqueDomainCount,
      coveredChannels,
      avgSourceScore,
      aGradeSourceCount,
      acceptedClusterCount,
      crossModelAlignment: alignmentUsed,
    },
  };
}

type LlmSynthesisOptions = {
  provider?: LlmProvider;
  model?: string;
};

type LlmSynthesisResult = {
  profile: DeepResearchProfile;
  provider?: LlmProvider;
  model?: string;
  error?: string;
};

function normalizeComparable(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9]+/gi, "")
    .trim();
}

function buildComparableMap(items: string[]): Map<string, string> {
  const output = new Map<string, string>();
  for (const item of items) {
    const normalized = normalizeComparable(item);
    if (!normalized) continue;
    if (!output.has(normalized)) output.set(normalized, item);
  }
  return output;
}

function jaccardFromSet(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function collectSummaryKeywords(text: string): Set<string> {
  const parts = text.match(/[\u4e00-\u9fa5a-zA-Z0-9]+/g) ?? [];
  return new Set(
    parts
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length >= 2),
  );
}

function buildCrossValidationResult(
  primaryProfile: DeepResearchProfile,
  reviewerProfile: DeepResearchProfile,
): {
  alignmentScore: number;
  agreements: string[];
  conflicts: string[];
  finalSuggestion: string;
} {
  const agreements: string[] = [];
  const conflicts: string[] = [];

  const primaryResponsibilities = buildComparableMap(primaryProfile.coreResponsibilities);
  const reviewerResponsibilities = buildComparableMap(reviewerProfile.coreResponsibilities);
  const primarySkills = buildComparableMap(primaryProfile.coreSkills.map((item) => item.skill));
  const reviewerSkills = buildComparableMap(reviewerProfile.coreSkills.map((item) => item.skill));
  const primaryThemes = buildComparableMap(
    primaryProfile.interviewQuestionThemes.map((item) => item.theme),
  );
  const reviewerThemes = buildComparableMap(
    reviewerProfile.interviewQuestionThemes.map((item) => item.theme),
  );
  const primaryRisks = buildComparableMap(primaryProfile.risks);
  const reviewerRisks = buildComparableMap(reviewerProfile.risks);
  const primarySummaryKeywords = collectSummaryKeywords(primaryProfile.roleSummary);
  const reviewerSummaryKeywords = collectSummaryKeywords(reviewerProfile.roleSummary);

  const summaryScore = jaccardFromSet(primarySummaryKeywords, reviewerSummaryKeywords);
  const responsibilityScore = jaccardFromSet(
    new Set(primaryResponsibilities.keys()),
    new Set(reviewerResponsibilities.keys()),
  );
  const skillScore = jaccardFromSet(
    new Set(primarySkills.keys()),
    new Set(reviewerSkills.keys()),
  );
  const themeScore = jaccardFromSet(
    new Set(primaryThemes.keys()),
    new Set(reviewerThemes.keys()),
  );
  const riskScore = jaccardFromSet(
    new Set(primaryRisks.keys()),
    new Set(reviewerRisks.keys()),
  );

  const weightedScore =
    summaryScore * 0.2 +
    responsibilityScore * 0.2 +
    skillScore * 0.25 +
    themeScore * 0.2 +
    riskScore * 0.15;
  const alignmentScore = Math.round(weightedScore * 100);

  const commonSkills = [...primarySkills.keys()]
    .filter((key) => reviewerSkills.has(key))
    .slice(0, 3)
    .map((key) => primarySkills.get(key) ?? key);
  if (commonSkills.length > 0) {
    agreements.push(`两模型均强调的核心技能：${commonSkills.join(" / ")}`);
  }

  const commonThemes = [...primaryThemes.keys()]
    .filter((key) => reviewerThemes.has(key))
    .slice(0, 3)
    .map((key) => primaryThemes.get(key) ?? key);
  if (commonThemes.length > 0) {
    agreements.push(`两模型共同识别的面试主题：${commonThemes.join(" / ")}`);
  }

  if (summaryScore >= 0.45) {
    agreements.push("岗位摘要的关键词重合度较高。");
  } else if (summaryScore <= 0.2) {
    conflicts.push("岗位摘要关键词重合度较低，存在理解偏差。");
  }

  if (responsibilityScore <= 0.2) {
    conflicts.push("核心职责识别差异较大，建议补充 JD 类来源。");
  }
  if (themeScore <= 0.2) {
    conflicts.push("面试主题差异较大，建议增加面经来源做复核。");
  }
  if (riskScore <= 0.2) {
    conflicts.push("风险识别差异较大，建议增加社区反馈来源。");
  }

  const primaryOnlySkills = [...primarySkills.keys()]
    .filter((key) => !reviewerSkills.has(key))
    .slice(0, 2)
    .map((key) => primarySkills.get(key) ?? key);
  const reviewerOnlySkills = [...reviewerSkills.keys()]
    .filter((key) => !primarySkills.has(key))
    .slice(0, 2)
    .map((key) => reviewerSkills.get(key) ?? key);

  if (primaryOnlySkills.length > 0 || reviewerOnlySkills.length > 0) {
    conflicts.push(
      `技能分歧：主模型强调[${primaryOnlySkills.join(" / ") || "无"}]，复核模型强调[${reviewerOnlySkills.join(" / ") || "无"}]。`,
    );
  }

  let finalSuggestion = "两模型基本一致，可直接使用当前画像并进入行动清单执行。";
  if (alignmentScore < 70) {
    finalSuggestion = "两模型一致度中等，建议优先补查冲突点后再执行准备策略。";
  }
  if (alignmentScore < 50) {
    finalSuggestion = "两模型差异较大，建议先补充来源并重新生成画像。";
  }

  return {
    alignmentScore,
    agreements: agreements.slice(0, 6),
    conflicts: conflicts.slice(0, 6),
    finalSuggestion,
  };
}

const PROFILE_SYSTEM_PROMPT = `
你是“岗位深度研究分析师”。
输入是多渠道搜索结果（岗位JD、面经、社区讨论、知识文章、薪资信息）。
你要生成一个“岗位画像”，用于求职准备。

只输出 JSON，不要输出额外解释。
JSON 结构：
{
  "roleSummary": "string",
  "coreResponsibilities": ["string"],
  "coreSkills": [
    { "skill": "string", "reason": "string", "priority": "高|中|低" }
  ],
  "interviewQuestionThemes": [
    { "theme": "string", "whyImportant": "string", "sampleQuestions": ["string"] }
  ],
  "marketSignals": ["string"],
  "risks": ["string"],
  "actionPlan": ["string"]
}

要求：
- 结论必须来自输入材料，不编造。
- 优先使用跨渠道重复出现的信息（至少2个渠道出现）。
- 仅使用“已通过论点门槛”的证据：同一结论至少被2个不同域名支持。
- 如果证据冲突，要在 risks 中体现“观点不一致”。
- actionPlan 要可执行，按“本周可做”粒度写。
`.trim();

function buildProfilePrompt(
  input: DeepResearchRequest,
  sources: DeepResearchSource[],
  evidenceClusters?: EvidenceClusterBuildResult,
): string {
  const sourceLines = sources.map(
    (item, index) =>
      `[${index + 1}] 渠道=${item.channel} | 质量=${item.quality.grade}/${item.quality.score} | 标题=${item.title}\nURL=${item.url}\n摘要=${item.snippet}\n评分理由=${item.quality.reasons.join("；")}`,
  );
  const acceptedClusterLines = evidenceClusters
    ? evidenceClusters.clusters
        .filter((item) => item.accepted)
        .slice(0, 12)
        .map(
          (item, index) =>
            `[C${index + 1}] 支撑域名=${item.supportDomainCount} (${item.supportDomains.join(", ")}) | 渠道=${item.channels.join("/")} | 结论=${item.claim}`,
        )
    : [];
  return [
    `目标岗位：${input.targetRole}`,
    `目标公司：${input.company?.trim() || "未指定"}`,
    `关注点：${input.focus?.trim() || "未指定"}`,
    "",
    `论点门槛：至少 ${EVIDENCE_CLUSTER_MIN_SUPPORT_DOMAINS} 个独立域名支持同一结论才可进入画像`,
    acceptedClusterLines.length > 0 ? "已通过门槛的论点聚类：" : "已通过门槛的论点聚类：暂无",
    ...(acceptedClusterLines.length > 0 ? acceptedClusterLines : []),
    "",
    "多渠道检索结果：",
    sourceLines.join("\n\n"),
  ].join("\n");
}

async function synthesizeRoleProfile(
  input: DeepResearchRequest,
  sources: DeepResearchSource[],
  evidenceClusters?: EvidenceClusterBuildResult,
  options?: LlmSynthesisOptions,
): Promise<LlmSynthesisResult> {
  if (sources.length === 0) {
    return {
      profile: normalizeProfile({}),
      provider: options?.provider,
      model: options?.model,
    };
  }
  const selected = pickSynthesisSources(sources);
  try {
    const response = await callLlm({
      messages: [
        { role: "system", content: PROFILE_SYSTEM_PROMPT },
        { role: "user", content: buildProfilePrompt(input, selected, evidenceClusters) },
      ],
      temperature: 0.2,
    }, options);
    const parsed = extractJson(response.content);
    return {
      profile: normalizeProfile(parsed),
      provider: response.provider,
      model: response.model,
    };
  } catch (error) {
    return {
      profile: normalizeProfile({}),
      provider: options?.provider,
      model: options?.model,
      error: error instanceof Error ? error.message : "画像综合失败",
    };
  }
}

export async function runDeepResearchProfile(
  input: DeepResearchRequest,
): Promise<DeepResearchResult> {
  const maxSourcesPerChannel = Math.min(
    Math.max(Number(input.maxSourcesPerChannel ?? DEFAULT_MAX_PER_CHANNEL), 4),
    15,
  );
  const reflectionEnabled = input.enableReflection !== false && DEFAULT_REFLECTION_ENABLED;
  const reflectionQueriesPerChannel = Math.min(
    Math.max(
      Number(input.reflectionQueriesPerChannel ?? DEFAULT_REFLECTION_QUERIES_PER_CHANNEL),
      1,
    ),
    MAX_REFLECTION_QUERIES_PER_CHANNEL,
  );
  const crossValidationEnabled =
    input.enableCrossValidation ?? DEFAULT_CROSS_VALIDATION_ENABLED;

  const firstPassPlan = buildChannelQueries(input);
  const searchTelemetry = createEmptySearchTelemetry();
  const seenUrls = new Set<string>();
  const firstPassSources = await runSearchPass(
    firstPassPlan,
    maxSourcesPerChannel,
    seenUrls,
    searchTelemetry,
  );
  const firstPassSourceCountByChannel = countSourcesByChannel(firstPassSources);
  const firstPassSynthesis = await synthesizeRoleProfile(input, firstPassSources);
  const firstPassProfile = firstPassSynthesis.profile;

  let weakChannels: DeepResearchChannel[] = [];
  let gapHypotheses: string[] = [];
  let reflectionQueries: ReflectionQuery[] = [];
  let secondPassSources: DeepResearchSource[] = [];

  if (reflectionEnabled) {
    weakChannels = inferWeakChannels(
      maxSourcesPerChannel,
      firstPassSourceCountByChannel,
      firstPassProfile,
    );
    gapHypotheses = buildGapHypotheses(
      maxSourcesPerChannel,
      firstPassSourceCountByChannel,
      firstPassProfile,
      weakChannels,
    );
    reflectionQueries = buildReflectionQueries(
      input,
      weakChannels,
      firstPassPlan,
      reflectionQueriesPerChannel,
    );
    if (reflectionQueries.length > 0) {
      const secondPassPlan = groupReflectionQueriesByChannel(reflectionQueries);
      secondPassSources = await runSearchPass(
        secondPassPlan,
        maxSourcesPerChannel,
        seenUrls,
        searchTelemetry,
      );
    }
  }

  const sources = dedupSources([...firstPassSources, ...secondPassSources]);
  const qualityStats = buildQualityStats(sources);
  const evidenceClusters = clusterSourcesByClaim(sources);
  const evidenceFilteredSources = sources.filter((_, index) =>
    evidenceClusters.acceptedSourceIndexes.has(index),
  );

  const finalSynthesis =
    evidenceFilteredSources.length > 0
      ? await synthesizeRoleProfile(input, evidenceFilteredSources, evidenceClusters)
      : {
          profile: normalizeProfile({
            roleSummary:
              "当前检索结果尚未形成足够的跨域名一致论点，暂不建议直接使用该画像做面试决策。",
            risks: [
              "双域名支撑论点不足，存在单一来源偏差风险。",
              "建议补充官方/招聘平台/社区多渠道证据后再生成。",
            ],
            actionPlan: [
              "补齐高质量来源并触发二轮检索。",
              "优先补充 JD、权威招聘平台、真实面经的交叉证据。",
            ],
          }),
          provider: firstPassSynthesis.provider,
          model: firstPassSynthesis.model,
        };
  const profile = finalSynthesis.profile;
  const secondPassSourceCountByChannel = countSourcesByChannel(secondPassSources);
  const queryPlan = mergeQueryPlans(firstPassPlan, reflectionQueries);
  const reflectionSecondPassUsed = reflectionEnabled && reflectionQueries.length > 0;

  const primaryProvider = finalSynthesis.provider ?? firstPassSynthesis.provider;
  const primaryModel = finalSynthesis.model ?? firstPassSynthesis.model;
  const requestedReviewerProvider = input.crossValidationProvider;
  const requestedReviewerModel =
    input.crossValidationModel?.trim() ||
    process.env.DEEP_RESEARCH_REVIEW_MODEL?.trim() ||
    "";
  const reviewerProvider = requestedReviewerProvider ?? primaryProvider;
  let crossValidation: DeepResearchResult["crossValidation"] = {
    enabled: crossValidationEnabled,
    used: false,
    reviewerProvider,
    reviewerModel: requestedReviewerModel || undefined,
    alignmentScore: 0,
    agreements: [],
    conflicts: [],
    finalSuggestion: crossValidationEnabled
      ? "已开启 B2.3，但尚未执行交叉验证。"
      : "未开启 B2.3 交叉验证。",
  };

  if (crossValidationEnabled) {
    if (evidenceFilteredSources.length === 0) {
      crossValidation = {
        ...crossValidation,
        finalSuggestion: "证据聚类门槛未通过，跳过多模型交叉验证。",
      };
    } else {
    const hasDifferentReviewerModel =
      requestedReviewerModel.length > 0 &&
      requestedReviewerModel !== primaryModel;
    const hasDifferentReviewerProvider =
      typeof reviewerProvider === "string" && reviewerProvider !== primaryProvider;
    if (!hasDifferentReviewerModel && !hasDifferentReviewerProvider) {
      crossValidation = {
        ...crossValidation,
        finalSuggestion:
          "未检测到第二模型。请设置 crossValidationModel 或环境变量 DEEP_RESEARCH_REVIEW_MODEL 后重试。",
      };
    } else {
      const reviewerSynthesis = await synthesizeRoleProfile(
        input,
        evidenceFilteredSources,
        evidenceClusters,
        {
        provider: reviewerProvider,
        model: requestedReviewerModel || undefined,
      });
      if (reviewerSynthesis.error) {
        crossValidation = {
          ...crossValidation,
          reviewerProvider:
            reviewerSynthesis.provider ?? reviewerProvider ?? requestedReviewerProvider,
          reviewerModel:
            reviewerSynthesis.model ??
            (requestedReviewerModel ? requestedReviewerModel : undefined),
          conflicts: [`复核模型调用失败：${reviewerSynthesis.error}`],
          finalSuggestion:
            "复核模型执行失败，建议先检查 API Key / 模型名，再重试 B2.3。",
        };
      } else {
        const compare = buildCrossValidationResult(
          profile,
          reviewerSynthesis.profile,
        );
        crossValidation = {
          enabled: true,
          used: true,
          reviewerProvider:
            reviewerSynthesis.provider ?? reviewerProvider ?? requestedReviewerProvider,
          reviewerModel:
            reviewerSynthesis.model ??
            (requestedReviewerModel ? requestedReviewerModel : undefined),
          alignmentScore: compare.alignmentScore,
          agreements: compare.agreements,
          conflicts: compare.conflicts,
          finalSuggestion: compare.finalSuggestion,
        };
      }
    }
    }
  }

  const readiness = buildReadiness(
    sources,
    qualityStats,
    crossValidation,
    evidenceClusters,
  );
  const searchTelemetryOutput: DeepResearchResult["searchTelemetry"] = {
    totalQueries: searchTelemetry.totalQueries,
    primarySuccess: searchTelemetry.primarySuccess,
    fallbackSuccess: searchTelemetry.fallbackSuccess,
    failedQueries: searchTelemetry.failedQueries,
    engineUsage: (Object.entries(searchTelemetry.engineUsage) as Array<
      [DeepResearchSearchEngine, number]
    >)
      .filter(([, count]) => count > 0)
      .sort((left, right) => right[1] - left[1])
      .map(([engine, count]) => ({ engine, count })),
  };

  return {
    generatedAt: new Date().toISOString(),
    searchTelemetry: searchTelemetryOutput,
    queryPlan,
    channelStats: CHANNELS.map((channel) => {
      const firstPassCount = firstPassSourceCountByChannel[channel];
      const secondPassCount = secondPassSourceCountByChannel[channel];
      return {
        channel,
        sourceCount: firstPassCount + secondPassCount,
        firstPassSourceCount: firstPassCount,
        secondPassSourceCount: secondPassCount,
      };
    }),
    sources,
    qualityStats,
    evidenceClusters: {
      minSupportDomains: evidenceClusters.minSupportDomains,
      total: evidenceClusters.total,
      accepted: evidenceClusters.accepted,
      clusters: evidenceClusters.clusters,
    },
    readiness,
    profile,
    crossValidation,
    reflection: {
      enabled: reflectionEnabled,
      secondPassUsed: reflectionSecondPassUsed,
      weakChannels,
      gapHypotheses,
      secondPassQueries: reflectionQueries,
      firstPassSourceCount: firstPassSources.length,
      secondPassSourceCount: secondPassSources.length,
    },
  };
}
