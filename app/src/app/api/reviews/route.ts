import { NextResponse } from "next/server";
import { generateReview } from "@/lib/review";
import { logToSupabase } from "@/lib/supabase-log";
import type { ReviewRequest } from "@/lib/types";

export const runtime = "nodejs";

function validateInput(input: ReviewRequest): string | null {
  if (!input.targetRole?.trim()) return "targetRole 不能为空。";
  if (!input.rawNotes?.trim()) return "rawNotes 不能为空。";
  if (input.rawNotes.trim().length < 40) return "rawNotes 至少 40 字。";
  return null;
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as ReviewRequest;
    const validateError = validateInput(payload);
    if (validateError) {
      return NextResponse.json({ error: validateError }, { status: 400 });
    }

    const result = await generateReview(payload);

    try {
      await logToSupabase({
        input: payload,
        review: result.review,
        provider: result.provider,
        model: result.model,
        modelRawOutput: result.modelRawOutput,
      });
    } catch (error) {
      console.error("Supabase logging failed:", error);
    }

    return NextResponse.json({
      review: result.review,
      meta: {
        provider: result.provider,
        model: result.model,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json(
      { error: `生成复盘失败：${message}` },
      { status: 500 },
    );
  }
}
