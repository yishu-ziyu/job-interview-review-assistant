import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  LibraryEntry,
  LibraryEntryInput,
  VerificationStatus,
} from "@/lib/types";

type LibraryStore = {
  entries: LibraryEntry[];
};

const STORE_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(STORE_DIR, "interview-library.json");

async function ensureStore(): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true });
  try {
    await fs.access(STORE_PATH);
  } catch {
    const initial: LibraryStore = { entries: [] };
    await fs.writeFile(STORE_PATH, JSON.stringify(initial, null, 2), "utf-8");
  }
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim();
}

function normalizeTags(value: string[] | undefined): string[] {
  if (!value) return [];
  return Array.from(
    new Set(
      value
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
        .slice(0, 20),
    ),
  );
}

function normalizeUrl(value: string | undefined): string | undefined {
  const normalized = (value ?? "").trim();
  if (!normalized) return undefined;
  try {
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizeVerificationStatus(
  value: VerificationStatus | undefined,
): VerificationStatus | undefined {
  if (!value) return undefined;
  if (
    value === "unverified" ||
    value === "supported" ||
    value === "weak" ||
    value === "conflict" ||
    value === "unreachable"
  ) {
    return value;
  }
  return undefined;
}

function normalizeConfidence(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Math.round(value * 100) / 100;
}

function normalizeEntryInput(input: LibraryEntryInput): LibraryEntryInput {
  return {
    source: input.source,
    targetRole: normalizeText(input.targetRole),
    company: normalizeText(input.company),
    round: normalizeText(input.round),
    question: normalizeText(input.question),
    pitfall: normalizeText(input.pitfall),
    betterAnswer: normalizeText(input.betterAnswer),
    tags: normalizeTags(input.tags),
    sourceUrl: normalizeUrl(input.sourceUrl),
    evidenceNote: normalizeText(input.evidenceNote),
    verificationStatus: normalizeVerificationStatus(input.verificationStatus),
    confidence: normalizeConfidence(input.confidence),
  };
}

async function readStore(): Promise<LibraryStore> {
  await ensureStore();
  const raw = await fs.readFile(STORE_PATH, "utf-8");
  try {
    const parsed = JSON.parse(raw) as LibraryStore;
    if (!parsed || !Array.isArray(parsed.entries)) {
      return { entries: [] };
    }
    return parsed;
  } catch {
    return { entries: [] };
  }
}

async function writeStore(store: LibraryStore): Promise<void> {
  await ensureStore();
  const tempPath = `${STORE_PATH}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf-8");
  await fs.rename(tempPath, STORE_PATH);
}

export async function listLibraryEntries(): Promise<LibraryEntry[]> {
  const store = await readStore();
  return store.entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function addLibraryEntry(
  input: LibraryEntryInput,
): Promise<LibraryEntry> {
  const normalized = normalizeEntryInput(input);
  const entry: LibraryEntry = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: normalized.source,
    targetRole: normalized.targetRole,
    company: normalized.company || undefined,
    round: normalized.round || undefined,
    question: normalized.question,
    pitfall: normalized.pitfall,
    betterAnswer: normalized.betterAnswer,
    tags: normalized.tags ?? [],
    sourceUrl: normalized.sourceUrl || undefined,
    evidenceNote: normalized.evidenceNote || undefined,
    verificationStatus: normalized.verificationStatus,
    confidence: normalized.confidence,
  };

  const store = await readStore();
  store.entries.unshift(entry);
  store.entries = store.entries.slice(0, 5000);
  await writeStore(store);
  return entry;
}

export async function addLibraryEntries(
  entries: LibraryEntryInput[],
): Promise<LibraryEntry[]> {
  if (entries.length === 0) return [];
  const store = await readStore();

  const created: LibraryEntry[] = entries.map((item) => {
    const normalized = normalizeEntryInput(item);
    return {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      source: normalized.source,
      targetRole: normalized.targetRole,
      company: normalized.company || undefined,
      round: normalized.round || undefined,
      question: normalized.question,
      pitfall: normalized.pitfall,
      betterAnswer: normalized.betterAnswer,
      tags: normalized.tags ?? [],
      sourceUrl: normalized.sourceUrl || undefined,
      evidenceNote: normalized.evidenceNote || undefined,
      verificationStatus: normalized.verificationStatus,
      confidence: normalized.confidence,
    };
  });

  store.entries = [...created, ...store.entries].slice(0, 5000);
  await writeStore(store);
  return created;
}

export async function replaceLibraryEntries(entries: LibraryEntry[]): Promise<void> {
  const normalized = entries
    .map((entry) => ({
      ...entry,
      targetRole: normalizeText(entry.targetRole),
      company: normalizeText(entry.company) || undefined,
      round: normalizeText(entry.round) || undefined,
      question: normalizeText(entry.question),
      pitfall: normalizeText(entry.pitfall),
      betterAnswer: normalizeText(entry.betterAnswer),
      tags: normalizeTags(entry.tags),
      sourceUrl: normalizeUrl(entry.sourceUrl),
      evidenceNote: normalizeText(entry.evidenceNote) || undefined,
      verificationStatus: normalizeVerificationStatus(entry.verificationStatus),
      confidence: normalizeConfidence(entry.confidence),
    }))
    .filter(
      (entry) =>
        entry.targetRole.length > 0 &&
        entry.question.length > 0 &&
        entry.pitfall.length > 0 &&
        entry.betterAnswer.length > 0,
    )
    .slice(0, 5000);

  await writeStore({ entries: normalized });
}
