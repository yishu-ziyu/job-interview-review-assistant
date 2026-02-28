import type { ResearchProvider } from "@/lib/types";

export const CAPTURE_PREFIX = "INTERVIEW_RESEARCH_CAPTURE_V1";

const MAX_CAPTURE_TEXT = 60000;
const MAX_CAPTURE_SOURCE_URLS = 8;
const REDIRECT_QUERY_KEYS = [
  "target",
  "url",
  "redirect",
  "redirect_url",
  "jump",
  "to",
  "dest",
  "destination",
  "link",
  "outlink",
];

export type BrowserCapturePayload = {
  version: string;
  source: string;
  pageUrl: string;
  pageTitle: string;
  capturedAt: string;
  reportText: string;
  sourceUrls: string[];
  providerHint: ResearchProvider;
};

export type CaptureCleanResult = {
  cleanedText: string;
  originalLength: number;
  cleanedLength: number;
  originalLineCount: number;
  cleanedLineCount: number;
  removedLineCount: number;
};

export type CaptureContextSuggestions = {
  targetRoles: string[];
  companies: string[];
  confidence: "high" | "medium" | "low";
};

export type CompanyAliasEntry = {
  company: string;
  aliases: string[];
};

function normalizeText(value: unknown, maxLength = 500): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text) return "";
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function parseUrl(value: string, baseUrl?: string): URL | null {
  try {
    if (baseUrl) return new URL(value, baseUrl);
    return new URL(value);
  } catch {
    return null;
  }
}

function decodeRedirectTarget(rawUrl: string, baseUrl?: string): string {
  const parsed = parseUrl(rawUrl, baseUrl);
  if (!parsed) return "";
  for (const key of REDIRECT_QUERY_KEYS) {
    const queryValue = parsed.searchParams.get(key);
    if (!queryValue) continue;
    const decoded = decodeURIComponent(queryValue);
    const nested = parseUrl(decoded, parsed.toString()) ?? parseUrl(queryValue, parsed.toString());
    if (nested && (nested.protocol === "http:" || nested.protocol === "https:")) {
      return nested.toString();
    }
  }
  return parsed.toString();
}

function normalizeUrl(value: unknown, baseUrl?: string): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  const decoded = decodeRedirectTarget(raw, baseUrl);
  if (!decoded) return null;
  const parsed = parseUrl(decoded);
  if (!parsed) return null;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString();
}

function normalizeProvider(value: unknown): ResearchProvider {
  if (value === "gemini") return "gemini";
  if (value === "gpt") return "gpt";
  if (value === "doubao") return "doubao";
  if (value === "zhipu") return "zhipu";
  return "other";
}

function parseJsonPacket(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function extractInlineUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s"'<>，。)）\]]+/g);
  if (!matches) return [];
  return matches.slice(0, 40);
}

export function isLikelyConversationOrAppUrl(url: string, pageUrl?: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  const pathname = parsed.pathname.toLowerCase();
  const host = parsed.hostname.toLowerCase();

  const conversationPathHints = [
    "/chat",
    "/conversation",
    "/c/",
    "/explore",
    "/discover",
    "/history",
    "/session",
  ];
  const looksLikeConversationPath = conversationPathHints.some((part) =>
    pathname.includes(part),
  );
  if (looksLikeConversationPath) return true;

  if (pageUrl) {
    const pageParsed = parseUrl(pageUrl);
    if (pageParsed && pageParsed.hostname === parsed.hostname) {
      const appPathHints = ["/chat", "/new", "/workspace", "/settings", "/profile"];
      if (appPathHints.some((part) => pathname.startsWith(part))) return true;
    }
  }

  const appHosts = ["doubao.com", "chatgpt.com", "gemini.google.com", "claude.ai"];
  if (appHosts.some((domain) => host.includes(domain)) && looksLikeConversationPath) {
    return true;
  }
  return false;
}

function normalizeSourceUrls(rawUrls: unknown[], pageUrl: string, reportText: string): string[] {
  const page = normalizeUrl(pageUrl);
  const inlineUrls = extractInlineUrls(reportText);
  const normalized = Array.from(
    new Set(
      [...rawUrls, ...inlineUrls]
        .map((item) => normalizeUrl(item, page ?? undefined))
        .filter((item): item is string => Boolean(item)),
    ),
  );

  const externalRefs = normalized.filter(
    (url) => !isLikelyConversationOrAppUrl(url, page ?? undefined),
  );
  if (externalRefs.length > 0) {
    return externalRefs.slice(0, MAX_CAPTURE_SOURCE_URLS);
  }

  if (normalized.length > 0) {
    return normalized.slice(0, MAX_CAPTURE_SOURCE_URLS);
  }

  if (page) return [page];
  return [];
}

export function guessProviderFromUrl(url: string): ResearchProvider {
  const host = url.toLowerCase();
  if (host.includes("gemini.google.com") || host.includes("ai.google.dev")) {
    return "gemini";
  }
  if (host.includes("chatgpt.com") || host.includes("openai.com")) {
    return "gpt";
  }
  if (host.includes("doubao.com") || host.includes("ark.cn-beijing.volces.com")) {
    return "doubao";
  }
  if (host.includes("bigmodel.cn") || host.includes("zhipu")) {
    return "zhipu";
  }
  return "other";
}

export function parseBrowserCapture(raw: string): BrowserCapturePayload | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const rawPacket = fenced?.[1]?.trim() ?? trimmed;

  const payloadText = rawPacket.startsWith(CAPTURE_PREFIX)
    ? rawPacket.slice(CAPTURE_PREFIX.length).trim()
    : rawPacket;
  const payloadJson = payloadText.startsWith(":")
    ? payloadText.slice(1).trim()
    : payloadText;

  const parsed = parseJsonPacket(payloadJson);
  if (!parsed) return null;

  const pageUrl = normalizeUrl(parsed.pageUrl) ?? "";
  const pageTitle = normalizeText(parsed.pageTitle ?? parsed.title, 200);
  const reportText = normalizeText(
    parsed.reportText ?? parsed.text ?? parsed.content,
    MAX_CAPTURE_TEXT,
  );
  if (reportText.length < 80) return null;

  const sourceUrlCandidates = Array.isArray(parsed.sourceUrls) ? parsed.sourceUrls : [];
  const sourceUrls = normalizeSourceUrls(sourceUrlCandidates, pageUrl, reportText);

  const capturedAtRaw =
    typeof parsed.capturedAt === "string" ? new Date(parsed.capturedAt) : new Date();
  const capturedAt = Number.isNaN(capturedAtRaw.getTime())
    ? new Date().toISOString()
    : capturedAtRaw.toISOString();

  const providerHint = normalizeProvider(parsed.providerHint ?? guessProviderFromUrl(pageUrl));

  return {
    version: normalizeText(parsed.version, 30) || "b1.v1",
    source: normalizeText(parsed.source, 50) || "manual-bookmarklet",
    pageUrl,
    pageTitle,
    capturedAt,
    reportText,
    sourceUrls,
    providerHint,
  };
}

export function mergeSourceUrlLines(
  existingLines: string,
  incomingUrls: string[],
): string {
  const existing = existingLines
    .split(/\n|,|，|;|；/)
    .map((item) => normalizeUrl(item))
    .filter((item): item is string => Boolean(item));
  const incoming = incomingUrls
    .map((item) => normalizeUrl(item))
    .filter((item): item is string => Boolean(item));
  const merged = Array.from(new Set([...incoming, ...existing]));
  const hasExternal = merged.some((url) => !isLikelyConversationOrAppUrl(url));
  const prioritized = hasExternal
    ? merged.filter((url) => !isLikelyConversationOrAppUrl(url))
    : merged;
  return prioritized.slice(0, MAX_CAPTURE_SOURCE_URLS).join("\n");
}

const BOOKMARKLET_SOURCE = `
(function(){
  try{
    var MAX_TEXT=${MAX_CAPTURE_TEXT};
    var MAX_URLS=${MAX_CAPTURE_SOURCE_URLS};
    var host=(location.hostname||"").toLowerCase();
    var provider="other";
    if(host.indexOf("gemini.google.com")>=0||host.indexOf("ai.google.dev")>=0){provider="gemini";}
    else if(host.indexOf("chatgpt.com")>=0||host.indexOf("openai.com")>=0){provider="gpt";}
    else if(host.indexOf("doubao.com")>=0||host.indexOf("volces.com")>=0){provider="doubao";}
    else if(host.indexOf("bigmodel.cn")>=0||host.indexOf("zhipu")>=0){provider="zhipu";}

    function toUrl(raw,base){
      try{return new URL(String(raw||""),base||location.href);}catch(e){return null;}
    }
    function decodeRedirect(raw){
      var parsed=toUrl(raw,location.href);
      if(!parsed){return "";}
      var keys=["target","url","redirect","redirect_url","jump","to","dest","destination","link","outlink"];
      for(var i=0;i<keys.length;i++){
        var value=parsed.searchParams.get(keys[i]);
        if(!value){continue;}
        var decoded=value;
        try{decoded=decodeURIComponent(value);}catch(e){}
        var nested=toUrl(decoded,parsed.toString())||toUrl(value,parsed.toString());
        if(nested&&(nested.protocol==="http:"||nested.protocol==="https:")){
          return nested.toString();
        }
      }
      return parsed.toString();
    }
    function isConversationUrl(url){
      var parsed=toUrl(url);
      if(!parsed){return false;}
      var path=(parsed.pathname||"").toLowerCase();
      var hints=["/chat","/conversation","/c/","/explore","/discover","/history","/session"];
      for(var i=0;i<hints.length;i++){
        if(path.indexOf(hints[i])>=0){return true;}
      }
      return false;
    }

    var text=(document.body&&document.body.innerText?document.body.innerText:"")
      .replace(/\\n{3,}/g,"\\n\\n")
      .trim()
      .slice(0,MAX_TEXT);

    var urls=[];
    var dedup={};
    function pushUrl(raw){
      if(!raw){return;}
      var decoded=decodeRedirect(raw);
      if(!decoded){return;}
      var parsed=toUrl(decoded);
      if(!parsed){return;}
      if(parsed.protocol!=="http:"&&parsed.protocol!=="https:"){return;}
      var normalized=parsed.toString();
      if(dedup[normalized]){return;}
      dedup[normalized]=true;
      urls.push(normalized);
    }

    var nodes=document.querySelectorAll("a[href],[data-url],[data-href],[data-link],[data-source-url],[data-jump-url],[data-target-url]");
    for(var n=0;n<nodes.length;n++){
      var node=nodes[n];
      if(node.tagName==="A"){
        pushUrl(node.getAttribute("href")||node.href||"");
      }
      pushUrl(node.getAttribute("data-url")||"");
      pushUrl(node.getAttribute("data-href")||"");
      pushUrl(node.getAttribute("data-link")||"");
      pushUrl(node.getAttribute("data-source-url")||"");
      pushUrl(node.getAttribute("data-jump-url")||"");
      pushUrl(node.getAttribute("data-target-url")||"");
    }

    var inline=(text.match(/https?:\\/\\/[^\\s"'<>，。)）\\]]+/g)||[]);
    for(var i=0;i<inline.length&&i<40;i++){pushUrl(inline[i]);}

    var external=[];
    for(var j=0;j<urls.length;j++){
      if(!isConversationUrl(urls[j])){external.push(urls[j]);}
    }
    var selected=(external.length>0?external:urls).slice(0,MAX_URLS);
    if(selected.length===0){selected=[location.href];}

    var payload={
      version:"b1.v2",
      source:"manual-bookmarklet",
      pageUrl:location.href,
      pageTitle:document.title||"",
      capturedAt:new Date().toISOString(),
      reportText:text,
      sourceUrls:selected,
      providerHint:provider
    };
    var packet="${CAPTURE_PREFIX}\\n"+JSON.stringify(payload);
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(packet).then(function(){
        alert("抓取成功（优先参考资料外链），回到复盘助手点“读取抓取结果”。");
      }).catch(function(){
        window.prompt("复制以下内容到复盘助手：",packet);
      });
    }else{
      window.prompt("复制以下内容到复盘助手：",packet);
    }
  }catch(error){
    alert("抓取失败: "+(error&&error.message?error.message:error));
  }
})();
`.trim();

export function getCaptureBookmarklet(): string {
  return `javascript:eval(decodeURIComponent('${encodeURIComponent(BOOKMARKLET_SOURCE)}'))`;
}

function shouldDropAsNoise(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) return true;
  if (/^\d+\/\d+$/.test(normalized)) return true;
  if (/^https?:\/\/\S+$/.test(normalized)) return true;
  if (normalized.length <= 1) return true;

  const exactNoise = new Set([
    "新对话",
    "搜索",
    "发送",
    "继续",
    "重新生成",
    "重新回答",
    "复制",
    "分享",
    "点赞",
    "评论",
    "收藏",
    "查看更多",
    "展开",
    "收起",
    "返回",
    "继续提问",
    "继续追问",
    "ChatGPT 可能会犯错",
  ]);
  if (exactNoise.has(normalized)) return true;

  const noiseKeywords = [
    "登录",
    "注册",
    "切换模型",
    "开始新对话",
    "上传图片",
    "附件",
    "语音输入",
    "联网搜索",
    "工具箱",
    "免责声明",
    "复制代码",
    "停止生成",
    "重试",
    "继续生成",
  ];
  if (
    normalized.length < 20 &&
    noiseKeywords.some((keyword) => normalized.includes(keyword))
  ) {
    return true;
  }
  return false;
}

export function cleanCapturedReportText(rawText: string): CaptureCleanResult {
  const original = rawText.replace(/\r\n/g, "\n").trim();
  const originalLines = original.split("\n");

  const uniqueLines: string[] = [];
  const seen = new Set<string>();
  for (const line of originalLines) {
    const normalized = line.replace(/\s+/g, " ").trim();
    if (!normalized || shouldDropAsNoise(normalized)) continue;
    if (!seen.has(normalized)) {
      uniqueLines.push(normalized);
      seen.add(normalized);
    }
  }

  let cleaned = uniqueLines.join("\n");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  if (cleaned.length < 80) {
    cleaned = original;
  }

  const cleanedLines = cleaned.split("\n");
  return {
    cleanedText: cleaned,
    originalLength: original.length,
    cleanedLength: cleaned.length,
    originalLineCount: originalLines.length,
    cleanedLineCount: cleanedLines.length,
    removedLineCount: Math.max(originalLines.length - cleanedLines.length, 0),
  };
}

export function normalizeCompanyAliasDictionary(
  entries: CompanyAliasEntry[],
): CompanyAliasEntry[] {
  const map = new Map<string, Set<string>>();
  for (const entry of entries) {
    const company = (entry.company ?? "").trim();
    if (!company) continue;
    if (!map.has(company)) map.set(company, new Set());
    const bucket = map.get(company);
    if (!bucket) continue;

    bucket.add(company);
    for (const alias of entry.aliases ?? []) {
      const normalized = String(alias).trim();
      if (!normalized) continue;
      bucket.add(normalized);
    }
  }

  return Array.from(map.entries())
    .map(([company, aliases]) => ({
      company,
      aliases: Array.from(aliases).slice(0, 20),
    }))
    .slice(0, 400);
}

export const DEFAULT_COMPANY_ALIAS_DICT: CompanyAliasEntry[] = [
  { company: "字节跳动", aliases: ["字节", "字节跳动", "抖音", "飞书", "今日头条", "懂车帝", "bytedance", "doubao"] },
  { company: "腾讯", aliases: ["腾讯", "tencent", "微信", "qq", "腾讯云"] },
  { company: "阿里巴巴", aliases: ["阿里", "阿里巴巴", "alibaba", "淘宝", "天猫", "支付宝", "钉钉", "夸克"] },
  { company: "百度", aliases: ["百度", "baidu", "文心"] },
  { company: "美团", aliases: ["美团"] },
  { company: "京东", aliases: ["京东", "jd.com", "jd"] },
  { company: "小红书", aliases: ["小红书", "red"] },
  { company: "快手", aliases: ["快手", "kuaishou"] },
  { company: "拼多多", aliases: ["拼多多", "pdd", "temu"] },
  { company: "华为", aliases: ["华为", "huawei"] },
  { company: "小米", aliases: ["小米", "xiaomi"] },
  { company: "网易", aliases: ["网易", "netease"] },
  { company: "哔哩哔哩", aliases: ["哔哩哔哩", "bilibili", "b站"] },
  { company: "滴滴", aliases: ["滴滴", "didi"] },
  { company: "携程", aliases: ["携程", "trip.com"] },
  { company: "理想汽车", aliases: ["理想汽车", "理想"] },
  { company: "蔚来", aliases: ["蔚来", "nio"] },
  { company: "比亚迪", aliases: ["比亚迪", "byd"] },
  { company: "招商银行", aliases: ["招商银行", "招行", "cmb"] },
  { company: "工商银行", aliases: ["工商银行", "工行", "icbc"] },
  { company: "中国银行", aliases: ["中国银行", "中行", "boc"] },
  { company: "建设银行", aliases: ["建设银行", "建行", "ccb"] },
  { company: "农业银行", aliases: ["农业银行", "农行", "abc"] },
];

const ROLE_HINTS: Array<{ role: string; keywords: string[] }> = [
  {
    role: "AI 产品经理",
    keywords: [
      "ai 产品",
      "ai产品",
      "aigc",
      "大模型",
      "llm",
      "agent",
      "智能体",
      "prompt",
      "copilot",
      "模型应用",
      "算法产品",
    ],
  },
  {
    role: "数据产品经理",
    keywords: ["数据产品", "指标体系", "数据治理", "埋点", "bi", "数仓", "数据中台"],
  },
  {
    role: "增长产品经理",
    keywords: ["增长", "拉新", "留存", "转化", "ab 实验", "a/b", "漏斗"],
  },
  {
    role: "商业化产品经理",
    keywords: ["商业化", "广告投放", "ad", "变现", "出价", "投放策略"],
  },
  {
    role: "策略产品经理",
    keywords: ["策略产品", "推荐系统", "排序", "风控策略", "审核策略"],
  },
  {
    role: "产品经理",
    keywords: ["产品经理", "product manager", "pm", "产品岗", "需求分析", "prd"],
  },
];

function countKeywordMatches(source: string, keywords: string[]): number {
  let score = 0;
  for (const keyword of keywords) {
    const safe = keyword.trim().toLowerCase();
    if (!safe) continue;
    if (source.includes(safe)) score += 1;
  }
  return score;
}

function hostCompanyHint(url: string): string | null {
  const parsed = parseUrl(url);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  if (host.includes("doubao.com") || host.includes("volcengine.com")) return "字节跳动";
  if (host.includes("chatgpt.com") || host.includes("openai.com")) return "OpenAI";
  if (host.includes("gemini.google.com") || host.includes("google.com")) return "Google";
  if (host.includes("minimax") || host.includes("ababtech.com")) return "MiniMax";
  if (host.includes("bigmodel.cn") || host.includes("zhipu")) return "智谱";
  return null;
}

function extractCompaniesFromText(
  source: string,
  companyAliasDict: CompanyAliasEntry[],
): string[] {
  const matched: Array<{ company: string; score: number }> = [];
  for (const row of companyAliasDict) {
    const score = countKeywordMatches(source, row.aliases);
    if (score > 0) matched.push({ company: row.company, score });
  }

  const regexCompanies: string[] = [];
  const regex = /([\u4e00-\u9fa5]{2,12}(?:公司|集团|科技|网络|银行|汽车|资本|证券))/g;
  for (const item of source.match(regex) ?? []) {
    const cleaned = item.replace(/^(在|去|投递|面试|应聘)/, "");
    if (cleaned.length >= 3 && cleaned.length <= 16) {
      regexCompanies.push(cleaned);
    }
  }

  const fromAlias = matched
    .sort((a, b) => b.score - a.score)
    .map((item) => item.company);
  return Array.from(new Set([...fromAlias, ...regexCompanies])).slice(0, 5);
}

function extractRolesFromText(source: string): string[] {
  const scored = ROLE_HINTS.map((row) => ({
    role: row.role,
    score: countKeywordMatches(source, row.keywords),
  }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const roles = scored.map((item) => item.role);
  if (roles.length === 0) return ["产品经理"];
  if (roles[0] !== "产品经理") roles.push("产品经理");
  return Array.from(new Set(roles)).slice(0, 4);
}

export function inferCaptureContextSuggestions(payload: {
  pageTitle?: string;
  pageUrl?: string;
  reportText: string;
  sourceUrls?: string[];
  companyAliasDict?: CompanyAliasEntry[];
}): CaptureContextSuggestions {
  const source = [
    payload.pageTitle ?? "",
    payload.reportText.slice(0, 12000),
    (payload.sourceUrls ?? []).join("\n"),
    payload.pageUrl ?? "",
  ]
    .join("\n")
    .toLowerCase();

  const companiesFromText = extractCompaniesFromText(
    source,
    payload.companyAliasDict && payload.companyAliasDict.length > 0
      ? payload.companyAliasDict
      : DEFAULT_COMPANY_ALIAS_DICT,
  );
  const hostHints = [
    ...(payload.sourceUrls ?? []).map((item) => hostCompanyHint(item)),
    hostCompanyHint(payload.pageUrl ?? ""),
  ].filter((item): item is string => Boolean(item));

  const companies = Array.from(new Set([...companiesFromText, ...hostHints])).slice(0, 5);
  const targetRoles = extractRolesFromText(source);

  const confidence: CaptureContextSuggestions["confidence"] =
    companies.length > 0 && targetRoles.length > 0
      ? "high"
      : companies.length > 0 || targetRoles.length > 0
        ? "medium"
        : "low";

  return {
    targetRoles,
    companies,
    confidence,
  };
}
