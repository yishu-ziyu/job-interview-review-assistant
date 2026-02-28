import { NextResponse } from "next/server";
import { dedupLibraryEntries } from "@/lib/library-dedup";
import { listLibraryEntries, replaceLibraryEntries } from "@/lib/library-store";

export const runtime = "nodejs";

type DedupRequest = {
  dryRun?: boolean;
  similarityThreshold?: number;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as DedupRequest;
    const dryRun = Boolean(body.dryRun ?? false);
    const similarityThreshold =
      typeof body.similarityThreshold === "number" ? body.similarityThreshold : undefined;

    const allEntries = await listLibraryEntries();
    const result = dedupLibraryEntries(allEntries, {
      similarityThreshold,
      sampleLimit: 10,
    });
    result.summary.dryRun = dryRun;

    if (!dryRun) {
      await replaceLibraryEntries(result.entries);
    }

    return NextResponse.json(result.summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
