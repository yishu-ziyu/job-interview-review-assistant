import { NextResponse } from "next/server";
import { appendRuntimeDevLog } from "@/lib/dev-log";
import { runDeepResearchProfile } from "@/lib/deep-research";
import type { DeepResearchRequest } from "@/lib/types";

export const runtime = "nodejs";

const VALID_PROVIDERS = new Set(["zhipu", "minimax", "doubao"]);

function validate(payload: DeepResearchRequest): string | null {
  if (!payload.targetRole?.trim()) return "targetRole 不能为空。";
  if (payload.targetRole.trim().length < 2) return "targetRole 太短。";
  if (payload.targetRole.trim().length > 80) return "targetRole 过长。";
  const max = payload.maxSourcesPerChannel;
  if (typeof max === "number" && (!Number.isFinite(max) || max < 1 || max > 30)) {
    return "maxSourcesPerChannel 必须在 1-30 之间。";
  }
  const reflection = payload.enableReflection;
  if (typeof reflection !== "undefined" && typeof reflection !== "boolean") {
    return "enableReflection 必须是布尔值。";
  }
  const reflectionQueriesPerChannel = payload.reflectionQueriesPerChannel;
  if (
    typeof reflectionQueriesPerChannel === "number" &&
    (!Number.isFinite(reflectionQueriesPerChannel) ||
      reflectionQueriesPerChannel < 1 ||
      reflectionQueriesPerChannel > 3)
  ) {
    return "reflectionQueriesPerChannel 必须在 1-3 之间。";
  }
  if (
    typeof payload.enableCrossValidation !== "undefined" &&
    typeof payload.enableCrossValidation !== "boolean"
  ) {
    return "enableCrossValidation 必须是布尔值。";
  }
  if (
    payload.crossValidationProvider &&
    !VALID_PROVIDERS.has(payload.crossValidationProvider)
  ) {
    return "crossValidationProvider 仅支持 zhipu/minimax/doubao。";
  }
  if (
    payload.crossValidationModel &&
    payload.crossValidationModel.trim().length > 80
  ) {
    return "crossValidationModel 过长。";
  }
  return null;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const payload: DeepResearchRequest = {
      targetRole: String(body.targetRole ?? "").trim(),
      company: String(body.company ?? "").trim(),
      focus: String(body.focus ?? "").trim(),
      maxSourcesPerChannel:
        typeof body.maxSourcesPerChannel === "number"
          ? body.maxSourcesPerChannel
          : undefined,
      enableReflection:
        typeof body.enableReflection === "boolean"
          ? body.enableReflection
          : undefined,
      reflectionQueriesPerChannel:
        typeof body.reflectionQueriesPerChannel === "number"
          ? body.reflectionQueriesPerChannel
          : undefined,
      enableCrossValidation:
        typeof body.enableCrossValidation === "boolean"
          ? body.enableCrossValidation
          : undefined,
      crossValidationProvider:
        typeof body.crossValidationProvider === "string"
          ? (body.crossValidationProvider.trim()
              ? (body.crossValidationProvider.trim().toLowerCase() as
                  | "zhipu"
                  | "minimax"
                  | "doubao")
              : undefined)
          : undefined,
      crossValidationModel:
        typeof body.crossValidationModel === "string"
          ? body.crossValidationModel.trim()
          : undefined,
    };

    const error = validate(payload);
    if (error) {
      await appendRuntimeDevLog({
        module: "/api/deep-research/profile",
        action: "validate-request",
        status: "blocked",
        summary: error,
        meta: {
          targetRole: payload.targetRole,
          company: payload.company || undefined,
        },
      });
      return NextResponse.json({ error }, { status: 400 });
    }

    const result = await runDeepResearchProfile(payload);
    await appendRuntimeDevLog({
      module: "/api/deep-research/profile",
      action: "run-deep-research",
      status: result.readiness.gatePassed ? "ok" : "blocked",
      summary: result.readiness.gatePassed
        ? "岗位画像生成成功，研究质量门禁通过"
        : `岗位画像生成成功，但门禁未通过：${result.readiness.blockers[0] ?? "证据不足"}`,
      meta: {
        targetRole: payload.targetRole,
        company: payload.company || undefined,
        sourceCount: result.sources.length,
        avgScore: result.qualityStats.avgScore,
        primarySearchSuccess: result.searchTelemetry.primarySuccess,
        fallbackSearchSuccess: result.searchTelemetry.fallbackSuccess,
        acceptedEvidenceClusters: result.evidenceClusters.accepted,
        readinessScore: result.readiness.score,
        readinessLevel: result.readiness.level,
        gatePassed: result.readiness.gatePassed,
        blockers: result.readiness.blockers,
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    await appendRuntimeDevLog({
      module: "/api/deep-research/profile",
      action: "run-deep-research",
      status: "error",
      summary: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
