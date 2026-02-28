import type { InterviewReview, ReviewRequest } from "@/lib/types";

type LogPayload = {
  input: ReviewRequest;
  review: InterviewReview;
  provider: string;
  model: string;
  modelRawOutput: string;
};

export async function logToSupabase(payload: LogPayload): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return;

  const endpoint = `${url.replace(/\/$/, "")}/rest/v1/interview_reviews`;
  const body = {
    target_role: payload.input.targetRole,
    company: payload.input.company || null,
    interview_round: payload.input.round || null,
    raw_notes: payload.input.rawNotes,
    review_json: payload.review,
    llm_provider: payload.provider,
    llm_model: payload.model,
    llm_raw_output: payload.modelRawOutput,
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase 写入失败: ${response.status} ${text}`);
  }
}
