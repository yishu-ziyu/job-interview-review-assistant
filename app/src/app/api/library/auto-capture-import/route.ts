import { NextResponse } from "next/server";
import { captureResearchPage } from "@/lib/auto-capture";
import {
  cleanCapturedReportText,
  DEFAULT_COMPANY_ALIAS_DICT,
  inferCaptureContextSuggestions,
  isLikelyConversationOrAppUrl,
} from "@/lib/browser-capture";
import { appendRuntimeDevLog } from "@/lib/dev-log";
import { addLibraryEntries } from "@/lib/library-store";
import { transformResearchToLibraryEntries } from "@/lib/research-import";
import type { ResearchProvider } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

type AutoCaptureImportRequest = {
  pageUrl: string;
  provider?: ResearchProvider | "auto";
  targetRole: string;
  company?: string;
  round?: string;
  verifySources?: boolean;
  waitMs?: number;
};

function isValidProvider(value: string): value is ResearchProvider {
  return (
    value === "gemini" ||
    value === "gpt" ||
    value === "doubao" ||
    value === "zhipu" ||
    value === "other"
  );
}

function normalizeProvider(value: unknown): ResearchProvider | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "auto") return undefined;
  if (isValidProvider(normalized)) return normalized;
  return undefined;
}

function normalizeWaitMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(800, Math.min(15000, Math.round(value)));
}

function validateInput(payload: AutoCaptureImportRequest): string | null {
  if (!payload.pageUrl?.trim()) return "pageUrl 不能为空。";
  if (!payload.targetRole?.trim()) return "targetRole 不能为空。";
  return null;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<AutoCaptureImportRequest>;
    const payload: AutoCaptureImportRequest = {
      pageUrl: String(body.pageUrl ?? "").trim(),
      provider: typeof body.provider === "string" ? body.provider : "auto",
      targetRole: String(body.targetRole ?? "").trim(),
      company: String(body.company ?? "").trim(),
      round: String(body.round ?? "").trim(),
      verifySources: body.verifySources !== false,
      waitMs: normalizeWaitMs(body.waitMs),
    };

    const validateError = validateInput(payload);
    if (validateError) {
      await appendRuntimeDevLog({
        module: "/api/library/auto-capture-import",
        action: "validate-request",
        status: "blocked",
        summary: validateError,
        meta: {
          pageUrl: payload.pageUrl,
          targetRole: payload.targetRole,
          provider: payload.provider,
        },
      });
      return NextResponse.json({ error: validateError }, { status: 400 });
    }

    const captured = await captureResearchPage({
      pageUrl: payload.pageUrl,
      providerHint: normalizeProvider(payload.provider),
      waitMs: payload.waitMs,
    });

    const cleanResult = cleanCapturedReportText(captured.reportText);
    const effectiveReportText =
      cleanResult.cleanedLength >= 80 ? cleanResult.cleanedText : captured.reportText;
    const provider = normalizeProvider(payload.provider) ?? captured.providerHint;

    const transformed = await transformResearchToLibraryEntries({
      provider,
      targetRole: payload.targetRole,
      company: payload.company,
      round: payload.round,
      sourceUrls: captured.sourceUrls,
      reportText: effectiveReportText,
      verifySources: payload.verifySources !== false,
    });

    if (transformed.entries.length === 0) {
      await appendRuntimeDevLog({
        module: "/api/library/auto-capture-import",
        action: "capture-and-transform",
        status: "blocked",
        summary: "自动抓取完成，但未解析出可入库条目",
        meta: {
          pageUrl: payload.pageUrl,
          targetRole: payload.targetRole,
          provider,
          sourceUrlCount: captured.sourceUrls.length,
        },
      });
      return NextResponse.json(
        { error: "自动抓取完成，但未解析出可入库条目。请换页面或改用手动导入。" },
        { status: 400 },
      );
    }

    const created = await addLibraryEntries(transformed.entries);
    const citationReady = captured.sourceUrls.some(
      (item) => !isLikelyConversationOrAppUrl(item, captured.pageUrl),
    );
    const suggestions = inferCaptureContextSuggestions({
      pageTitle: captured.pageTitle,
      pageUrl: captured.pageUrl,
      reportText: effectiveReportText,
      sourceUrls: captured.sourceUrls,
      companyAliasDict: DEFAULT_COMPANY_ALIAS_DICT,
    });

    await appendRuntimeDevLog({
      module: "/api/library/auto-capture-import",
      action: "capture-and-import",
      status: "ok",
      summary: `自动导入成功：${created.length} 条`,
      meta: {
        pageUrl: captured.pageUrl,
        targetRole: payload.targetRole,
        company: payload.company || undefined,
        provider,
        sourceUrlCount: captured.sourceUrls.length,
        createdCount: created.length,
        citationReady,
        cleanedCharCount: cleanResult.cleanedLength,
        supported: transformed.stats.supported,
        weak: transformed.stats.weak,
        conflict: transformed.stats.conflict,
        unverified: transformed.stats.unverified,
        unreachable: transformed.stats.unreachable,
      },
    });

    return NextResponse.json({
      createdCount: created.length,
      entries: created,
      sourceChecks: transformed.sourceChecks,
      stats: transformed.stats,
      capture: {
        pageTitle: captured.pageTitle,
        pageUrl: captured.pageUrl,
        capturedAt: captured.capturedAt,
        providerHint: provider,
        sourceUrls: captured.sourceUrls,
        rawText: captured.reportText,
        cleanedText: cleanResult.cleanedText,
        rawCharCount: cleanResult.originalLength,
        cleanedCharCount: cleanResult.cleanedLength,
        removedLineCount: cleanResult.removedLineCount,
        citationReady,
        suggestions,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    await appendRuntimeDevLog({
      module: "/api/library/auto-capture-import",
      action: "capture-and-import",
      status: "error",
      summary: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
