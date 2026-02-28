import { NextResponse } from "next/server";
import { appendRuntimeDevLog } from "@/lib/dev-log";
import { addLibraryEntries } from "@/lib/library-store";
import { transformResearchToLibraryEntries } from "@/lib/research-import";
import type { ResearchImportRequest, ResearchProvider } from "@/lib/types";

export const runtime = "nodejs";

function isValidProvider(value: string): value is ResearchProvider {
  return (
    value === "gemini" ||
    value === "gpt" ||
    value === "doubao" ||
    value === "zhipu" ||
    value === "other"
  );
}

function normalizeSourceUrls(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(/\n|,|，|;|；/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

function validate(payload: ResearchImportRequest): string | null {
  if (!payload.targetRole?.trim()) return "targetRole 不能为空。";
  if (!payload.reportText?.trim()) return "reportText 不能为空。";
  if (payload.reportText.trim().length < 80) {
    return "reportText 太短，建议至少 80 字。";
  }
  return null;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const providerRaw = String(body.provider ?? "other").trim().toLowerCase();
    if (!isValidProvider(providerRaw)) {
      return NextResponse.json({ error: "provider 不合法。" }, { status: 400 });
    }

    const payload: ResearchImportRequest = {
      provider: providerRaw,
      targetRole: String(body.targetRole ?? "").trim(),
      company: String(body.company ?? "").trim(),
      round: String(body.round ?? "").trim(),
      reportText: String(body.reportText ?? "").trim(),
      sourceUrls: normalizeSourceUrls(body.sourceUrls),
      verifySources: Boolean(body.verifySources ?? true),
    };

    const error = validate(payload);
    if (error) {
      await appendRuntimeDevLog({
        module: "/api/library/import-research",
        action: "validate-request",
        status: "blocked",
        summary: error,
        meta: {
          provider: payload.provider,
          targetRole: payload.targetRole,
          company: payload.company || undefined,
        },
      });
      return NextResponse.json({ error }, { status: 400 });
    }

    const transformed = await transformResearchToLibraryEntries(payload);
    if (transformed.entries.length === 0) {
      await appendRuntimeDevLog({
        module: "/api/library/import-research",
        action: "transform-report",
        status: "blocked",
        summary: "研究报告未解析出可入库条目",
        meta: {
          provider: payload.provider,
          targetRole: payload.targetRole,
          sourceUrlCount: payload.sourceUrls.length,
        },
      });
      return NextResponse.json(
        { error: "未能从研究报告解析出可入库条目，请补充更完整文本后重试。" },
        { status: 400 },
      );
    }

    const created = await addLibraryEntries(transformed.entries);
    await appendRuntimeDevLog({
      module: "/api/library/import-research",
      action: "import-research",
      status: "ok",
      summary: `导入成功：${created.length} 条`,
      meta: {
        provider: payload.provider,
        targetRole: payload.targetRole,
        company: payload.company || undefined,
        sourceUrlCount: payload.sourceUrls.length,
        createdCount: created.length,
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
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    await appendRuntimeDevLog({
      module: "/api/library/import-research",
      action: "import-research",
      status: "error",
      summary: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
