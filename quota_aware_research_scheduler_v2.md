# Quota-Aware Research Scheduler V2 技术设计

**状态：**设计定稿前评审版本  
**目标：**将 QuotaPilot 从额度看板升级为可审计的科研计算资源调度系统。

## 1. 设计结论

V2 不再以“模型剩余请求数”作为主要调度对象。对于 OpenCode Go，主对象是三个共享使用价值窗口：5 小时、周、月；模型本身由**能力、调用成本、可用性和稀缺性**描述。官方表中的典型请求数只用于初始化成本估计和稀缺性校准，不能被解释为模型专属余额。[1]

ChatGPT Plus 不进入自动 API provider pool。它是人工研究救援通道，用于关键研究判断、最终分析、论文结论审查与人工介入；它的产品内使用限额与 OpenAI API 独立计费，并且限制可随系统条件变化。[2] 自动任务队列只使用具备服务器端可审计凭据的 API provider。

## 2. 系统边界与资源域

| 资源域 | 调度方式 | 可自动执行 | 真实数据来源 | 备注 |
|---|---|---:|---|---|
| OpenCode Go 共享池 | 共享美元预算、模型成本和稀缺性 | 是 | provider usage adapter / 遥测事件 | 5h、周、月三个独立窗口 |
| OpenAI API 项目 | 项目成本、速率和 API 预算 | 是 | Organization Usage / Costs API | 与 ChatGPT Plus 分离 [3] |
| ChatGPT Plus | 人工研究救援 | 否 | 人工状态、导入记录或显式审查确认 | 不当作普通 fallback |
| 本地/免费模型 | 连续性兜底 | 可选 | 本地遥测 | 仅限明确允许的低风险任务 |

## 3. 规范化数据模型

### 3.1 Provider Budget

```ts
type ProviderBudget = {
  id: string;
  provider: "opencode_go" | "openai_api" | "local";
  window: "five_hour" | "weekly" | "monthly" | "daily";
  limitUsd: number;
  consumedUsd: number;
  reservedUsd: number;
  availableUsd: number; // limitUsd - consumedUsd - reservedUsd
  resetAt: number;      // UTC Unix ms
  burnRate15mUsdPerHour: number;
  burnRate1hUsdPerHour: number;
  burnRate5hUsdPerHour: number;
  burnRate24hUsdPerHour: number;
  forecastExhaustionAt: number | null;
  state: "GREEN" | "YELLOW" | "ORANGE" | "DRAIN_PROTECTION" | "RED";
};
```

共享池可用预算始终按以下形式计算：

```text
available_usd = limit_usd − consumed_usd − active_reservations_usd
```

任何模型卡片展示的“剩余”都必须是**该共享池在该模型典型任务下可支撑的估算量**，而不是独立模型余额。

### 3.2 模型注册表与能力矩阵

```ts
type ModelCapability = {
  provider: string;
  modelId: string;
  displayName: string;
  costPerMillion: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  scarcityFactor: number; // 0–1，越高越稀缺
  capability: {
    code: number;
    reasoning: number;
    longContext: number;
    vision: number;
    toolUse: number;
    chinese: number;
    research: number;
    agent: number;
    speed: number;
    reliability: number;
  };
  maxConcurrency: number;
  enabled: boolean;
  source: "provider_registry" | "workspace_policy";
};
```

OpenCode Go 的模型目录不得硬编码。系统应把官方 `/zen/go/v1/models` 返回作为可用模型的规范来源，并以 workspace policy 补充能力评估和稀缺性。当前英文官方页面确实同时列出 `GPT 5.6 Luna` 和 `Qwen3.8 Max`；由于目录随测试和新增模型变化，V2 以动态登记表而不是固定文档清单解决这一争议。[1]

### 3.3 任务、预算和预留

```ts
type ResearchTask = {
  id: string;
  workspaceId: string;
  experimentId?: string;
  runId?: string;
  priority: "P0" | "P1" | "P2" | "P3";
  class: "formal_experiment" | "experiment_pipeline" | "development" | "convenience";
  requirements: Partial<ModelCapability["capability"]>;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  taskBudgetUsd: number;
  actualCostUsd: number;
  maxAttempts: number;
  routeMode: "strict" | "balanced" | "emergency";
  resultClass: "official" | "fallback" | "exploratory" | "recovery";
};

type BudgetReservation = {
  id: string;
  providerBudgetId: string;
  taskId: string;
  amountUsd: number;
  status: "AVAILABLE" | "RESERVED" | "CONSUMED" | "RELEASED";
  expiresAt: number;
};
```

P0 与可预见的 P1 任务在入队时必须先做预算预留。其他任务只能使用未预留的 `available_usd`。预留在任务取消、超时、失败上限达成或执行结算后释放或转为 consumed。

## 4. 任务优先级与不可降级约束

| 级别 | 定义 | 典型任务 | 自动降级 | 结果身份 |
|---|---|---|---|---|
| P0 | 研究关键 | 正式实验、最终统计、论文核心数据、最终验证、实验恢复 | 禁止静默降级 | official 或人工审查 |
| P1 | 实验关键 | 训练管线、数据预处理、测试、复杂 bug | 可以，但必须记录 | official 或 fallback |
| P2 | 开发重要 | 普通开发、文档、重构、日志分析 | 可以 | exploratory |
| P3 | 便利 | 格式化、摘要、简单脚本、文件整理 | 优先低成本模型 | exploratory |

P0 的候选模型先经过硬约束：能力阈值、可靠性阈值、工具/视觉要求、`reserved_budget >= estimated_task_cost`、并发预算可用。任何一个条件不满足，任务必须排队或进入人工研究救援通道。

## 5. 动态保护仓、燃烧率与并发保护

静态百分比仅为初始政策。动态保护仓由研究阶段、P0/P1 待执行任务预留、共享窗口剩余时间、消耗速度和稀缺性共同决定。

```text
dynamic_reserve_usd =
  committed_p0_p1_reservations
  + phase_floor
  + burn_risk_buffer
  + scarcity_buffer
```

燃烧率同时维护 15 分钟、1 小时、5 小时与 24 小时窗口。耗尽预测默认取各窗口中最保守的有效速率：

```text
worst_case_burn_rate = max(burn_15m, burn_1h, burn_5h)
forecast_exhaustion = now + available_usd / worst_case_burn_rate
```

当预测在重置前跌破动态保护线时，即使当前余额状态仍为 GREEN，也进入 `DRAIN_PROTECTION`，停止接收 P2/P3 的高成本调用。

并发预算以已运行与已预留任务的成本之和为准：

```text
in_flight_commitment = Σ(estimated_cost of running attempts) + Σ(active reservations)
admit task only if available_usd − in_flight_commitment ≥ task.estimated_cost
```

每个模型同时有 `maxConcurrency`，防止多个 worker 在同一秒对共享池发起高成本请求。

## 6. 路由器

V2 的模型选择先满足硬约束，后做排序：

```text
Task requirements
  → Capability hard filter
  → Provider budget and reservation check
  → Concurrency check
  → Availability / failure-domain filter
  → Rank by quality × reliability × continuity ÷ cost pressure
  → Select model and create attempt ledger
```

一个可解释的排序函数可以写为：

```text
score =
  capability_fit
  × quality_requirement_fit
  × reliability
  × availability
  × continuity_factor
  ÷ (cost_pressure × scarcity_penalty)
```

其中 `cost_pressure` 受共享池余额与任务预算影响，`scarcity_penalty` 在非关键任务消耗稀缺模型时显著增大。它不是一个把“剩余比例”线性加权的普通分数表。

## 7. 降级阶梯与故障域

模型切换不是第一动作。每个任务尝试应按以下顺序降低资源需求：

```text
缩小上下文 → 减少输出长度 → 拆分任务 → 减少工具调用 → 降低 Agent steps
→ 选择成本更低但能力合格的模型 → 排队等待窗口重置 → 人工接管
```

错误分类为：`QUOTA`、`RATE_LIMIT`、`TIMEOUT`、`PROVIDER_ERROR`、`MODEL_UNAVAILABLE`、`CONTEXT_OVERFLOW`、`TOOL_ERROR`、`UNKNOWN`。不同故障使用不同处置：

| 故障 | 首要动作 | 允许切换模型 |
|---|---|---:|
| QUOTA | 预留/共享池重新计算，迁移或排队 | 是 |
| RATE_LIMIT | 遵守 Retry-After、退避并降低并发 | 必要时 |
| TIMEOUT | 对无副作用任务重试 | 后续允许 |
| PROVIDER_ERROR | 熔断 provider，冷却后半开探测 | 是 |
| MODEL_UNAVAILABLE | 重新拉取模型目录 | 是 |
| CONTEXT_OVERFLOW | 压缩或拆分上下文 | 仅能力适配时 |
| TOOL_ERROR | 查询幂等状态并恢复 | 不直接重跑 |

## 8. Execution Guard 与实验账本

每一次 attempt 需要保存不可变的 provenance：

```json
{
  "requested_model": "deepseek-v4-pro",
  "actual_model": "minimax-m3",
  "fallback": true,
  "fallback_reason": "quota_low",
  "quota_state": "DRAIN_PROTECTION",
  "estimated_cost_usd": 0.18,
  "actual_cost_usd": 0.21,
  "task_priority": "P1",
  "experiment_id": "exp-042",
  "run_id": "run-017",
  "result_class": "fallback",
  "route_version": "qars-v2"
}
```

正式、fallback、探索与恢复运行必须在数据库、UI、导出和最终报告中明确分开。任何发生模型切换的 P0 结果都不得自动写入 official run。

## 9. V2 最终架构

```text
Research Task
  → Task Classifier (P0–P3, requirements, task budget)
  → Budget Manager (5h/week/month, reservation, burn forecast)
  → Model Router (capability, quality, reliability, cost, scarcity)
  → Execution Guard (concurrency, retry, backoff, circuit breaker)
  → Experiment Ledger (model, cost, fallback, provenance)
  → Result / Queue

OpenCode Go API Pool ────────────────┘
ChatGPT Plus Human / Research Rescue ─ manual P0 review only
```

## 10. 实施顺序

第一阶段应先建立共享预算、任务预算、预留、账本和模型目录；第二阶段增加能力矩阵、动态燃烧率、并发预算与故障域；第三阶段才接入真实 provider 数据、执行队列和告警。这样先保证结果纯度和预算正确性，再提高自动化程度。

## References

[1]: https://opencode.ai/docs/go/ "OpenCode Go：共享美元限额、模型目录、典型请求模式与 API 端点"

[2]: https://help.openai.com/en/articles/6950777-what-is-chatgpt-plus "OpenAI：ChatGPT Plus 与 API 独立计费、动态用量限制"

[3]: https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs/ "OpenAI：组织级 Costs API"
