# 求职面试复盘助手（Phase 3A）

技术栈：
- Next.js App Router
- 国内 LLM（智谱 / Minimax / 豆包）
- Supabase（可选，仅复盘日志）
- 本地经验库（`data/interview-library.json`）

## 1. 启动

```bash
npm install
cp .env.example .env.local
npm run dev
```

访问 `http://localhost:3000`。  
注意：修改 `.env.local` 后需要重启服务。

当前交付形态：`网页端（Web）`。  
后续可封装为移动端 App（Capacitor / Tauri / React Native WebView）。

## 2. 环境变量

必填：
- `LLM_PROVIDER`: `zhipu` / `minimax` / `doubao`
- `LLM_API_KEY`

建议（智谱 GLM-5）：
- `LLM_TIMEOUT_MS=90000`
- `ZHIPU_MODEL=glm-5`
- `ZHIPU_THINKING_TYPE=disabled`
- `ZHIPU_DO_SAMPLE=false`
- `ZHIPU_MAX_TOKENS=2048`

## 3. Phase 3A 能力

- `复盘模式`：面试后生成三段式复盘
- `一键导入经验库`：把本次复盘的问答条目写入库
- `面试前准备模式`：
  - 手动录入他人/本人面经
  - B1 全自动 v1：输入研究页 URL 后自动抓取正文与引用并直接入库（实验）
  - B1：浏览器一键抓取（书签脚本抓取当前 Deep Research 页面并回填）
  - B1.3：公司别名词典配置（新增/编辑/删除/保存/恢复默认）
  - B2：多源并行 Deep Research（岗位画像自动生成）
  - B2.1：反思式二次检索（自动补查证据薄弱渠道）
  - B2.2：可信来源打分（来源质量分 + A/B/C 分级 + 加权综合）
  - B2.3：多模型交叉验证（第二模型复核 + 一致度评分 + 冲突点）
  - A0：内置 PM Demo 库一键加载（100 条 / 10 公司）
  - A2：经验库去重合并（预览/执行）
  - A3：图片 OCR 导入（截图转文本后入库）
  - 导入 Deep Research 结果（报告文本 + 来源 URL）
  - 来源复查（支持/偏弱/冲突/不可达）
  - 检索经验库
  - 融合生成面试前策略（高概率问题、风险点、行动清单）
  - 面试前策略质量体检（证据得分、质量等级、来源结构、风险提示）

## 3.1 B1 使用说明（推荐）

### B1 全自动 v1（实验）

1. 在 `面试前准备模式 -> B1｜网页一键抓取 + 研究结果导入` 的 `B1 全自动 v1（实验）` 输入研究页 URL  
2. 点击 `一键自动抓取并导入经验库`  
3. 系统自动执行：打开页面 -> 抽取正文与引用 -> 解析经验条目 -> 入库 -> 来源复查  
4. 完成后可在同区域看到抓取元信息、复查统计与经验库新增结果

说明：
- 如目标页面需要登录，自动抓取可能失败；请先登录后重试，或改用 B1 书签手动抓取兜底
- 首次使用建议安装浏览器内核：`npx playwright install chromium`

1. 在 `面试前准备模式 -> B1｜网页一键抓取 + 研究结果导入` 点击 `步骤1：复制书签脚本 URL`
2. 在浏览器中创建一个书签，把书签地址替换为该 URL
3. 打开豆包 / Minimax / ChatGPT / Gemini 的研究结果页
4. 如是豆包，请先展开右侧 `参考资料` 列表，再点击这个书签
5. 回到本项目页面点击 `步骤2：读取抓取结果（剪贴板）`
6. 系统会自动做清洗，并显示：字数变化、去噪行数、清洗前后预览
7. 系统会自动给出 `目标岗位/公司` 建议（B1.2），可点标签或 `一键应用建议`
8. 可在 `B1.3 公司别名词典配置` 里自定义公司映射后保存
9. 按需点 `使用清洗文本` 或 `使用原始文本`
10. 点击 `导入研究结果到经验库`

## 4. API

### 4.1 复盘

`POST /api/reviews`

### 4.2 经验库

`GET /api/library/entries?limit=30&targetRole=&company=&q=`

`POST /api/library/entries`

请求体示例：

```json
{
  "source": "community",
  "targetRole": "AI 产品经理",
  "company": "华为",
  "round": "终面",
  "question": "为什么这个岗位要招你？",
  "pitfall": "只讲经历，不对齐岗位核心要求。",
  "betterAnswer": "先复述岗位目标，再给出2个量化案例。",
  "tags": "岗位匹配,价值证明"
}
```

### 4.3 复盘导入经验库

`POST /api/library/import-review`

### 4.4 导入 Deep Research 结果

`POST /api/library/import-research`

请求体示例：

```json
{
  "provider": "gemini",
  "targetRole": "AI 产品经理",
  "company": "华为",
  "round": "一面",
  "sourceUrls": "https://example.com/a\nhttps://example.com/b",
  "reportText": "（粘贴 Deep Research 报告正文）",
  "verifySources": true
}
```

### 4.5 面试前策略生成

`POST /api/library/prep`

请求体示例：

```json
{
  "targetRole": "AI 产品经理",
  "company": "华为",
  "focus": "指标拆解 表达结构",
  "topK": 8,
  "qualityGateEnabled": true,
  "qualityGateThreshold": 60
}
```

返回重点字段：
- `plan.quality.evidenceScore`: 策略证据得分（0-100）
- `plan.quality.qualityLevel`: 质量等级（高/中/低）
- `plan.quality.gateEnabled/gateThreshold/gatePassed`: 质量门槛开关、阈值、是否通过
- `plan.quality.gateReason`: 未通过时的门槛触发原因
- `plan.quality.supportedCount/weakCount/conflictCount...`: 命中条目的证据状态分布
- `plan.quality.sourceDiversity`: 来源结构（self/community/other）
- `plan.quality.riskTips`: 质量风险提示（用于提示先补证据再行动）
- `plan.traceability.summaryRefs`: 策略摘要证据引用
- `plan.traceability.questionRefs`: 每个高概率问题对应证据引用（按索引）
- `plan.traceability.redFlagRefs`: 每条风险提醒对应证据引用（按索引）
- `plan.traceability.actionRefs`: 每条行动清单对应证据引用（按索引）

### 4.6 B1.3 公司别名词典配置

`GET /api/config/company-aliases`

`PUT /api/config/company-aliases`

请求体示例：

```json
{
  "entries": [
    {
      "company": "字节跳动",
      "aliases": ["字节", "抖音", "飞书", "doubao"]
    }
  ]
}
```

`POST /api/config/company-aliases`

请求体示例：

```json
{
  "action": "reset"
}
```

### 4.7 A2 经验库去重合并

`POST /api/library/dedup`

请求体示例：

```json
{
  "dryRun": true,
  "similarityThreshold": 0.86
}
```

### 4.8 A3 图片 OCR 导入

`POST /api/library/import-image`（`multipart/form-data`）

字段示例：
- `image`: 文件（png/jpg/jpeg/webp，<=5MB）
- `provider`: `other` / `gemini` / `gpt` / `doubao` / `zhipu`
- `targetRole`: 岗位（必填）
- `company`: 公司（可选）
- `round`: 轮次（可选）
- `sourceUrls`: 来源链接（可选，多行）
- `verifySources`: `true/false`

### 4.9 B2 多源 Deep Research 岗位画像

`POST /api/deep-research/profile`

请求体示例：

```json
{
  "targetRole": "AI 产品经理",
  "company": "字节跳动",
  "focus": "能力模型 面试题 薪资",
  "maxSourcesPerChannel": 8,
  "enableReflection": true,
  "reflectionQueriesPerChannel": 2,
  "enableCrossValidation": true,
  "crossValidationProvider": "zhipu",
  "crossValidationModel": "glm-4.5"
}
```

返回重点字段：
- `searchTelemetry`: B2.4 的检索引擎统计（主检成功、回退成功、失败查询、引擎命中）
- `reflection`: B2.1 的弱渠道、补查假设、二轮 query 清单、二轮新增来源数
- `qualityStats`: B2.2 的来源质量统计（平均分、A/B/C 数量、按渠道平均分）
- `crossValidation`: B2.3 的交叉验证结果（复核模型、一致度、一致点、冲突点、最终建议）
- `evidenceClusters`: B2.5 的论点聚类结果（双域名门槛、合格聚类数、聚类详情）
- `readiness`: 研究结果可用性门禁（是否通过、准备度评分、阻塞项、修复建议）

### 4.10 A0 内置 PM Demo 库

`GET /api/library/seed-pm-demo`

返回内置库元信息（版本、公司数、条目数）和结构分布：
- `companyDistribution`: 公司 -> 条目数
- `roundDistribution`: 面试轮次 -> 条目数
- `quality`: 内置库质量体检结果（标准化率、能力覆盖度、难度分布、能力分布、缺失能力）

`POST /api/library/seed-pm-demo`

请求体示例：

```json
{
  "resetDemo": false
}
```

返回字段：
- `plannedCount`: 内置库总条目数（100）
- `createdCount`: 本次新增条目数
- `skippedCount`: 已存在被跳过条目数
- `demoEntriesInLibrary`: 当前经验库中 PM 内置条目数量
- `companyDistribution`: 内置库公司分布
- `roundDistribution`: 内置库轮次分布
- `quality`: 本次导入对应的质量体检结果

质量增强说明：
- 导入时会自动为每条 PM 内置数据补齐标准化标签：`难度:*`、`题型:*`、`能力:*`
- 标签补齐采用“关键词规则 + 既有标签映射”，并保证每条至少 2 个能力标签
- 如需让已导入旧条目也应用新标准化标签，请点击前端 A0 的“重置后重载 PM Demo 库”

内置数据文件：
- `data/pm-demo-library.v1.json`

### 4.11 B1 全自动抓取并导入（实验）

`POST /api/library/auto-capture-import`

请求体示例：

```json
{
  "pageUrl": "https://www.doubao.com/chat/xxxx",
  "provider": "auto",
  "targetRole": "AI 产品经理",
  "company": "字节跳动",
  "round": "一面",
  "verifySources": true,
  "waitMs": 3500
}
```

返回重点字段：
- `createdCount`: 新增经验条目数
- `sourceChecks`: 来源复查详情
- `stats`: 证据状态统计
- `capture`: 抓取元信息（标题、来源 URL、清洗文本、建议岗位/公司等）

### 4.12 运行日志（自动落盘）

系统会在接口执行时自动写两份日志（项目根目录）：
- `../开发日志.md`：可读日志（按时间追加）
- `../开发日志.runtime.ndjson`：结构化日志（便于后续分析）

当前已接入接口：
- `POST /api/library/prep`
- `POST /api/library/import-research`
- `POST /api/library/auto-capture-import`
- `POST /api/deep-research/profile`

日志字段包含：
- 模块、动作、状态（`ok/blocked/error`）
- 摘要信息
- 关键元数据（如岗位、公司、门槛是否通过、入库条数等）

### 4.13 B2.6 异步任务队列

创建任务：

`POST /api/deep-research/jobs`

请求体与 `/api/deep-research/profile` 基本一致，另支持：
- `maxAttempts`: 最大重试次数（1-5，默认 3）

查询任务：

`GET /api/deep-research/jobs/{jobId}`

取消任务：

`DELETE /api/deep-research/jobs/{jobId}`

任务列表：

`GET /api/deep-research/jobs?limit=20`

状态机：
- `queued` -> `running` -> `completed`
- 失败会进入 `retrying`，重试耗尽后 `failed`
- 可手动取消为 `cancelled`

### 4.14 项目健康快照（多角色视角）

`GET /api/project/health`

返回内容包含：
- `overview`：库规模、7天通过率、错误率、平均准备度
- `perspectives.user/developer/engineer/productManager`：四视角健康等级、摘要、建议
- `breakdown.verification`：证据状态分布
- `breakdown.jobsByStatus`：深研任务状态分布
- `alerts`：高优先级风险提醒（可直接作为迭代待办）

### 4.15 闭环测试（建议每次改动后执行）

1. 启动服务

```bash
npm run dev
```

2. 新开终端执行闭环脚本

```bash
npm run test:closed-loop
```

默认即为严格模式（`STRICT_MODE=true`）：
- `deep-research.sync` 必须满足 `sources >= 3`
- `deep-research.sync` 必须满足 `acceptedClusters >= 1`

可按需覆盖阈值：

```bash
CLOSED_LOOP_MIN_SOURCES=5 CLOSED_LOOP_MIN_ACCEPTED_CLUSTERS=2 npm run test:closed-loop
```

如需临时关闭严格校验（仅排障使用）：

```bash
CLOSED_LOOP_STRICT=false npm run test:closed-loop
```

脚本会自动覆盖 10 个关键链路：
- 健康检查
- 项目健康快照
- 经验条目创建与检索
- 复盘生成与复盘入库
- Research 导入入库
- 面前策略生成 + 证据可追溯校验
- Deep Research 同步接口结构校验
- Deep Research 异步队列创建/查询/取消

判定规则：
- 输出 `Total: 10, Passed: 10, Failed: 0` 视为闭环通过
- 任一失败会输出失败用例并以非 0 退出码结束

## 5. 经验库存储

默认本地文件：

`data/interview-library.json`

适合个人实验与快速迭代；后续可迁移到 Supabase/Postgres。

## 6. 常见问题

`POST /api/reviews 500 in 30s`：
- 原因：模型偶发慢响应导致超时。
- 处理：
  - `LLM_TIMEOUT_MS` 调大到 `90000`
  - `ZHIPU_MAX_TOKENS` 设为 `2048`
  - 保持 `ZHIPU_THINKING_TYPE=disabled`、`ZHIPU_DO_SAMPLE=false`
