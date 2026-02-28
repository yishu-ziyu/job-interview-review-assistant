#!/usr/bin/env node

const baseUrl = process.env.BASE_URL?.trim() || "http://localhost:3000";
const timeoutMs = Number(process.env.CLOSED_LOOP_TIMEOUT_MS ?? 180000);
const strictMode = process.env.CLOSED_LOOP_STRICT !== "false";
const strictMinDeepSources = Math.max(0, Number(process.env.CLOSED_LOOP_MIN_SOURCES ?? 3));
const strictMinAcceptedClusters = Math.max(
  0,
  Number(process.env.CLOSED_LOOP_MIN_ACCEPTED_CLUSTERS ?? 1),
);
const runId = `e2e-${Date.now()}`;

const results = [];

function pushResult(name, ok, detail) {
  results.push({ name, ok, detail });
  const icon = ok ? "PASS" : "FAIL";
  console.log(`[${icon}] ${name}${detail ? ` -> ${detail}` : ""}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, { method = "GET", body, expectOk = true } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    if (expectOk && !response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText} ${JSON.stringify(payload).slice(0, 260)}`,
      );
    }
    return { response, payload };
  } finally {
    clearTimeout(timer);
  }
}

function validUrl(url) {
  if (typeof url !== "string" || !url.trim()) return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function validateTraceability(plan) {
  if (!plan || typeof plan !== "object") return "plan 缺失";
  const trace = plan.traceability;
  if (!trace || typeof trace !== "object") return "traceability 缺失";
  if (!Array.isArray(trace.summaryRefs) || trace.summaryRefs.length === 0) {
    return "summaryRefs 为空";
  }
  if (!Array.isArray(trace.questionRefs) || trace.questionRefs.length !== plan.likelyQuestions.length) {
    return "questionRefs 长度与 likelyQuestions 不一致";
  }
  if (!Array.isArray(trace.redFlagRefs) || trace.redFlagRefs.length !== plan.redFlags.length) {
    return "redFlagRefs 长度与 redFlags 不一致";
  }
  if (!Array.isArray(trace.actionRefs) || trace.actionRefs.length !== plan.actionChecklist.length) {
    return "actionRefs 长度与 actionChecklist 不一致";
  }

  const matchedIds = new Set((plan.matchedEntries || []).map((entry) => entry.id));
  const allRefs = [
    ...trace.summaryRefs,
    ...trace.questionRefs.flat(),
    ...trace.redFlagRefs.flat(),
    ...trace.actionRefs.flat(),
  ];
  for (const ref of allRefs) {
    if (!ref || typeof ref !== "object") return "存在非法 ref";
    if (!ref.entryId || !matchedIds.has(ref.entryId)) {
      return `ref.entryId 不在 matchedEntries: ${ref?.entryId ?? "unknown"}`;
    }
    if (!ref.sourceUrl && !ref.entryId) return "ref 未提供跳转信息";
    if (ref.sourceUrl && !validUrl(ref.sourceUrl)) {
      return `ref.sourceUrl 非法: ${ref.sourceUrl}`;
    }
  }
  return null;
}

async function run() {
  console.log(`Closed-loop E2E starting: ${runId}`);
  console.log(`BASE_URL=${baseUrl}`);
  console.log(
    `STRICT_MODE=${strictMode} (minSources=${strictMinDeepSources}, minAcceptedClusters=${strictMinAcceptedClusters})`,
  );

  // 0) health
  try {
    const { response } = await request("/", { method: "GET", expectOk: false });
    pushResult("health", response.status < 500, `status=${response.status}`);
  } catch (error) {
    pushResult("health", false, error instanceof Error ? error.message : "unknown");
  }

  // 0.5) project health snapshot
  try {
    const { payload } = await request("/api/project/health", { method: "GET" });
    const ok =
      payload &&
      payload.overview &&
      payload.perspectives &&
      typeof payload.overview.libraryEntryCount === "number" &&
      Array.isArray(payload.alerts);
    pushResult("project-health.snapshot", Boolean(ok), ok ? "snapshot ok" : "schema invalid");
  } catch (error) {
    pushResult(
      "project-health.snapshot",
      false,
      error instanceof Error ? error.message : "unknown",
    );
  }

  // 1) create a unique manual library entry
  const role = `闭环测试岗位-${runId}`;
  const company = `测试公司-${runId.slice(-6)}`;
  const question = `如何做岗位闭环验证？-${runId}`;
  let createdEntryId = "";
  try {
    const { payload } = await request("/api/library/entries", {
      method: "POST",
      body: {
        source: "other",
        targetRole: role,
        company,
        round: "一面",
        question,
        pitfall: "只给结论，不给证据链。",
        betterAnswer: "先定义验收口径，再给数据和来源，最后给可执行动作。",
        tags: ["闭环测试", "可追溯"],
      },
    });
    createdEntryId = payload?.entry?.id ?? "";
    pushResult("library.create-entry", Boolean(createdEntryId), `entryId=${createdEntryId || "none"}`);
  } catch (error) {
    pushResult("library.create-entry", false, error instanceof Error ? error.message : "unknown");
  }

  // 2) query entries by role
  try {
    const { payload } = await request(
      `/api/library/entries?limit=20&targetRole=${encodeURIComponent(role)}`,
      { method: "GET" },
    );
    const entries = Array.isArray(payload?.entries) ? payload.entries : [];
    const found = entries.some((item) => item.id === createdEntryId);
    pushResult("library.query-entry", found, `entries=${entries.length}`);
  } catch (error) {
    pushResult("library.query-entry", false, error instanceof Error ? error.message : "unknown");
  }

  // 3) review generation
  let reviewPayload = null;
  try {
    const { payload } = await request("/api/reviews", {
      method: "POST",
      body: {
        targetRole: role,
        company,
        round: "一面",
        rawNotes:
          "面试官问了我如何定义北极星指标和验证方案。我回答了指标定义，但没有补充反作弊、埋点一致性和灰度策略。最后追问里我没有给出具体项目复盘结构。",
      },
    });
    reviewPayload = payload?.review;
    const ok =
      typeof reviewPayload?.summary === "string" &&
      Array.isArray(reviewPayload?.questions) &&
      reviewPayload.questions.length > 0 &&
      Array.isArray(reviewPayload?.nextActions) &&
      reviewPayload.nextActions.length > 0;
    pushResult("review.generate", ok, ok ? "review ok" : "review schema invalid");
  } catch (error) {
    pushResult("review.generate", false, error instanceof Error ? error.message : "unknown");
  }

  // 4) import review into library
  try {
    if (!reviewPayload) throw new Error("review missing");
    const { payload } = await request("/api/library/import-review", {
      method: "POST",
      body: {
        targetRole: role,
        company,
        round: "一面",
        review: reviewPayload,
      },
    });
    pushResult(
      "library.import-review",
      Number(payload?.createdCount ?? 0) > 0,
      `created=${payload?.createdCount ?? 0}`,
    );
  } catch (error) {
    pushResult("library.import-review", false, error instanceof Error ? error.message : "unknown");
  }

  // 5) import research report (manual path)
  try {
    const reportText = [
      "研究摘要：该岗位高频关注指标拆解、用户洞察、跨部门协同。",
      "问题1：如何定义北极星指标并做防刷校验。",
      "问题2：面对需求冲突如何优先级排序。",
      "建议：回答时使用目标-动作-结果-复盘结构，并给可量化结果。",
      "引用来源：招聘JD、面经社区、行业文章。",
      "补充：强调从证据到结论的逻辑链，而非凭经验拍脑袋。",
    ].join("\n");

    const { payload } = await request("/api/library/import-research", {
      method: "POST",
      body: {
        provider: "other",
        targetRole: role,
        company,
        round: "一面",
        sourceUrls: "https://example.com/a\nhttps://example.com/b",
        reportText,
        verifySources: false,
      },
    });
    pushResult(
      "library.import-research",
      Number(payload?.createdCount ?? 0) > 0,
      `created=${payload?.createdCount ?? 0}`,
    );
  } catch (error) {
    pushResult("library.import-research", false, error instanceof Error ? error.message : "unknown");
  }

  // 6) prep generation + traceability contract
  try {
    const { payload } = await request("/api/library/prep", {
      method: "POST",
      body: {
        targetRole: role,
        company,
        focus: "证据链 指标拆解",
        topK: 8,
        qualityGateEnabled: true,
        qualityGateThreshold: 60,
      },
    });
    const plan = payload?.plan;
    const traceError = validateTraceability(plan);
    pushResult("prep.generate-traceability", !traceError, traceError ?? "traceability ok");
  } catch (error) {
    pushResult(
      "prep.generate-traceability",
      false,
      error instanceof Error ? error.message : "unknown",
    );
  }

  // 7) deep research sync
  try {
    const { payload } = await request("/api/deep-research/profile", {
      method: "POST",
      body: {
        targetRole: "AI 产品经理",
        company: "字节跳动",
        focus: "面试题 能力模型",
        maxSourcesPerChannel: 8,
        enableReflection: true,
        enableCrossValidation: false,
      },
    });
    const sourceCount = Array.isArray(payload?.sources) ? payload.sources.length : 0;
    const acceptedClusterCount = Number(payload?.evidenceClusters?.accepted ?? 0);
    const basicOk =
      payload &&
      payload.searchTelemetry &&
      payload.evidenceClusters &&
      payload.readiness &&
      typeof payload.readiness.gatePassed === "boolean";
    const strictOk = strictMode
      ? sourceCount >= strictMinDeepSources &&
        acceptedClusterCount >= strictMinAcceptedClusters
      : true;
    const ok = Boolean(basicOk) && strictOk;
    pushResult(
      "deep-research.sync",
      Boolean(ok),
      `sources=${sourceCount}, acceptedClusters=${acceptedClusterCount}, strict=${strictMode ? (strictOk ? "pass" : "fail") : "off"}`,
    );
  } catch (error) {
    pushResult("deep-research.sync", false, error instanceof Error ? error.message : "unknown");
  }

  // 8) deep research async queue: create -> poll once -> cancel
  try {
    const { payload: createPayload } = await request("/api/deep-research/jobs", {
      method: "POST",
      body: {
        targetRole: "AI 产品经理",
        company: "字节跳动",
        focus: "面试题",
        maxSourcesPerChannel: 4,
        enableReflection: false,
        enableCrossValidation: false,
        maxAttempts: 2,
      },
    });
    const jobId = createPayload?.job?.id;
    if (!jobId) throw new Error("job id missing");

    await sleep(1500);
    const { payload: statusPayload } = await request(`/api/deep-research/jobs/${jobId}`);
    const status = statusPayload?.job?.status;
    const statusOk =
      status === "queued" ||
      status === "running" ||
      status === "retrying" ||
      status === "completed";
    if (!statusOk) throw new Error(`unexpected status ${status}`);

    const { payload: cancelPayload } = await request(`/api/deep-research/jobs/${jobId}`, {
      method: "DELETE",
    });
    const cancelOk = cancelPayload?.job?.status === "cancelled";
    pushResult("deep-research.queue", cancelOk, `status=${cancelPayload?.job?.status}`);
  } catch (error) {
    pushResult("deep-research.queue", false, error instanceof Error ? error.message : "unknown");
  }

  const passed = results.filter((item) => item.ok).length;
  const failed = results.length - passed;
  console.log("\n===== Closed-loop summary =====");
  console.log(`Total: ${results.length}, Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) {
    console.log("Failed cases:");
    for (const item of results.filter((row) => !row.ok)) {
      console.log(`- ${item.name}: ${item.detail}`);
    }
    process.exit(1);
  }
}

run().catch((error) => {
  console.error("Closed-loop E2E crashed:", error);
  process.exit(1);
});
