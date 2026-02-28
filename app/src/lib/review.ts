import { callLlm } from "@/lib/llm";
import type {
  InterviewReview,
  QuestionReview,
  ReviewRequest,
  ReviewResult,
} from "@/lib/types";

const SYSTEM_PROMPT = `
你是“求职面试复盘助手”。你只输出 JSON，不输出额外文本。

目标：
1) 生成面试摘要（简洁但具体，不能空话）
2) 生成问题清单（每题包含表现评级、问题、改进建议）
3) 生成下次改进动作（可直接执行）

要求：
- 必须基于用户输入证据，不要编造细节。
- 对不确定内容，用“待补充”标注。
- 保持中文输出。
- 严格返回以下 JSON 结构：
{
  "summary": "string",
  "questions": [
    {
      "question": "string",
      "performance": "好|一般|差",
      "issue": "string",
      "betterAnswer": "string"
    }
  ],
  "nextActions": ["string"]
}
- questions 最多 8 条，nextActions 最多 5 条。
`.trim();

function buildUserPrompt(input: ReviewRequest): string {
  return [
    `目标岗位：${input.targetRole}`,
    `公司：${input.company?.trim() || "未提供"}`,
    `面试轮次：${input.round?.trim() || "未提供"}`,
    "",
    "面试回忆原文：",
    input.rawNotes.trim(),
  ].join("\n");
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("模型返回为空。");

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1].trim());
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }

  return JSON.parse(trimmed);
}

function normalizePerformance(value: unknown): "好" | "一般" | "差" {
  if (value === "好" || value === "一般" || value === "差") return value;
  return "一般";
}

function normalizeQuestions(raw: unknown): QuestionReview[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const question = typeof row.question === "string" ? row.question.trim() : "";
      const issue = typeof row.issue === "string" ? row.issue.trim() : "";
      const betterAnswer =
        typeof row.betterAnswer === "string" ? row.betterAnswer.trim() : "";
      if (!question || !issue || !betterAnswer) return null;
      return {
        question,
        performance: normalizePerformance(row.performance),
        issue,
        betterAnswer,
      };
    })
    .filter((item): item is QuestionReview => item !== null)
    .slice(0, 8);
}

function normalizeActions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0)
    .slice(0, 5);
}

function validateAndNormalize(parsed: unknown): InterviewReview {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("模型返回格式不合法。");
  }
  const data = parsed as Record<string, unknown>;

  const summary = typeof data.summary === "string" ? data.summary.trim() : "";
  const questions = normalizeQuestions(data.questions);
  const nextActions = normalizeActions(data.nextActions);

  if (!summary) {
    throw new Error("模型未返回 summary。");
  }
  if (questions.length === 0) {
    throw new Error("模型未返回有效 questions。");
  }
  if (nextActions.length === 0) {
    throw new Error("模型未返回有效 nextActions。");
  }

  return { summary, questions, nextActions };
}

export async function generateReview(input: ReviewRequest): Promise<ReviewResult> {
  const response = await callLlm({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(input) },
    ],
    temperature: 0.35,
  });

  const parsed = extractJson(response.content);
  const review = validateAndNormalize(parsed);

  return {
    review,
    modelRawOutput: response.content,
    provider: response.provider,
    model: response.model,
  };
}
