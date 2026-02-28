import type { LibraryEntryInput } from "@/lib/types";

const CAPABILITY_TAGS = [
  "能力:业务理解",
  "能力:数据分析",
  "能力:用户研究",
  "能力:需求分析",
  "能力:产品设计",
  "能力:优先级决策",
  "能力:技术协作",
  "能力:沟通协同",
  "能力:项目推进",
  "能力:商业化",
  "能力:AI产品",
] as const;

const CAPABILITY_RULES: Array<{ tag: (typeof CAPABILITY_TAGS)[number]; pattern: RegExp }> = [
  { tag: "能力:业务理解", pattern: /(业务目标|业务增长|行业|战略|市场|价值|商业模式)/i },
  { tag: "能力:数据分析", pattern: /(留存|转化|漏斗|指标|埋点|ab实验|a\/b|数据|归因|定位问题)/i },
  { tag: "能力:用户研究", pattern: /(用户研究|访谈|调研|画像|用户旅程|可用性|行为日志)/i },
  { tag: "能力:需求分析", pattern: /(需求|prd|文档|场景|拆解|方案评审|边界)/i },
  { tag: "能力:产品设计", pattern: /(产品设计|交互|信息架构|流程设计|原型|体验)/i },
  { tag: "能力:优先级决策", pattern: /(优先级|取舍|排序|资源冲突|决策依据|价值成本)/i },
  { tag: "能力:技术协作", pattern: /(研发|工程|技术|接口|上线|稳定性|架构|可扩展)/i },
  { tag: "能力:沟通协同", pattern: /(沟通|汇报|说服|对齐|跨团队|协同|利益相关方)/i },
  { tag: "能力:项目推进", pattern: /(项目推进|里程碑|排期|执行|风险管理|复盘|闭环)/i },
  { tag: "能力:商业化", pattern: /(商业化|变现|收入|roi|成本|利润|定价)/i },
  { tag: "能力:AI产品", pattern: /(ai|大模型|agent|rag|提示词|模型|推理)/i },
];

const LEGACY_TAG_TO_CAPABILITY: Record<string, (typeof CAPABILITY_TAGS)[number]> = {
  指标分析: "能力:数据分析",
  数据分析: "能力:数据分析",
  用户研究: "能力:用户研究",
  优先级: "能力:优先级决策",
  需求文档: "能力:需求分析",
  PRD: "能力:需求分析",
  方法论: "能力:需求分析",
  跨团队协作: "能力:沟通协同",
  工程协同: "能力:技术协作",
  商业化: "能力:商业化",
  项目复盘: "能力:项目推进",
  AI产品: "能力:AI产品",
  AI产品设计: "能力:AI产品",
  竞品分析: "能力:业务理解",
  竞品策略: "能力:业务理解",
  战略判断: "能力:业务理解",
};

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  return Array.from(new Set(tags.map((item) => item.trim()).filter(Boolean)));
}

function inferDifficulty(round: string | undefined): string {
  const value = (round ?? "").trim();
  if (value.includes("一面")) return "难度:基础";
  if (value.includes("二面")) return "难度:进阶";
  if (value.includes("终")) return "难度:挑战";
  if (value.toUpperCase().includes("HR")) return "难度:基础";
  return "难度:进阶";
}

function inferQuestionType(question: string): string {
  const q = question.trim();
  if (/为什么/.test(q)) return "题型:动机匹配";
  if (/如果|假设|遇到/.test(q)) return "题型:情景应对";
  if (/如何|怎么|怎样/.test(q)) return "题型:方法策略";
  return "题型:综合判断";
}

function inferCapabilityTags(entry: LibraryEntryInput): string[] {
  const result = new Set<(typeof CAPABILITY_TAGS)[number]>();
  const corpus = [entry.question, entry.pitfall, entry.betterAnswer].join(" ");

  for (const rule of CAPABILITY_RULES) {
    if (rule.pattern.test(corpus)) result.add(rule.tag);
  }

  for (const tag of entry.tags ?? []) {
    const mapped = LEGACY_TAG_TO_CAPABILITY[tag];
    if (mapped) result.add(mapped);
  }

  // Ensure each entry has at least two capability tags for retrieval quality.
  if (result.size === 0) {
    result.add("能力:业务理解");
    result.add("能力:沟通协同");
  } else if (result.size === 1) {
    if (!result.has("能力:沟通协同")) result.add("能力:沟通协同");
    else result.add("能力:业务理解");
  }

  return Array.from(result);
}

function roundToPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

export type PmDemoQualitySummary = {
  standardizedRate: number;
  avgCapabilityTagsPerEntry: number;
  capabilityCoverageRate: number;
  missingCapabilities: string[];
  difficultyDistribution: Record<string, number>;
  capabilityDistribution: Record<string, number>;
};

export function enrichPmDemoEntry(input: LibraryEntryInput): LibraryEntryInput {
  const baseTags = normalizeTags(input.tags);
  const capabilityTags = inferCapabilityTags(input);
  const difficultyTag = inferDifficulty(input.round);
  const questionTypeTag = inferQuestionType(input.question);

  const preserved = baseTags.filter(
    (tag) => !tag.startsWith("难度:") && !tag.startsWith("能力:") && !tag.startsWith("题型:"),
  );

  const tags = normalizeTags([
    "PM内置库",
    "Demo",
    ...preserved,
    difficultyTag,
    questionTypeTag,
    ...capabilityTags,
  ]);

  return {
    ...input,
    tags: tags.slice(0, 20),
  };
}

export function summarizePmDemoQuality(entries: LibraryEntryInput[]): PmDemoQualitySummary {
  if (entries.length === 0) {
    return {
      standardizedRate: 0,
      avgCapabilityTagsPerEntry: 0,
      capabilityCoverageRate: 0,
      missingCapabilities: [...CAPABILITY_TAGS],
      difficultyDistribution: {},
      capabilityDistribution: {},
    };
  }

  const difficultyDistribution: Record<string, number> = {};
  const capabilityDistribution: Record<string, number> = {};

  let standardizedCount = 0;
  let capabilityTagTotal = 0;

  for (const entry of entries) {
    const tags = normalizeTags(entry.tags);
    const difficultyTags = tags.filter((tag) => tag.startsWith("难度:"));
    const capabilityTags = tags.filter((tag) => tag.startsWith("能力:"));

    if (difficultyTags.length >= 1 && capabilityTags.length >= 2) standardizedCount += 1;
    capabilityTagTotal += capabilityTags.length;

    for (const tag of difficultyTags) {
      difficultyDistribution[tag] = (difficultyDistribution[tag] ?? 0) + 1;
    }
    for (const tag of capabilityTags) {
      capabilityDistribution[tag] = (capabilityDistribution[tag] ?? 0) + 1;
    }
  }

  const coveredCapabilities = Object.keys(capabilityDistribution);
  const missingCapabilities = CAPABILITY_TAGS.filter((tag) => !coveredCapabilities.includes(tag));

  return {
    standardizedRate: roundToPercent((standardizedCount / entries.length) * 100),
    avgCapabilityTagsPerEntry: roundToPercent(capabilityTagTotal / entries.length),
    capabilityCoverageRate: roundToPercent(
      ((CAPABILITY_TAGS.length - missingCapabilities.length) / CAPABILITY_TAGS.length) * 100,
    ),
    missingCapabilities,
    difficultyDistribution,
    capabilityDistribution,
  };
}
