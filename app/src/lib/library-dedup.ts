import { randomUUID } from "node:crypto";
import type {
  DedupGroupSample,
  DedupSummary,
  LibraryEntry,
  LibrarySource,
  VerificationStatus,
} from "@/lib/types";

type DedupOptions = {
  similarityThreshold?: number;
  sampleLimit?: number;
};

type DedupResult = {
  entries: LibraryEntry[];
  summary: DedupSummary;
};

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeQuestion(value: string): string {
  return normalizeText(value).replace(
    /[\s.,!?;:，。！？；：、"'“”‘’`()\[\]{}<>《》【】|/\\\-+_*#@%&$^~`]+/g,
    "",
  );
}

function buildBigrams(text: string): Set<string> {
  const chars = text.split("");
  if (chars.length <= 1) return new Set(chars);
  const grams = new Set<string>();
  for (let i = 0; i < chars.length - 1; i += 1) {
    grams.add(`${chars[i]}${chars[i + 1]}`);
  }
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function questionSimilarity(a: string, b: string): number {
  const aa = normalizeQuestion(a);
  const bb = normalizeQuestion(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  return jaccard(buildBigrams(aa), buildBigrams(bb));
}

function companyKey(value: string | undefined): string {
  const normalized = normalizeText(value);
  return normalized || "__empty__";
}

function roleKey(value: string | undefined): string {
  return normalizeText(value) || "__empty__";
}

function statusRank(status: VerificationStatus | undefined): number {
  if (status === "supported") return 5;
  if (status === "weak") return 4;
  if (status === "unverified") return 3;
  if (status === "unreachable") return 2;
  if (status === "conflict") return 1;
  return 0;
}

function sourceRank(source: LibrarySource): number {
  if (source === "self") return 3;
  if (source === "community") return 2;
  return 1;
}

function confidenceValue(entry: LibraryEntry): number {
  if (typeof entry.confidence !== "number" || !Number.isFinite(entry.confidence)) return 0;
  if (entry.confidence < 0) return 0;
  if (entry.confidence > 1) return 1;
  return entry.confidence;
}

function chooseRepresentative(entries: LibraryEntry[]): LibraryEntry {
  return [...entries].sort((a, b) => {
    const scoreA =
      statusRank(a.verificationStatus) * 10 +
      confidenceValue(a) * 3 +
      sourceRank(a.source) +
      a.betterAnswer.length / 300;
    const scoreB =
      statusRank(b.verificationStatus) * 10 +
      confidenceValue(b) * 3 +
      sourceRank(b.source) +
      b.betterAnswer.length / 300;
    if (scoreA !== scoreB) return scoreB - scoreA;
    return b.createdAt.localeCompare(a.createdAt);
  })[0];
}

function pickBestLongText(values: string[]): string {
  return values
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .sort((a, b) => b.length - a.length)[0] ?? "";
}

function mergeSource(entries: LibraryEntry[]): LibrarySource {
  if (entries.some((item) => item.source === "self")) return "self";
  if (entries.some((item) => item.source === "community")) return "community";
  return "other";
}

function mergeStatus(entries: LibraryEntry[]): VerificationStatus {
  if (entries.some((item) => item.verificationStatus === "conflict")) return "conflict";
  if (entries.some((item) => item.verificationStatus === "supported")) return "supported";
  if (entries.some((item) => item.verificationStatus === "weak")) return "weak";
  if (entries.some((item) => item.verificationStatus === "unreachable")) return "unreachable";
  return "unverified";
}

function mergeConfidence(entries: LibraryEntry[]): number | undefined {
  const values = entries
    .map((item) => confidenceValue(item))
    .filter((item) => Number.isFinite(item));
  if (values.length === 0) return undefined;
  return Math.round(Math.max(...values) * 100) / 100;
}

function buildEvidenceNote(
  entries: LibraryEntry[],
  representativeNote: string | undefined,
): string {
  const size = entries.length;
  const statusCount = entries.reduce<Record<string, number>>((acc, entry) => {
    const key = entry.verificationStatus ?? "unverified";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const statusSummary = Object.entries(statusCount)
    .map(([key, value]) => `${key}:${value}`)
    .join(" ");
  const mergedHint = `去重合并 ${size} 条；状态分布 ${statusSummary}`;
  if (!representativeNote) return mergedHint;
  return `${representativeNote} | ${mergedHint}`;
}

function mergeGroup(entries: LibraryEntry[]): LibraryEntry {
  const representative = chooseRepresentative(entries);
  const tags = Array.from(
    new Set([
      ...entries.flatMap((item) => item.tags),
      "去重合并",
    ]),
  ).slice(0, 20);

  return {
    id: randomUUID(),
    createdAt: representative.createdAt,
    source: mergeSource(entries),
    targetRole: representative.targetRole,
    company: representative.company,
    round: representative.round,
    question: representative.question,
    pitfall: pickBestLongText(entries.map((item) => item.pitfall)),
    betterAnswer: pickBestLongText(entries.map((item) => item.betterAnswer)),
    tags,
    sourceUrl: representative.sourceUrl ?? entries.find((item) => item.sourceUrl)?.sourceUrl,
    evidenceNote: buildEvidenceNote(entries, representative.evidenceNote),
    verificationStatus: mergeStatus(entries),
    confidence: mergeConfidence(entries),
  };
}

function buildBlockKey(entry: LibraryEntry): string {
  return `${roleKey(entry.targetRole)}::${companyKey(entry.company)}`;
}

function toSamples(groups: LibraryEntry[][], limit: number): DedupGroupSample[] {
  return groups
    .slice(0, limit)
    .map((group) => {
      const representative = chooseRepresentative(group);
      return {
        representativeQuestion: representative.question,
        size: group.length,
        targetRole: representative.targetRole,
        company: representative.company,
      };
    });
}

export function dedupLibraryEntries(
  allEntries: LibraryEntry[],
  options?: DedupOptions,
): DedupResult {
  const threshold =
    typeof options?.similarityThreshold === "number"
      ? Math.min(Math.max(options.similarityThreshold, 0.7), 0.98)
      : 0.86;
  const sampleLimit =
    typeof options?.sampleLimit === "number"
      ? Math.min(Math.max(options.sampleLimit, 1), 20)
      : 6;

  const blocks = new Map<string, LibraryEntry[]>();
  for (const entry of allEntries) {
    const key = buildBlockKey(entry);
    const list = blocks.get(key) ?? [];
    list.push(entry);
    blocks.set(key, list);
  }

  const deduped: LibraryEntry[] = [];
  const duplicateGroups: LibraryEntry[][] = [];

  for (const blockEntries of blocks.values()) {
    const used = new Set<number>();
    for (let i = 0; i < blockEntries.length; i += 1) {
      if (used.has(i)) continue;
      const base = blockEntries[i];
      const group: LibraryEntry[] = [base];
      used.add(i);
      for (let j = i + 1; j < blockEntries.length; j += 1) {
        if (used.has(j)) continue;
        const candidate = blockEntries[j];
        const similarity = questionSimilarity(base.question, candidate.question);
        if (similarity >= threshold) {
          group.push(candidate);
          used.add(j);
        }
      }
      if (group.length > 1) {
        duplicateGroups.push(group);
        deduped.push(mergeGroup(group));
      } else {
        deduped.push(base);
      }
    }
  }

  const sorted = deduped.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const summary: DedupSummary = {
    beforeCount: allEntries.length,
    afterCount: sorted.length,
    mergedCount: allEntries.length - sorted.length,
    duplicateGroups: duplicateGroups.length,
    dryRun: false,
    samples: toSamples(duplicateGroups, sampleLimit),
  };

  return { entries: sorted, summary };
}
