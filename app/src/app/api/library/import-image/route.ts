import { NextResponse } from "next/server";
import { addLibraryEntries } from "@/lib/library-store";
import { transformResearchToLibraryEntries } from "@/lib/research-import";
import type { ResearchProvider } from "@/lib/types";

export const runtime = "nodejs";

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

function isValidProvider(value: string): value is ResearchProvider {
  return (
    value === "gemini" ||
    value === "gpt" ||
    value === "doubao" ||
    value === "zhipu" ||
    value === "other"
  );
}

function normalizeSourceUrls(raw: string): string[] {
  return raw
    .split(/\n|,|，|;|；/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 8);
}

async function recognizeImageText(file: File): Promise<string> {
  const imageBuffer = Buffer.from(await file.arrayBuffer());
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("chi_sim+eng");
  try {
    const result = await worker.recognize(imageBuffer);
    return result.data.text?.replace(/\s+\n/g, "\n").trim() ?? "";
  } finally {
    await worker.terminate();
  }
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("image");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "缺少 image 文件。" }, { status: 400 });
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: "仅支持 PNG/JPG/JPEG/WEBP 图片。" },
        { status: 400 },
      );
    }
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: "图片过大，请控制在 5MB 以内。" },
        { status: 400 },
      );
    }

    const providerRaw = String(formData.get("provider") ?? "other")
      .trim()
      .toLowerCase();
    const provider = isValidProvider(providerRaw) ? providerRaw : "other";
    const targetRole = String(formData.get("targetRole") ?? "").trim();
    const company = String(formData.get("company") ?? "").trim();
    const round = String(formData.get("round") ?? "").trim();
    const sourceUrlsRaw = String(formData.get("sourceUrls") ?? "");
    const verifySources = String(formData.get("verifySources") ?? "true")
      .trim()
      .toLowerCase();

    if (!targetRole) {
      return NextResponse.json({ error: "targetRole 不能为空。" }, { status: 400 });
    }

    const ocrText = await recognizeImageText(file);
    if (!ocrText || ocrText.length < 40) {
      return NextResponse.json(
        { error: "OCR 提取文本过少，请上传更清晰的截图。" },
        { status: 400 },
      );
    }

    const sourceUrls = normalizeSourceUrls(sourceUrlsRaw);
    const transformed = await transformResearchToLibraryEntries({
      provider,
      targetRole,
      company,
      round,
      reportText: ocrText,
      sourceUrls,
      verifySources: verifySources !== "false",
    });
    if (transformed.entries.length === 0) {
      return NextResponse.json(
        { error: "OCR 文本未能解析为可入库条目，请换图重试。" },
        { status: 400 },
      );
    }

    const created = await addLibraryEntries(transformed.entries);
    return NextResponse.json({
      createdCount: created.length,
      entries: created,
      textLength: ocrText.length,
      ocrPreview: ocrText.slice(0, 800),
      sourceChecks: transformed.sourceChecks,
      stats: transformed.stats,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
