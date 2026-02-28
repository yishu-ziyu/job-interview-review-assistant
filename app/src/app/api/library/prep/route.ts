import { NextResponse } from "next/server";
import { generatePrepPlan, retrieveLibraryEntries } from "@/lib/library-prep";
import { appendRuntimeDevLog } from "@/lib/dev-log";
import { listLibraryEntries } from "@/lib/library-store";
import type { PrepRequest } from "@/lib/types";

export const runtime = "nodejs";

function validateRequest(payload: PrepRequest): string | null {
  if (!payload.targetRole?.trim()) return "targetRole 不能为空。";
  if (
    typeof payload.qualityGateEnabled !== "undefined" &&
    typeof payload.qualityGateEnabled !== "boolean"
  ) {
    return "qualityGateEnabled 必须是布尔值。";
  }
  if (
    typeof payload.qualityGateThreshold === "number" &&
    (!Number.isFinite(payload.qualityGateThreshold) ||
      payload.qualityGateThreshold < 40 ||
      payload.qualityGateThreshold > 90)
  ) {
    return "qualityGateThreshold 必须在 40-90 之间。";
  }
  return null;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<PrepRequest>;
    const payload: PrepRequest = {
      targetRole: String(body.targetRole ?? "").trim(),
      company: String(body.company ?? "").trim(),
      focus: String(body.focus ?? "").trim(),
      topK: typeof body.topK === "number" ? body.topK : undefined,
      qualityGateEnabled:
        typeof body.qualityGateEnabled === "boolean"
          ? body.qualityGateEnabled
          : undefined,
      qualityGateThreshold:
        typeof body.qualityGateThreshold === "number"
          ? body.qualityGateThreshold
          : undefined,
    };
    const validateError = validateRequest(payload);
    if (validateError) {
      await appendRuntimeDevLog({
        module: "/api/library/prep",
        action: "validate-request",
        status: "blocked",
        summary: validateError,
        meta: {
          targetRole: payload.targetRole,
          company: payload.company || undefined,
        },
      });
      return NextResponse.json({ error: validateError }, { status: 400 });
    }

    const allEntries = await listLibraryEntries();
    const matchedEntries = retrieveLibraryEntries(allEntries, payload);
    const { plan, warning } = await generatePrepPlan(payload, matchedEntries);

    await appendRuntimeDevLog({
      module: "/api/library/prep",
      action: "generate-prep-plan",
      status: plan.quality.gatePassed ? "ok" : "blocked",
      summary: plan.quality.gatePassed
        ? "策略生成成功"
        : `门槛拦截：${plan.quality.gateReason ?? "质量门槛未通过"}`,
      meta: {
        targetRole: payload.targetRole,
        company: payload.company || undefined,
        matchedEntries: matchedEntries.length,
        totalEntries: allEntries.length,
        gateEnabled: plan.quality.gateEnabled,
        gateThreshold: plan.quality.gateThreshold,
        gatePassed: plan.quality.gatePassed,
        evidenceScore: plan.quality.evidenceScore,
        qualityLevel: plan.quality.qualityLevel,
        warning: warning || undefined,
      },
    });

    return NextResponse.json({
      plan,
      warning,
      totalEntries: allEntries.length,
      matchedEntries: matchedEntries.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    await appendRuntimeDevLog({
      module: "/api/library/prep",
      action: "generate-prep-plan",
      status: "error",
      summary: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
