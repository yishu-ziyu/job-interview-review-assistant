import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runDeepResearchProfile } from "@/lib/deep-research";
import { appendRuntimeDevLog } from "@/lib/dev-log";
import type { DeepResearchJob, DeepResearchJobStatus, DeepResearchRequest } from "@/lib/types";

type JobStore = {
  jobs: DeepResearchJob[];
};

const STORE_DIR = path.join(process.cwd(), "data");
const STORE_PATH = path.join(STORE_DIR, "deep-research-jobs.json");
const MAX_JOB_COUNT = 200;
const MAX_EVENT_COUNT = 120;

const processingJobs = new Set<string>();
const retryTimers = new Map<string, NodeJS.Timeout>();
let mutationQueue: Promise<unknown> = Promise.resolve();

function nowIso(): string {
  return new Date().toISOString();
}

function isTerminal(status: DeepResearchJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function appendEvent(job: DeepResearchJob, type: string, message: string): void {
  job.events.unshift({
    at: nowIso(),
    type,
    message,
  });
  if (job.events.length > MAX_EVENT_COUNT) {
    job.events = job.events.slice(0, MAX_EVENT_COUNT);
  }
}

async function ensureStore(): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true });
  try {
    await fs.access(STORE_PATH);
  } catch {
    const initial: JobStore = { jobs: [] };
    await fs.writeFile(STORE_PATH, JSON.stringify(initial, null, 2), "utf-8");
  }
}

async function readStore(): Promise<JobStore> {
  await ensureStore();
  const raw = await fs.readFile(STORE_PATH, "utf-8");
  try {
    const parsed = JSON.parse(raw) as JobStore;
    if (!parsed || !Array.isArray(parsed.jobs)) return { jobs: [] };
    return parsed;
  } catch {
    return { jobs: [] };
  }
}

async function writeStore(store: JobStore): Promise<void> {
  await ensureStore();
  const tempPath = `${STORE_PATH}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf-8");
  await fs.rename(tempPath, STORE_PATH);
}

async function withStoreMutation<T>(
  mutator: (store: JobStore) => Promise<T> | T,
): Promise<T> {
  let result: T | undefined;
  const run = mutationQueue.then(async () => {
    const store = await readStore();
    result = await mutator(store);
    await writeStore(store);
  });
  mutationQueue = run.catch(() => undefined);
  await run;
  return result as T;
}

function scheduleRetry(jobId: string, delayMs: number): void {
  const previous = retryTimers.get(jobId);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    retryTimers.delete(jobId);
    void triggerDeepResearchJob(jobId);
  }, delayMs);
  retryTimers.set(jobId, timer);
}

function cloneJob<T>(input: T): T {
  return JSON.parse(JSON.stringify(input)) as T;
}

export async function listDeepResearchJobs(limit = 20): Promise<DeepResearchJob[]> {
  const cap = Math.max(1, Math.min(100, Math.floor(limit)));
  const store = await readStore();
  return store.jobs
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, cap)
    .map((item) => cloneJob(item));
}

export async function getDeepResearchJob(
  jobId: string,
  triggerIfPending = true,
): Promise<DeepResearchJob | null> {
  const store = await readStore();
  const job = store.jobs.find((item) => item.id === jobId);
  if (!job) return null;
  if (triggerIfPending && (job.status === "queued" || job.status === "retrying")) {
    void triggerDeepResearchJob(job.id);
  }
  return cloneJob(job);
}

export async function createDeepResearchJob(input: {
  payload: DeepResearchRequest;
  maxAttempts?: number;
}): Promise<DeepResearchJob> {
  const ts = nowIso();
  const maxAttempts = Math.max(1, Math.min(5, Math.round(input.maxAttempts ?? 3)));
  const job: DeepResearchJob = {
    id: randomUUID(),
    createdAt: ts,
    updatedAt: ts,
    status: "queued",
    attempts: 0,
    maxAttempts,
    payload: input.payload,
    events: [
      {
        at: ts,
        type: "queued",
        message: "任务已进入队列，等待执行。",
      },
    ],
  };

  await withStoreMutation((store) => {
    store.jobs.unshift(job);
    store.jobs = store.jobs.slice(0, MAX_JOB_COUNT);
  });

  void triggerDeepResearchJob(job.id);
  return cloneJob(job);
}

export async function cancelDeepResearchJob(jobId: string): Promise<DeepResearchJob | null> {
  return withStoreMutation((store) => {
    const job = store.jobs.find((item) => item.id === jobId);
    if (!job) return null;
    if (isTerminal(job.status)) return cloneJob(job);

    job.status = "cancelled";
    job.updatedAt = nowIso();
    job.nextRunAt = undefined;
    appendEvent(job, "cancelled", "任务已取消。");
    const timer = retryTimers.get(job.id);
    if (timer) clearTimeout(timer);
    retryTimers.delete(job.id);
    return cloneJob(job);
  });
}

export async function triggerDeepResearchJob(jobId: string): Promise<void> {
  if (processingJobs.has(jobId)) return;
  processingJobs.add(jobId);
  void (async () => {
    try {
      await processDeepResearchJob(jobId);
    } finally {
      processingJobs.delete(jobId);
    }
  })();
}

async function processDeepResearchJob(jobId: string): Promise<void> {
  const current = await getDeepResearchJob(jobId, false);
  if (!current) return;
  if (isTerminal(current.status)) return;

  if (current.status === "retrying" && current.nextRunAt) {
    const waitMs = Date.parse(current.nextRunAt) - Date.now();
    if (Number.isFinite(waitMs) && waitMs > 0) {
      scheduleRetry(jobId, waitMs);
      return;
    }
  }

  const runningJob = await withStoreMutation((store) => {
    const job = store.jobs.find((item) => item.id === jobId);
    if (!job) return null;
    if (isTerminal(job.status)) return null;

    job.status = "running";
    job.attempts += 1;
    job.updatedAt = nowIso();
    job.nextRunAt = undefined;
    appendEvent(job, "running", `开始执行第 ${job.attempts}/${job.maxAttempts} 次。`);
    return cloneJob(job);
  });

  if (!runningJob) return;

  try {
    const result = await runDeepResearchProfile(runningJob.payload);
    await withStoreMutation((store) => {
      const job = store.jobs.find((item) => item.id === jobId);
      if (!job) return;
      if (job.status === "cancelled") return;
      job.status = "completed";
      job.updatedAt = nowIso();
      job.result = result;
      appendEvent(job, "completed", "任务执行完成。");
    });
    await appendRuntimeDevLog({
      module: "/queue/deep-research",
      action: "job-completed",
      status: result.readiness.gatePassed ? "ok" : "blocked",
      summary: result.readiness.gatePassed
        ? "异步任务完成，研究门禁通过"
        : `异步任务完成，但门禁未通过：${result.readiness.blockers[0] ?? "证据不足"}`,
      meta: {
        jobId,
        attempts: runningJob.attempts,
        readinessScore: result.readiness.score,
        readinessLevel: result.readiness.level,
        sourceCount: result.sources.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    await withStoreMutation((store) => {
      const job = store.jobs.find((item) => item.id === jobId);
      if (!job) return;
      if (job.status === "cancelled") return;

      if (job.attempts >= job.maxAttempts) {
        job.status = "failed";
        job.lastError = message;
        job.updatedAt = nowIso();
        appendEvent(job, "failed", `重试次数耗尽：${message}`);
        return;
      }

      const delayMs = Math.min(30000, 2000 * 2 ** Math.max(0, job.attempts - 1));
      job.status = "retrying";
      job.lastError = message;
      job.updatedAt = nowIso();
      job.nextRunAt = new Date(Date.now() + delayMs).toISOString();
      appendEvent(job, "retrying", `执行失败，${Math.round(delayMs / 1000)} 秒后重试：${message}`);
      scheduleRetry(job.id, delayMs);
    });
    const latest = await getDeepResearchJob(jobId, false);
    await appendRuntimeDevLog({
      module: "/queue/deep-research",
      action: "job-failed-or-retrying",
      status: latest?.status === "failed" ? "error" : "blocked",
      summary:
        latest?.status === "failed"
          ? `异步任务失败：${message}`
          : `异步任务失败，已进入重试：${message}`,
      meta: {
        jobId,
        attempts: latest?.attempts ?? runningJob.attempts,
        maxAttempts: latest?.maxAttempts ?? runningJob.maxAttempts,
        nextRunAt: latest?.nextRunAt,
      },
    });
  }
}
