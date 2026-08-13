# QuotaPilot

**QuotaPilot** 是一个面向研究工作流的额度感知型 LLM **Quota Policy / Decision Control Plane（额度策略与决策控制平面）**。它把模型成本、共享预算、动态保护仓、任务优先级、路由决策和实验账本放在同一处，帮助研究团队在实验启动前看清连续性风险，避免高价值实验因额度耗尽而被动中断。

> 当前版本是**决策、准入与审计层**，并不是直接拦截 provider 调用的 enforcement engine，也不是会自行提交任务、自动切换生产请求或代替研究者执行实验的 auto-scheduler。任何模型调用、迁移和结果采纳仍需由你的研究工作流或人工操作实际执行。

## 当前能力

QuotaPilot 提供以下本地优先能力。

| 模块 | 作用 |
|---|---|
| 共享预算 | 用 5 小时、周和月度窗口管理 provider 级预算，而非虚构模型独立余额。 |
| 动态保护仓 | 结合研究阶段、P0/P1 预留和多窗口 burn rate 计算连续性保护额度。 |
| 历史导入 | 支持导入 CSV/JSON 用量记录，形成成本趋势和可追溯用量事件。 |
| Route Lab | 模拟额度不足、限流、超时和上下文溢出时的任务缩减、迁移、排队与人工交接。 |
| 任务与账本 | 为任务、attempt、预算预留和结果类别记录可审计的执行轨迹。 |
| 路由决策 | 保存准入阈值、预算快照、推荐动作、迁移目标和人工交接记录。 |
| 团队权限 | 支持 owner、admin、researcher、reviewer 和 viewer 五类工作区角色。 |

## 明确边界

QuotaPilot 对任务给出可解释的 `ADMIT`、`RESERVE`、`QUEUE`、`MIGRATE` 或 `HOLD` 建议，并将其写入审计账本。它当前**不会**代表用户发送 OpenCode/OpenAI 请求、绕过 provider 限流、恢复 provider 额度，或将 fallback 输出自动合并到正式实验。它也不会在未配置且未明确授权的情况下连接外部 provider。

这一区分使控制台可以先用于离线研究治理：研究者仍保留对模型调用、实验结果分类和发表证据链的最终控制权；未来若接入 provider adapter，则应将执行层作为独立、可审计且可撤销的能力建设，而不是把策略建议误写成已完成的执行保证。

## 运行方式

项目使用 React、Express、tRPC、Drizzle 和 MySQL/TiDB。它依赖 Manus OAuth 和数据库运行环境；使用 Manus WebDev 时，这些基础设施已预配置。

```bash
pnpm install
pnpm dev
```

在本地执行类型检查、测试和生产构建：

```bash
pnpm check
pnpm test
pnpm build
```

## 离线模式与可选连接

默认情况下，QuotaPilot 运行在**离线本地导入模式**：它不会主动调用 OpenCode、OpenAI 或 ChatGPT Plus。用户可以通过 CSV/JSON 导入历史消耗，并使用手工账本结算任务。

当你具备相应权限后，可在服务器端配置 `OPENCODE_GO_API_KEY` 与 `OPENAI_ADMIN_API_KEY` 来启用 provider 级同步。请勿把任何 API Key、数据库连接字符串、用户导入文件或运行日志提交到仓库。ChatGPT Plus 与 OpenAI API 用量彼此独立；Plus 应作为人工研究救援通道，而非服务器自动化 provider。

## 数据与科研结果

QuotaPilot 将 `official`、`fallback`、`exploratory` 和 `recovery` 结果类别分开记录。模型切换后产生的 P0 结果不会自动混入正式实验结果。请在论文、实验报告或基准比较中保留模型、路由决策、成本、输入版本和结果类别的完整记录。

## 许可证

本项目以 [MIT License](LICENSE) 发布。
