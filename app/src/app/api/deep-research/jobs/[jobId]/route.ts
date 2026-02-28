import { NextResponse } from "next/server";
import { appendRuntimeDevLog } from "@/lib/dev-log";
import {
  cancelDeepResearchJob,
  getDeepResearchJob,
} from "@/lib/deep-research-queue";

export const runtime = "nodejs";

type Params = {
  params: Promise<{ jobId: string }>;
};

export async function GET(_: Request, context: Params) {
  try {
    const { jobId } = await context.params;
    const job = await getDeepResearchJob(jobId, true);
    if (!job) {
      return NextResponse.json({ error: "任务不存在。" }, { status: 404 });
    }
    return NextResponse.json({ job });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_: Request, context: Params) {
  try {
    const { jobId } = await context.params;
    const job = await cancelDeepResearchJob(jobId);
    if (!job) {
      return NextResponse.json({ error: "任务不存在。" }, { status: 404 });
    }
    await appendRuntimeDevLog({
      module: "/api/deep-research/jobs/[jobId]",
      action: "cancel-job",
      status: "ok",
      summary: "Deep Research 异步任务已取消",
      meta: {
        jobId: job.id,
        status: job.status,
      },
    });
    return NextResponse.json({ job });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    await appendRuntimeDevLog({
      module: "/api/deep-research/jobs/[jobId]",
      action: "cancel-job",
      status: "error",
      summary: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
