# QuotaPilot 架构评审要点

用户的评价认可“提前避让、分层使用、保护仓和窗口耗尽预测”的方向，但指出现有策略尚未严格形式化为科研计算资源调度系统。评审给出的总体分数是：策略思路 9/10，额度模型 7/10，调度算法 7.5/10，科研可靠性 7/10，直接工程落地 6.5/10。

## 必须更正的架构假设

OpenCode Go 应被建模为 5 小时、周、月的共享美元使用价值窗口。模型的官方典型请求数只能作为相对成本和估算容量参考，不能被视为独立的模型余额。调度核心应是 `provider_budget + request_cost + scarcity_factor`，其中每次调用需要记录模型、输入 token、输出 token、缓存 token、预估成本和实际成本。

ChatGPT Plus 应从自动 API provider pool 中拆出，定位为人工或外部研究救援通道。它负责关键研究判断、最终分析、论文结论审查和人工介入，而不作为普通 API fallback。正式队列与自动化工作应建立在可审计的 API provider 和独立 API 凭据上。

## 需要新增的调度机制

任务须定义为 P0 研究关键、P1 实验关键、P2 开发重要、P3 便利四级。每项任务应包含预算、预估成本、实际成本、剩余预算和最大尝试次数。对未来 P0/P1 任务应建立额度预留实体，状态为 AVAILABLE、RESERVED、CONSUMED、RELEASED，从共享预算中锁定可预估成本。

保护仓应随研究阶段变化，并参考待执行 P0/P1 任务、消耗速度、重置时间和共享预算，而非使用固定的模型独立百分比。燃烧率至少应计算 15 分钟、1 小时、5 小时和 24 小时窗口，并通过最坏窗口速度预测耗尽时间，必要时进入 DRAIN_PROTECTION。

调度还需要并发预算，保证所有正在执行或已保留任务的预估成本之和不会超过共享窗口的可用额度。模型选择前必须先做能力硬约束筛选（代码、推理、长上下文、视觉、工具调用、中文、研究、Agent、速度和可靠性），再按质量、可用性、连续性、成本压力和稀缺性选择候选模型。P0 任务不得仅依赖最高分，而要满足能力、可靠性和可预留成本门槛。

## 科研可靠性与执行保护

每次运行必须写入实验账本：请求模型、实际模型、是否 fallback、fallback 原因、quota state、预估/实际成本、优先级、experiment_id 和 run_id。主结果、fallback、探索和恢复运行要有明确身份，防止不同执行路径的结果无标签混入论文结论。

降级阶梯应先缩小任务需求：降低上下文、输出长度、任务范围、工具调用和 Agent 步数；换模型只是后续动作，随后才是排队与人工接管。故障域必须区分 QUOTA、RATE_LIMIT、TIMEOUT、PROVIDER_ERROR、MODEL_UNAVAILABLE、CONTEXT_OVERFLOW、TOOL_ERROR 与 UNKNOWN，并分别处理重试、退避、上下文压缩、切换或熔断。

## 目标系统形态

最终架构应包含 Task Classifier、Budget Manager、Model Router、A/B/C 模型池、Execution Guard、Experiment Ledger 和 Result/Queue；ChatGPT Plus 作为独立的 Human / Research Rescue Lane。下一份正式文档应定义状态机、数据结构、评分公式、Reservation、Fallback 和实验追踪，使该系统成为科研计算资源调度器，而不是单纯的额度看板。
