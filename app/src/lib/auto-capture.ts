import { CAPTURE_PREFIX, guessProviderFromUrl, parseBrowserCapture } from "@/lib/browser-capture";
import type { ResearchProvider } from "@/lib/types";

const DEFAULT_WAIT_MS = 3500;
const MIN_WAIT_MS = 800;
const MAX_WAIT_MS = 15000;
const NAVIGATION_TIMEOUT_MS = 45000;

type BrowserLike = {
  close: () => Promise<void>;
  newContext: (options?: {
    locale?: string;
    userAgent?: string;
    viewport?: { width: number; height: number };
  }) => Promise<ContextLike>;
};

type ContextLike = {
  close: () => Promise<void>;
  newPage: () => Promise<PageLike>;
};

type PageLike = {
  goto: (
    url: string,
    options?: { waitUntil?: "domcontentloaded" | "load" | "networkidle"; timeout?: number },
  ) => Promise<unknown>;
  waitForTimeout: (timeoutMs: number) => Promise<void>;
  waitForLoadState: (
    state: "domcontentloaded" | "load" | "networkidle",
    options?: { timeout?: number },
  ) => Promise<void>;
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
};

export type AutoCaptureInput = {
  pageUrl: string;
  providerHint?: ResearchProvider;
  waitMs?: number;
};

export type AutoCaptureOutput = {
  pageUrl: string;
  pageTitle: string;
  capturedAt: string;
  providerHint: ResearchProvider;
  reportText: string;
  sourceUrls: string[];
};

function clampWaitMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_WAIT_MS;
  return Math.max(MIN_WAIT_MS, Math.min(MAX_WAIT_MS, Math.round(value)));
}

function normalizeUrl(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error("页面 URL 不能为空。");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("页面 URL 不合法，请输入完整 http/https 地址。");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持 http/https 页面地址。");
  }
  return parsed.toString();
}

function looksLikeLoginOrBlocked(text: string, title: string): boolean {
  const merged = `${title} ${text}`.toLowerCase();
  const keywords = [
    "登录",
    "注册",
    "请先登录",
    "扫码登录",
    "验证",
    "人机验证",
    "access denied",
    "forbidden",
    "sign in",
    "log in",
  ];
  return keywords.some((item) => merged.includes(item));
}

async function launchBrowser(): Promise<BrowserLike> {
  const { chromium } = await import("playwright");
  const errors: string[] = [];
  const attempts: Array<{
    label: string;
    run: () => Promise<BrowserLike>;
  }> = [
    {
      label: "chrome",
      run: () =>
        chromium.launch({
          channel: "chrome",
          headless: true,
        }) as Promise<BrowserLike>,
    },
    {
      label: "msedge",
      run: () =>
        chromium.launch({
          channel: "msedge",
          headless: true,
        }) as Promise<BrowserLike>,
    },
    {
      label: "chromium",
      run: () =>
        chromium.launch({
          headless: true,
        }) as Promise<BrowserLike>,
    },
  ];

  for (const attempt of attempts) {
    try {
      return await attempt.run();
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      errors.push(`${attempt.label}: ${message}`);
    }
  }

  throw new Error(
    `无法启动自动抓取浏览器。请先安装浏览器内核（npx playwright install chromium）或确认本机 Chrome 可用。${errors.join(" | ")}`,
  );
}

async function openPotentialCitationPanels(page: PageLike): Promise<number> {
  const clicked = await page.evaluate(() => {
    const labels = [
      "参考资料",
      "参考文献",
      "引用",
      "来源",
      "sources",
      "source",
      "citations",
      "资料",
    ];
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        "button,[role='button'],summary,[aria-controls],[aria-expanded]",
      ),
    );
    let count = 0;
    for (const element of candidates) {
      if (count >= 6) break;
      const text = (element.innerText || element.textContent || "").trim().toLowerCase();
      if (!text) continue;
      if (!labels.some((label) => text.includes(label))) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (element.getAttribute("aria-disabled") === "true") continue;
      element.click();
      count += 1;
    }
    return count;
  });

  if (clicked > 0) {
    await page.waitForTimeout(1200);
  }
  return clicked;
}

async function collectPageSnapshot(page: PageLike): Promise<{
  pageTitle: string;
  reportText: string;
  sourceUrls: string[];
}> {
  return page.evaluate(() => {
    const MAX_TEXT = 60000;
    const MAX_URLS = 16;
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

    function toUrl(raw: string, base?: string): URL | null {
      try {
        return new URL(raw, base || location.href);
      } catch {
        return null;
      }
    }

    function decodeRedirect(raw: string): string {
      const parsed = toUrl(raw, location.href);
      if (!parsed) return "";
      for (const key of REDIRECT_QUERY_KEYS) {
        const value = parsed.searchParams.get(key);
        if (!value) continue;
        let decoded = value;
        try {
          decoded = decodeURIComponent(value);
        } catch {
          decoded = value;
        }
        const nested = toUrl(decoded, parsed.toString()) || toUrl(value, parsed.toString());
        if (nested && (nested.protocol === "http:" || nested.protocol === "https:")) {
          return nested.toString();
        }
      }
      return parsed.toString();
    }

    const text = (document.body?.innerText || "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\u00a0/g, " ")
      .trim()
      .slice(0, MAX_TEXT);

    const sourceUrls: string[] = [];
    const seen = new Set<string>();
    const pushUrl = (raw: string | null | undefined) => {
      if (!raw) return;
      const decoded = decodeRedirect(raw);
      if (!decoded) return;
      const parsed = toUrl(decoded);
      if (!parsed) return;
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      const normalized = parsed.toString();
      if (seen.has(normalized)) return;
      seen.add(normalized);
      sourceUrls.push(normalized);
    };

    const nodes = document.querySelectorAll(
      "a[href],[data-url],[data-href],[data-link],[data-source-url],[data-jump-url],[data-target-url]",
    );
    for (const node of nodes) {
      if (sourceUrls.length >= MAX_URLS) break;
      if (node instanceof HTMLAnchorElement) {
        pushUrl(node.getAttribute("href") || node.href);
      }
      if (node instanceof HTMLElement) {
        pushUrl(node.dataset.url);
        pushUrl(node.dataset.href);
        pushUrl(node.dataset.link);
        pushUrl(node.dataset.sourceUrl);
        pushUrl(node.dataset.jumpUrl);
        pushUrl(node.dataset.targetUrl);
      }
    }

    const inlineUrls = text.match(/https?:\/\/[^\s"'<>，。)）\]]+/g) ?? [];
    for (const inline of inlineUrls) {
      if (sourceUrls.length >= MAX_URLS) break;
      pushUrl(inline);
    }

    return {
      pageTitle: (document.title || "").trim(),
      reportText: text,
      sourceUrls: sourceUrls.slice(0, MAX_URLS),
    };
  });
}

export async function captureResearchPage(input: AutoCaptureInput): Promise<AutoCaptureOutput> {
  const pageUrl = normalizeUrl(input.pageUrl);
  const providerHint = input.providerHint ?? guessProviderFromUrl(pageUrl);
  const waitMs = clampWaitMs(input.waitMs);

  const browser = await launchBrowser();
  const context = await browser.newContext({
    locale: "zh-CN",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
  });

  try {
    const page = await context.newPage();
    await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    await page.waitForTimeout(waitMs);
    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => undefined);

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(900);
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });

    await openPotentialCitationPanels(page);
    await page.waitForTimeout(900);
    await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => undefined);

    const snapshot = await collectPageSnapshot(page);
    const capturedAt = new Date().toISOString();
    const packet = `${CAPTURE_PREFIX}\n${JSON.stringify({
      version: "b1.auto.v1",
      source: "playwright-auto",
      pageUrl,
      pageTitle: snapshot.pageTitle,
      capturedAt,
      reportText: snapshot.reportText,
      sourceUrls: snapshot.sourceUrls,
      providerHint,
    })}`;
    const normalized = parseBrowserCapture(packet);
    if (!normalized) {
      throw new Error("自动抓取未提取到足够文本，可能页面尚未加载完成或需要登录。");
    }

    const hasPossibleLoginWall =
      looksLikeLoginOrBlocked(normalized.reportText.slice(0, 1200), normalized.pageTitle) &&
      normalized.sourceUrls.length <= 1;
    if (hasPossibleLoginWall) {
      throw new Error("自动抓取疑似遇到登录/风控页面，请先登录对应站点后再试。");
    }

    return {
      pageUrl: normalized.pageUrl || pageUrl,
      pageTitle: normalized.pageTitle || snapshot.pageTitle || "未命名页面",
      capturedAt: normalized.capturedAt || capturedAt,
      providerHint: normalized.providerHint,
      reportText: normalized.reportText,
      sourceUrls: normalized.sourceUrls,
    };
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

