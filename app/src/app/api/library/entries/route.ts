import { NextResponse } from "next/server";
import { addLibraryEntry, listLibraryEntries } from "@/lib/library-store";
import type { LibraryEntryInput, LibrarySource } from "@/lib/types";

export const runtime = "nodejs";

function isValidSource(value: string): value is LibrarySource {
  return value === "self" || value === "community" || value === "other";
}

function validateInput(input: LibraryEntryInput): string | null {
  if (!isValidSource(input.source)) return "source 不合法。";
  if (!input.targetRole?.trim()) return "targetRole 不能为空。";
  if (!input.question?.trim()) return "question 不能为空。";
  if (!input.pitfall?.trim()) return "pitfall 不能为空。";
  if (!input.betterAnswer?.trim()) return "betterAnswer 不能为空。";
  return null;
}

function splitTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => (typeof item === "string" ? item : ""))
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  if (typeof raw === "string") {
    return raw
      .split(/[,，、|/]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  return [];
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limitRaw = Number(url.searchParams.get("limit") ?? "30");
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 200)
      : 30;
    const role = (url.searchParams.get("targetRole") ?? "").trim().toLowerCase();
    const company = (url.searchParams.get("company") ?? "").trim().toLowerCase();
    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();

    const all = await listLibraryEntries();
    const filtered = all.filter((entry) => {
      if (role && !entry.targetRole.toLowerCase().includes(role)) return false;
      if (company && !(entry.company ?? "").toLowerCase().includes(company)) return false;
      if (query) {
        const content = [
          entry.targetRole,
          entry.company ?? "",
          entry.round ?? "",
          entry.question,
          entry.pitfall,
          entry.betterAnswer,
          entry.tags.join(" "),
        ]
          .join(" ")
          .toLowerCase();
        if (!content.includes(query)) return false;
      }
      return true;
    });

    return NextResponse.json({
      entries: filtered.slice(0, limit),
      total: filtered.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const source = String(body.source ?? "");
    if (!isValidSource(source)) {
      return NextResponse.json({ error: "source 不合法。" }, { status: 400 });
    }

    const input: LibraryEntryInput = {
      source,
      targetRole: String(body.targetRole ?? ""),
      company: String(body.company ?? ""),
      round: String(body.round ?? ""),
      question: String(body.question ?? ""),
      pitfall: String(body.pitfall ?? ""),
      betterAnswer: String(body.betterAnswer ?? ""),
      tags: splitTags(body.tags),
    };

    const validateError = validateInput(input);
    if (validateError) {
      return NextResponse.json({ error: validateError }, { status: 400 });
    }

    const entry = await addLibraryEntry(input);
    return NextResponse.json({ entry });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
