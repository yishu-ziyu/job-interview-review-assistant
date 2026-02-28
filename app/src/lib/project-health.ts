import fs from "node:fs/promises";
import path from "node:path";
import { listDeepResearchJobs } from "@/lib/deep-research-queue";
import { listLibraryEntries } from "@/lib/library-store";
import type {
  DeepResearchJobStatus,
  ProjectHealthLevel,
  ProjectHealthSnapshot,
  VerificationStatus,
} from "@/lib/types";

const LOG_PATH = path.resolve(process.cwd(), "..", "开发日志.runtime.ndjson");
const WINDOW_DAYS = 7;

type RuntimeLogLine = {
  timestamp?: string;
  module?: string;
  action?: string;
  status?: "ok" | "blocked" | "error";
};

function percentage(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

function average(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  const total = numbers.reduce((acc, value) => acc + value, 0);
  return Number((total / numbers.length).toFixed(1));
}

function toStatus(
  healthCondition: boolean,
  watchCondition: boolean,
): ProjectHealthLevel {
  if (healthCondition) return "healthy";
  if (watchCondition) return "watch";
  return "risk";
}

function normalizeVerificationStatus(
  value: VerificationStatus | undefined,
): VerificationStatus {
  if (!value) return "unverified";
  return value;
}

async function readRuntimeLogs(): Promise<RuntimeLogLine[]> {
  try {
    const raw = await fs.readFile(LOG_PATH, "utf-8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as RuntimeLogLine;
        } catch {
          return null;
        }
      })
      .filter((line): line is RuntimeLogLine => line !== null);
  } catch {
    return [];
  }
}

export async function buildProjectHealthSnapshot(): Promise<ProjectHealthSnapshot> {
  const [entries, jobs, runtimeLogs] = await Promise.all([
    listLibraryEntries(),
    listDeepResearchJobs(200),
    readRuntimeLogs(),
  ]);

  const nowMs = Date.now();
  const windowStartMs = nowMs - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const logsInWindow = runtimeLogs.filter((line) => {
    const ts = Date.parse(line.timestamp ?? "");
    return Number.isFinite(ts) && ts >= windowStartMs;
  });

  const prepLogs = logsInWindow.filter(
    (line) =>
      line.module === "/api/library/prep" &&
      line.action === "generate-prep-plan",
  );
  const deepLogs = logsInWindow.filter(
    (line) =>
      line.module === "/api/deep-research/profile" &&
      line.action === "run-deep-research",
  );
  const errorLogs = logsInWindow.filter((line) => line.status === "error");

  const prepPassRate7d = percentage(
    prepLogs.filter((line) => line.status === "ok").length,
    prepLogs.length,
  );
  const deepResearchPassRate7d = percentage(
    deepLogs.filter((line) => line.status === "ok").length,
    deepLogs.length,
  );
  const runtimeErrorRate7d = percentage(errorLogs.length, logsInWindow.length);

  const jobsByStatus: Record<DeepResearchJobStatus, number> = {
    queued: 0,
    running: 0,
    retrying: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const job of jobs) {
    jobsByStatus[job.status] += 1;
  }

  const completedJobsWithResult = jobs.filter(
    (job) => job.status === "completed" && job.result,
  );
  const queueGatePassRate = percentage(
    completedJobsWithResult.filter((job) => job.result?.readiness.gatePassed).length,
    completedJobsWithResult.length,
  );
  const avgReadinessScore = average(
    completedJobsWithResult
      .map((job) => job.result?.readiness.score ?? 0)
      .filter((score) => Number.isFinite(score)),
  );

  const verification = {
    supported: 0,
    weak: 0,
    conflict: 0,
    unverified: 0,
    unreachable: 0,
  };
  let entriesWithoutEvidence = 0;
  for (const entry of entries) {
    const normalizedStatus = normalizeVerificationStatus(entry.verificationStatus);
    verification[normalizedStatus] += 1;
    if (!entry.sourceUrl && !entry.evidenceNote) entriesWithoutEvidence += 1;
  }

  const supportedRate = percentage(verification.supported, entries.length);
  const missingEvidenceRate = percentage(entriesWithoutEvidence, entries.length);
  const roleCount = new Set(
    entries.map((entry) => entry.targetRole).filter((item) => item.trim().length > 0),
  ).size;
  const companyCount = new Set(
    entries
      .map((entry) => entry.company ?? "")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  ).size;

  const userLevel = toStatus(
    prepPassRate7d >= 55 && deepResearchPassRate7d >= 55,
    prepPassRate7d >= 35 && deepResearchPassRate7d >= 35,
  );
  const developerLevel = toStatus(
    runtimeErrorRate7d <= 5 && jobsByStatus.failed <= 1,
    runtimeErrorRate7d <= 15 && jobsByStatus.failed <= 4,
  );
  const engineerLevel = toStatus(
    supportedRate >= 30 && missingEvidenceRate <= 35,
    supportedRate >= 15 && missingEvidenceRate <= 60,
  );
  const productManagerLevel = toStatus(
    roleCount >= 2 && companyCount >= 5 && logsInWindow.length >= 20,
    roleCount >= 1 && companyCount >= 3 && logsInWindow.length >= 8,
  );

  const userRecommendations: string[] = [];
  if (prepPassRate7d < 55) {
    userRecommendations.push("提高 prep 通过率：补充高质量样本后再生成策略。");
  }
  if (deepResearchPassRate7d < 55) {
    userRecommendations.push("提高深研通过率：优先覆盖 5 类渠道并增加跨域名证据。");
  }
  if (userRecommendations.length === 0) {
    userRecommendations.push("保持当前操作流程，持续补充同岗位多公司样本。");
  }

  const developerRecommendations: string[] = [];
  if (runtimeErrorRate7d > 5) {
    developerRecommendations.push("降低错误率：优先修复最近 7 天 `error` 状态接口。");
  }
  if (jobsByStatus.failed > 1) {
    developerRecommendations.push("队列失败较高：检查重试上限和第三方网络可达性。");
  }
  if (developerRecommendations.length === 0) {
    developerRecommendations.push("保持当前稳定性，继续观察异步队列失败率。");
  }

  const engineerRecommendations: string[] = [];
  if (supportedRate < 30) {
    engineerRecommendations.push("提升证据支持率：为条目补全来源 URL 与复查结果。");
  }
  if (missingEvidenceRate > 35) {
    engineerRecommendations.push("降低无证据条目占比：入库时强制记录来源或证据备注。");
  }
  if (engineerRecommendations.length === 0) {
    engineerRecommendations.push("数据结构健康，建议推进字段规范与自动校验。");
  }

  const pmRecommendations: string[] = [];
  if (roleCount < 2) {
    pmRecommendations.push("扩展岗位覆盖：除 AI 产品经理外新增至少 1 个岗位模板。");
  }
  if (companyCount < 5) {
    pmRecommendations.push("扩展公司覆盖：优先补齐一线互联网公司样本。");
  }
  if (logsInWindow.length < 20) {
    pmRecommendations.push("提高有效事件量：固定每日回归和导入任务。");
  }
  if (pmRecommendations.length === 0) {
    pmRecommendations.push("已具备初步验证样本，建议进入小规模外测。");
  }

  const alerts: string[] = [];
  if (deepResearchPassRate7d < 40) {
    alerts.push(
      `最近 ${WINDOW_DAYS} 天深研通过率偏低（${deepResearchPassRate7d}%），影响行动前决策质量。`,
    );
  }
  if (runtimeErrorRate7d > 10) {
    alerts.push(
      `最近 ${WINDOW_DAYS} 天运行错误率为 ${runtimeErrorRate7d}% ，需优先清理接口异常。`,
    );
  }
  if (missingEvidenceRate > 50) {
    alerts.push(`经验库无证据条目占比 ${missingEvidenceRate}% ，可追溯性不足。`);
  }
  if (jobsByStatus.retrying > 0) {
    alerts.push(`当前有 ${jobsByStatus.retrying} 个深研任务处于重试中。`);
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    overview: {
      libraryEntryCount: entries.length,
      roleCount,
      companyCount,
      deepResearchJobCount: jobs.length,
      prepPassRate7d,
      deepResearchPassRate7d,
      runtimeErrorRate7d,
      queueGatePassRate,
      avgReadinessScore,
    },
    perspectives: {
      user: {
        level: userLevel,
        summary:
          userLevel === "healthy"
            ? "核心链路可用，用户可稳定完成复盘与准备。"
            : userLevel === "watch"
              ? "核心链路可用但通过率不稳，需补证据。"
              : "用户效果不稳定，建议先修质量再扩展功能。",
        recommendations: userRecommendations,
      },
      developer: {
        level: developerLevel,
        summary:
          developerLevel === "healthy"
            ? "接口与队列运行稳定。"
            : developerLevel === "watch"
              ? "存在可恢复问题，需持续跟踪。"
              : "稳定性风险偏高，需优先修复错误与失败任务。",
        recommendations: developerRecommendations,
      },
      engineer: {
        level: engineerLevel,
        summary:
          engineerLevel === "healthy"
            ? "数据质量与可追溯性达到可迭代状态。"
            : engineerLevel === "watch"
              ? "数据结构可用，但证据质量仍需加强。"
              : "数据可信度不足，影响模型输出可靠性。",
        recommendations: engineerRecommendations,
      },
      productManager: {
        level: productManagerLevel,
        summary:
          productManagerLevel === "healthy"
            ? "具备继续外测和迭代的产品基础。"
            : productManagerLevel === "watch"
              ? "已形成基础闭环，但样本规模仍偏小。"
              : "尚处于验证早期，需先扩大样本与事件量。",
        recommendations: pmRecommendations,
      },
    },
    breakdown: {
      verification,
      jobsByStatus,
    },
    alerts: alerts.slice(0, 6),
  };
}
