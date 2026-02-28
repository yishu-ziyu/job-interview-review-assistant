import { NextResponse } from "next/server";
import { buildProjectHealthSnapshot } from "@/lib/project-health";

export const runtime = "nodejs";

export async function GET() {
  try {
    const snapshot = await buildProjectHealthSnapshot();
    return NextResponse.json(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : "项目健康快照生成失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
