# OpenCode Go Source Notes

官方 Go 文档在 2026-08-13 更新，明确指出 Go 使用共享美元窗口而不是按模型分配独立额度：五小时、周、月额度分别为 12、30、60 美元。文档同时说明，可通过 `https://opencode.ai/zen/go/v1/models` 取得完整可用模型及其元数据；该同步动作必须继续等待用户明确提供凭据并解除当前离线冻结后才可执行。[1]

该文档列出了当前 Go 的模型清单、每百万 token 价格、缓存读写价格与端点，但页面本身没有逐模型发布可直接写死的最大上下文数。因此，本项目不应从非官方猜测值回填 `maxContextTokens`；在实时同步启用前应保持保守拒绝策略，只有可核验模型元数据或工作区经审查的策略值才能通过显式上下文准入。[1]

OpenCode Zen 文档同样提供模型元数据端点模式 `https://opencode.ai/zen/v1/models`，并将模型/Provider 目录描述为随时可能变化的受维护清单。这支持将当前静态工作区策略视为离线占位，而非实时目录的替代品。[2]

## References

[1]: https://opencode.ai/docs/go/ "OpenCode Go documentation"
[2]: https://opencode.ai/docs/zen/ "OpenCode Zen documentation"
