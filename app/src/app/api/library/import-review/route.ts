import { NextResponse } from "next/server";
import { addLibraryEntries } from "@/lib/library-store";
import type { InterviewReview, LibraryEntryInput } from "@/lib/types";

export const runtime = "nodejs";

type ImportReviewPayload = {
  targetRole: string;
  company?: string;
  round?: string;
  review: InterviewReview;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<ImportReviewPayload>;
    const targetRole = body.targetRole?.trim() ?? "";
    const company = body.company?.trim() ?? "";
    const round = body.round?.trim() ?? "";
    const review = body.review;

    if (!targetRole) {
      return NextResponse.json({ error: "targetRole 不能为空。" }, { status: 400 });
    }
    if (!review || !Array.isArray(review.questions) || review.questions.length === 0) {
      return NextResponse.json({ error: "review.questions 不能为空。" }, { status: 400 });
    }

    const entries: LibraryEntryInput[] = review.questions
      .map((item) => ({
        source: "self" as const,
        targetRole,
        company,
        round,
        question: item.question?.trim() ?? "",
        pitfall: item.issue?.trim() ?? "",
        betterAnswer: item.betterAnswer?.trim() ?? "",
        tags: ["复盘导入", item.performance].filter((tag) => tag.length > 0),
      }))
      .filter(
        (item) =>
          item.question.length > 0 &&
          item.pitfall.length > 0 &&
          item.betterAnswer.length > 0,
      );

    if (entries.length === 0) {
      return NextResponse.json(
        { error: "可导入条目为空，请检查 review 内容。" },
        { status: 400 },
      );
    }

    const created = await addLibraryEntries(entries);
    return NextResponse.json({ createdCount: created.length, entries: created });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
