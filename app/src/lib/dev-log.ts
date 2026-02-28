import fs from "node:fs/promises";
import path from "node:path";

type DevLogStatus = "ok" | "blocked" | "error";

export type RuntimeDevLogInput = {
  module: string;
  action: string;
  status: DevLogStatus;
  summary: string;
  meta?: Record<string, unknown>;
};

const PROJECT_ROOT = path.resolve(process.cwd(), "..");
const HUMAN_LOG_PATH = path.join(PROJECT_ROOT, "开发日志.md");
const NDJSON_LOG_PATH = path.join(PROJECT_ROOT, "开发日志.runtime.ndjson");
const AUTO_SECTION_TITLE = "## 自动运行日志（接口实时）";
const MAX_SUMMARY_LENGTH = 220;

function formatDateTimeCN(date: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function sanitizeInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSummary(value: string): string {
  const text = sanitizeInline(value);
  if (text.length <= MAX_SUMMARY_LENGTH) return text;
  return `${text.slice(0, MAX_SUMMARY_LENGTH)}...`;
}

async function ensureHumanLogFile(): Promise<void> {
  try {
    await fs.access(HUMAN_LOG_PATH);
  } catch {
    const initial = [
      "# 开发日志（实时同步）",
      "",
      `> 自动日志文件：\`${path.basename(NDJSON_LOG_PATH)}\``,
      "",
      AUTO_SECTION_TITLE,
      "",
    ].join("\n");
    await fs.writeFile(HUMAN_LOG_PATH, initial, "utf-8");
  }
}

async function ensureAutoSection(): Promise<void> {
  await ensureHumanLogFile();
  const content = await fs.readFile(HUMAN_LOG_PATH, "utf-8");
  if (content.includes(AUTO_SECTION_TITLE)) return;
  const suffix = content.endsWith("\n") ? "" : "\n";
  await fs.appendFile(HUMAN_LOG_PATH, `${suffix}\n${AUTO_SECTION_TITLE}\n\n`, "utf-8");
}

function buildHumanLine(input: RuntimeDevLogInput, now: Date): string {
  const ts = formatDateTimeCN(now);
  const summary = normalizeSummary(input.summary);
  const meta =
    input.meta && Object.keys(input.meta).length > 0
      ? ` | meta=${JSON.stringify(input.meta)}`
      : "";
  return `- ${ts} | ${input.module} | ${input.action} | ${input.status} | ${summary}${meta}\n`;
}

function buildNdjsonLine(input: RuntimeDevLogInput, now: Date): string {
  return `${JSON.stringify({
    timestamp: now.toISOString(),
    module: input.module,
    action: input.action,
    status: input.status,
    summary: normalizeSummary(input.summary),
    meta: input.meta ?? {},
  })}\n`;
}

export async function appendRuntimeDevLog(input: RuntimeDevLogInput): Promise<void> {
  const now = new Date();
  const normalized: RuntimeDevLogInput = {
    module: sanitizeInline(input.module) || "unknown-module",
    action: sanitizeInline(input.action) || "unknown-action",
    status: input.status,
    summary: input.summary || "no-summary",
    meta: input.meta,
  };

  try {
    await ensureAutoSection();
    await fs.appendFile(HUMAN_LOG_PATH, buildHumanLine(normalized, now), "utf-8");
  } catch (error) {
    console.error("appendRuntimeDevLog(human) failed:", error);
  }

  try {
    await fs.appendFile(NDJSON_LOG_PATH, buildNdjsonLine(normalized, now), "utf-8");
  } catch (error) {
    console.error("appendRuntimeDevLog(ndjson) failed:", error);
  }
}
