import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  addLibraryEntries,
  listLibraryEntries,
  replaceLibraryEntries,
} from "@/lib/library-store";
import { enrichPmDemoEntry, summarizePmDemoQuality } from "@/lib/pm-demo-quality";
import type { LibraryEntryInput } from "@/lib/types";

export const runtime = "nodejs";

const DEMO_PATH = path.join(process.cwd(), "data", "pm-demo-library.v1.json");
const DEMO_TAG = "PM内置库";

type DemoSeedPayload = {
  version: string;
  generatedAt?: string;
  targetRole?: string;
  companies: string[];
  entries: LibraryEntryInput[];
};

function countByText(items: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) {
    const key = normalizeText(item);
    if (!key) continue;
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item.length > 0),
    ),
  ).slice(0, 20);
}

function normalizeEntry(raw: unknown): LibraryEntryInput | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const targetRole = normalizeText(row.targetRole);
  const question = normalizeText(row.question);
  const pitfall = normalizeText(row.pitfall);
  const betterAnswer = normalizeText(row.betterAnswer);
  if (!targetRole || !question || !pitfall || !betterAnswer) return null;

  return {
    source: "other",
    targetRole,
    company: normalizeText(row.company),
    round: normalizeText(row.round),
    question,
    pitfall,
    betterAnswer,
    tags: normalizeTags(row.tags),
    sourceUrl: normalizeText(row.sourceUrl) || undefined,
    evidenceNote: normalizeText(row.evidenceNote) || undefined,
    verificationStatus:
      row.verificationStatus === "supported" ||
      row.verificationStatus === "weak" ||
      row.verificationStatus === "conflict" ||
      row.verificationStatus === "unverified" ||
      row.verificationStatus === "unreachable"
        ? row.verificationStatus
        : undefined,
    confidence:
      typeof row.confidence === "number" && Number.isFinite(row.confidence)
        ? row.confidence
        : undefined,
  };
}

function signatureFromEntry(input: {
  targetRole?: string;
  company?: string;
  round?: string;
  question: string;
}): string {
  return [
    normalizeText(input.targetRole).toLowerCase(),
    normalizeText(input.company).toLowerCase(),
    normalizeText(input.round).toLowerCase(),
    normalizeText(input.question).toLowerCase(),
  ].join("::");
}

async function readDemoSeed(): Promise<DemoSeedPayload> {
  const raw = await fs.readFile(DEMO_PATH, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const entriesRaw = Array.isArray(parsed.entries) ? parsed.entries : [];
  const entries = entriesRaw
    .map((item) => normalizeEntry(item))
    .filter((item): item is LibraryEntryInput => item !== null)
    .map((item) => enrichPmDemoEntry(item));

  return {
    version: normalizeText(parsed.version) || "pm-demo-v1",
    generatedAt: normalizeText(parsed.generatedAt) || undefined,
    targetRole: normalizeText(parsed.targetRole) || "产品经理",
    companies: Array.isArray(parsed.companies)
      ? parsed.companies
          .map((item) => normalizeText(item))
          .filter((item) => item.length > 0)
      : [],
    entries,
  };
}

export async function GET() {
  try {
    const seed = await readDemoSeed();
    const companyDistribution = countByText(seed.entries.map((item) => item.company ?? ""));
    const roundDistribution = countByText(seed.entries.map((item) => item.round ?? ""));
    const quality = summarizePmDemoQuality(seed.entries);
    return NextResponse.json({
      version: seed.version,
      generatedAt: seed.generatedAt,
      targetRole: seed.targetRole,
      companyCount: seed.companies.length,
      entryCount: seed.entries.length,
      companies: seed.companies,
      companyDistribution,
      roundDistribution,
      quality,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取内置库失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const resetDemo = body.resetDemo === true;

    const seed = await readDemoSeed();
    const current = await listLibraryEntries();
    let baseEntries = current;

    if (resetDemo) {
      baseEntries = current.filter((entry) => !entry.tags.includes(DEMO_TAG));
      await replaceLibraryEntries(baseEntries);
    }

    const existingSignatures = new Set(
      baseEntries.map((entry) => signatureFromEntry(entry)),
    );

    const toCreate: LibraryEntryInput[] = [];
    for (const entry of seed.entries) {
      const tags = Array.from(new Set([...(entry.tags ?? []), DEMO_TAG]));
      const signature = signatureFromEntry(entry);
      if (existingSignatures.has(signature)) continue;
      existingSignatures.add(signature);
      toCreate.push({ ...entry, tags });
    }

    const created = await addLibraryEntries(toCreate);
    const totalAfter = await listLibraryEntries();
    const companyDistribution = countByText(seed.entries.map((item) => item.company ?? ""));
    const roundDistribution = countByText(seed.entries.map((item) => item.round ?? ""));
    const quality = summarizePmDemoQuality(seed.entries);
    return NextResponse.json({
      version: seed.version,
      targetRole: seed.targetRole,
      companyCount: seed.companies.length,
      plannedCount: seed.entries.length,
      createdCount: created.length,
      skippedCount: seed.entries.length - created.length,
      totalEntries: totalAfter.length,
      demoEntriesInLibrary: totalAfter.filter((entry) => entry.tags.includes(DEMO_TAG)).length,
      sampleQuestions: created.slice(0, 3).map((entry) => entry.question),
      companyDistribution,
      roundDistribution,
      quality,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "导入内置库失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
