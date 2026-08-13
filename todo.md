# QuotaPilot 全栈升级任务清单

## 连接与安全

- [ ] 采用定时同步与数据库队列运行方式：按策略窗口同步额度、处理待执行任务并生成预算告警，不部署常驻 worker。
- [x] 在未配置外部凭据期间完成 V2 本地/数据库功能，并将实时 OpenCode Go 与 OpenAI API 同步显式标记为“待配置”，禁止误触发外部调用。
- [ ] 确认 OpenCode Go 与 ChatGPT/ OpenAI 可用的官方额度查询接口、认证方式、响应字段和重置时间字段。
- [ ] 通过项目 Secrets 配置 OPENCODE_GO_API_KEY 和 OPENAI_ADMIN_API_KEY，并在服务器端执行连接测试；不要求或存储 ChatGPT Plus 登录信息。
- [ ] 通过项目 Secrets 配置供应商凭据，不在前端代码、日志或数据库中保存明文 API key。
- [ ] 为供应商连接建立加密存储、连接测试、撤销/轮换入口和最后同步状态。
- [ ] 明确实时额度数据的刷新频率、缓存策略、超时、限流和 provider 级错误回退。

## 数据与历史趋势

- [ ] 建立 provider、model、quota_snapshot、usage_event、import_batch 和 budget_alert 数据模型。
- [ ] 实现 CSV/JSON 文件上传、格式校验、字段映射、重复导入检测和错误行反馈。
- [ ] 实现历史消耗趋势、窗口消耗、保护仓变化、模型对比和导入批次回滚/标记能力。
- [ ] 为所有历史数据记录来源、导入时间、时间窗口、模型名、单位和是否为估算值。

## 调度与预算告警

- [x] 将 route decision 操作直接嵌入任务队列表每一行，覆盖全部可处理任务而非仅 recent summary。
- [ ] 为任务队列逐条 migrate、queue、hold、manual handoff 操作补充服务端与前端测试，验证状态反馈和持久化结果。
- [x] 为 MIGRATE 增加候选模型选择界面，并将用户选择的模型与处理状态持久化到 task 和 route decision。
- [x] 区分并实现继续排队、保持暂停和人工交接确认三种操作流及状态文案。
- [x] 在任务队列的每条可处理任务上提供 route decision 操作入口与处理后反馈。
- [x] 在任务队列展示 admissionDecision 与 route decision 摘要、原因和建议动作。
- [x] 为 MIGRATE、QUEUE、HOLD 增加迁移候选、继续排队、保持暂停与人工交接确认操作，并将处理状态回写 route_decision 和任务。
- [ ] 为 route decision 的任务页、账本页和交接操作流补充前端/服务端测试。
- [x] 新增持久化 route_decision 记录，关联任务与 attempt，保存准入决策、触发阈值、原因、建议动作和人工接管要求。
- [x] 在任务与账本界面展示 route_decision 历史，并提供 migrate、queue、hold 与 manual handoff 的明确操作流。
- [ ] 为 MIGRATE、QUEUE、HOLD 的路由决策持久化和前端展示补充测试。
- [x] 将 MIGRATE、QUEUE、HOLD 准入决策落入任务状态和路由决策记录，并在控制台展示后续操作与人工接管要求。
- [ ] 为提前迁移阈值增加端到端测试，覆盖低于保护仓、DRAIN_PROTECTION、ORANGE 与 RED 场景的迁移、排队和暂停行为。
- [ ] 实现真实任务/请求执行账本流程：每次调用关联 task_attempt，记录输入/输出/缓存 token、预估/实际成本和执行结果。
- [ ] 补全额度预留生命周期：任务成功时转 CONSUMED，失败、取消或过期时转 RELEASED，并覆盖测试。
- [x] 将 resultClass 下沉至 attempt/ledger 层，并由服务端阻止 fallback 或 recovery attempt 被写为 official 结果。
- [x] 增加可执行的提前迁移阈值：基于 available、dynamic reserve 和 burn rate 决定迁移、排队或人工接管。
- [x] 将 OpenCode Go 的调度基础从“模型独立额度”改为 5 小时、周、月共享美元预算，并对每次请求记录输入、输出、缓存 token、预估成本和实际成本。
- [x] 以模型成本和稀缺性系数而非独立模型余额定义调度惩罚，避免将官方典型请求数误当作模型专属额度。
- [x] 修正模型目录的来源与版本；将 ChatGPT Plus 从普通 API provider pool 中拆出，定位为人工/外部救援通道。
- [ ] 使用 OpenCode Go `/zen/go/v1/models` 的动态目录建立规范模型注册表，并以 workspace policy 补充能力矩阵与稀缺性系数，避免静态模型名单漂移。
- [x] 定义 P0 研究关键、P1 实验关键、P2 开发重要、P3 便利四级任务优先级及对应降级限制。
- [ ] 为任务建立 task_budget、estimated_cost、actual_cost、remaining_budget、max_attempts 和累计成本封顶策略。
- [x] 建立额度预留实体，将正式实验的可预估成本从共享预算中提前锁定，并支持 AVAILABLE、RESERVED、CONSUMED、RELEASED 生命周期。
- [x] 将静态百分比保护仓升级为随研究阶段、待执行 P0/P1 任务、消耗速度和下一次重置时间变化的动态保护仓。
- [x] 增加 15 分钟、1 小时、5 小时、24 小时多窗口 burn rate、最坏情形 forecast exhaustion time 和 DRAIN_PROTECTION 状态。
- [ ] 增加 provider、model 与任务三级并发预算，确保运行中与已预留请求的预估成本不会击穿共享窗口余额。
- [ ] 为每次执行写入实验账本，记录 requested_model、actual_model、fallback、fallback_reason、quota_state、预估/实际成本、优先级、experiment_id 和 run_id。
- [x] 将正式、fallback、探索和恢复运行分层存储与展示，防止非原定模型的结果无标签混入正式实验结果。
- [x] 建立模型能力矩阵，覆盖 Code、Reasoning、LongContext、Vision、ToolUse、Chinese、Research、Agent、Speed 与 Reliability。
- [ ] 将模型路由评分调整为能力硬约束优先，再综合 quality、reliability、availability、continuity 与 cost pressure；为 P0 增加能力、可靠性和可预留成本门槛。
- [ ] 实现任务降级阶梯：缩小上下文、减少输出、拆分任务、减少工具调用、降低 Agent 步数、换模型、排队和人工接管。
- [ ] 建立 QUOTA、RATE_LIMIT、TIMEOUT、PROVIDER_ERROR、MODEL_UNAVAILABLE、CONTEXT_OVERFLOW、TOOL_ERROR、UNKNOWN 故障域及对应重试、退避、压缩、熔断和切换策略。
- [ ] 将额度感知路由器从前端模拟逻辑迁移为服务端可审计策略。
- [x] 实现 5 小时、周、月窗口的预算预测、保护仓、burn rate 和提前迁移阈值。
- [ ] 实现预算告警：进入 YELLOW/ORANGE/RED、预测重置前耗尽、连接失效和队列阻塞。
- [x] 建立站内通知与告警确认状态，避免同一事件重复告警。

## 真实任务队列

- [ ] 建立 task、task_attempt、route_decision、worker_lock 和 task_event 数据模型。
- [ ] 实现任务创建、优先级、路由、重试、熔断、暂停、恢复、取消和幂等键。
- [ ] 记录 requested_model、actual_model、fallback_reason、quota_state、prompt/input hash 和 git commit。
- [ ] 区分 strict、balanced、emergency 模式，禁止 provisional 结果静默进入正式实验。

## 团队协作与权限

- [x] 启用用户认证和团队/工作区模型。
- [x] 定义 owner、admin、researcher、reviewer、viewer 角色及资源级权限。
- [ ] 实现成员邀请、角色变更、移除、审计日志和敏感操作二次确认。
- [ ] 为连接凭据、预算策略、任务队列和正式实验结果设置最小权限。

## 验证与交付

- [ ] 为实时连接、导入、告警、队列和权限关键路径补充测试。
- [ ] 进行桌面端、移动端、错误态、空状态和加载态视觉验证。
- [ ] 建立部署前 checkpoint，并在交付说明中标明仍需用户配置的 Secrets、provider 权限和数据保留策略。
