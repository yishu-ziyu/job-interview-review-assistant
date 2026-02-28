# 阶段 4：Deep Research 工程逻辑学习与落地

更新时间：2026-02-20

## 1) 参考的开源样例（GitHub）

1. `assafelovic/gpt-researcher`
   - 特征：提供端到端 Autonomous agent、检索 + 分析 + 报告流水线，强调“可信来源与可追溯”。  
   - 仓库：[https://github.com/assafelovic/gpt-researcher](https://github.com/assafelovic/gpt-researcher)

2. `dzhng/deep-research`
   - 特征：强调 iterative process（检索 -> 反思 -> 继续检索），并输出结构化报告。  
   - 仓库：[https://github.com/dzhng/deep-research](https://github.com/dzhng/deep-research)

3. `huggingface/smolagents` 的 `open_deep_research` 示例
   - 特征：多步骤代理式研究，强调“多阶段推理 + 证据驱动”。  
   - 仓库示例：[https://github.com/huggingface/smolagents/tree/main/examples/open_deep_research](https://github.com/huggingface/smolagents/tree/main/examples/open_deep_research)

4. `langchain-ai/open_deep_research`
   - 特征：兼容多模型与多搜索 API，支持多智能体并行与可扩展工作流。  
   - 仓库：[https://github.com/langchain-ai/open_deep_research](https://github.com/langchain-ai/open_deep_research)

## 2) 抽象出的通用工程逻辑

1. 研究计划分解（Plan）
   - 把大问题拆成多个检索子问题（渠道/视角）。

2. 并行检索（Parallel Search）
   - 多 query、多渠道并行执行，提升覆盖率与速度。

3. 证据聚合与去重（Evidence Merge）
   - 去重 URL、控制域名分布、保留高价值来源。

4. 反思与补查（Reflect & Iterate）
   - 对薄弱结论再次检索（当前版本先保留接口，后续可迭代）。

5. 结构化输出（Synthesis）
   - 用统一 JSON 模板输出，便于后续产品流程消费。

## 3) 我们在项目中的落地（B2）

已实现 `B2 多源并行 Deep Research 岗位画像`：

1. 通道拆分（5 通道）：
   - `job`（岗位JD）
   - `interview`（面经）
   - `community`（社区讨论）
   - `knowledge`（方法论与能力框架）
   - `salary`（薪酬与市场信号）

2. 并行检索：
   - 自动构造每通道查询计划，批量搜索并去重聚合。

3. 结构化画像输出：
   - `岗位摘要 / 核心职责 / 核心技能 / 面试主题 / 市场信号 / 风险 / 行动清单`

4. 与现有流程打通：
   - 一键回填到 B1 导入区，继续写入经验库。

## 4) 当前实现进度（B2）

1. B2.1 已实现：反思式二次检索  
   - 自动识别弱渠道与证据缺口  
   - 自动生成补查 query 并执行二轮检索  
   - 前端可查看“弱渠道 / 缺口假设 / 二轮查询清单”

2. B2.2 已实现：可信来源打分（来源质量权重）  
   - 每条来源计算质量分（0-100）与 A/B/C 分级  
   - 评分依据：域名可信度、通道匹配度、信息量、查询意图一致性、噪声惩罚  
   - 模型综合阶段优先使用高质量证据  
   - 前端显示质量看板（均分 + A/B/C + 按渠道均分）与单条评分理由

3. B2.3 已实现：多模型交叉验证  
   - 支持指定复核提供方与复核模型（如 `crossValidationProvider` / `crossValidationModel`）  
   - 第二模型独立生成岗位画像并与主模型做结构化对齐  
   - 输出一致度评分（0-100）、一致点、冲突点与最终建议  
   - 前端展示 B2.3 诊断面板，便于 PM 判断是否需要补检索

## 5) 下一步可升级方向

1. 时效性分层（最近 30/90/180 天）
2. 来源时效分与发布时间抽取（可选）
3. 冲突点自动回流为反思检索 query（B2.1 与 B2.3 联动）
