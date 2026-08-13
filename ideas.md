# QuotaPilot 设计脑暴与执行契约

## 三个方向

### Theme Name: Observatory Ledger
**Very Brief Intro:** 把研究模型额度做成一座安静、精密的控制室，用深色纸张、细线网格和琥珀色警示强调“预测比补救更重要”。它像研究基础设施，而不是普通 SaaS 仪表盘。

**Probability:** 0.03

### Theme Name: Mineral Signal
**Very Brief Intro:** 使用石墨、骨白、氧化铜和荧光黄，像一张来自实验室墙面的工程图。重点是高可读性、确定性状态和克制的工业质感，让额度风险一眼可见。

**Probability:** 0.07

### Theme Name: Tidal Compute
**Very Brief Intro:** 用蓝灰海图、潮汐线和柔和的蓝绿色强调额度窗口的周期性。界面更有数据产品气质，强调“流量、余量、重置”三种节奏。

**Probability:** 0.015

## 选定方向：Mineral Signal

### Design Movement
新工业主义（New Industrialism）与 Swiss International Typographic Style 的结合：清晰的栅格、强烈的数字层级、可追踪的标注和少量材料感纹理，服务于研究基础设施管理。

### Core Principles
1. **先显示风险，再显示细节。** 顶部信息必须首先回答“会不会中断”和“下一步该怎么做”。
2. **状态有颜色，数字有证据。** 颜色只用于状态和决策，不做装饰性渐变；每个关键数字旁边都说明窗口、样本或来源。
3. **保护仓是产品主角。** 预留额度不是隐藏设置，而是整个界面的核心调度资产。
4. **不做虚假的全自动。** 路由建议可以模拟和解释，但必须清楚标注“演算”“可用”“已保留”和“需人工确认”。

### Color Philosophy
底色使用温暖的骨白与浅灰，模拟实验室纸张和仪器面板；主文字使用深石墨，保证长时间阅读；品牌色使用“氧化铜橙”（#C65A3A），表达资源燃烧、阈值和行动，而不是泛用的蓝色 CTA。状态色严格采用：青绿色表示稳定、麦黄色表示观察、橙色表示迁移、深红表示保护。避免紫色渐变和泛化的企业蓝，让产品有自己的研究基础设施身份。

### Layout Paradigm
采用“左侧控制轨 + 右侧工作台”的非中心化布局。左侧是固定的研究项目与额度窗口切换，右侧顶部是一个横向的“连续性指示带”，下面是一个大面积的模型池矩阵，右栏放“下一步路由”与“保护仓”。底部再用任务队列和窗口消耗带收束页面。移动端将左侧控制轨折叠成顶部抽屉，而不是简单缩放桌面网格。

### Signature Elements
1. **Continuity rail：** 顶部用一条带刻度的连续性轨道展示“预计可持续时间”，把余额从静态数字转成时间判断。
2. **Mineral chips：** 每个模型卡片使用小型色块和等级标记，像样品标签一样标注 Pool A/B/C、窗口和保护仓。
3. **Route stamp：** 每个路由推荐都带有明确的“NOW / HOLD / MIGRATE / REVIEW”印章式状态，强化决策感。

### Interaction Philosophy
交互要像一个可靠的实验台：点击模型卡片查看证据，调整滑杆预览保护仓变化，切换任务类型立即看到推荐路由。避免无意义的复杂动效；所有关键动作都要有即时的数值反馈和可撤销的模拟状态。路由按钮不直接执行真实 API，只运行前端模拟并明确显示“simulation”。

### Animation
页面首屏使用 30–50ms 的错峰淡入，模型卡片从下方 4px 轻微进入；进度条只动画 transform，不动画布局尺寸；状态迁移使用 180ms ease-out；顶部连续性轨道的游标缓慢呼吸，但在 prefers-reduced-motion 下静止。按钮按下时缩放到 0.97，所有提示在 200ms 内出现。仪表盘不使用持续闪烁，只有 RED 状态用一次性的轻微 pulse 提示。

### Typography System
展示字体使用 **Space Grotesk**，用于页面标题、核心数值和模型名称；正文使用 **IBM Plex Sans**，用于解释、标签和辅助说明；代码/额度窗口使用 **IBM Plex Mono**。标题采用紧凑的 700/800 字重，正文使用 400/500，数字使用 tabular-nums。避免 Inter，以确保品牌有更明确的工程研究气质。

### Brand Essence
**Positioning:** 面向研究生与实验团队的额度连续性控制台，在模型额度耗尽之前给出可解释的调度动作。

**Personality:** 冷静、精确、负责。

### Brand Voice
标题要短、直接、带有工程判断；CTA 要说明动作和后果；微文案要说明数据的窗口和可信度。避免“欢迎使用”“开始探索”等泛化措辞。

示例语句：

> “Keep the hard model in reserve.”

> “Your next experiment has 6h 42m of runway.”

### Wordmark & Logo
标志是一个由三个不等宽矩形组成的“矿芯 / 额度柱”符号：左侧短柱代表当前燃烧，中间高柱代表主力池，右侧带缺口的柱代表保护仓。符号使用氧化铜橙与石墨双色，不在 logo 内写品牌名；页眉以符号 + `QUOTAPILOT` 全大写字标呈现。

### Signature Brand Color
**Oxide Copper — #C65A3A**。它不是警告红，也不是普通橙，而是“资源正在被使用、需要做出迁移决策”的专属颜色。

## Page Information Architecture

### Primary View: Continuity Dashboard
首屏包含项目上下文、连续性 rail、三个总览指标（当前可用、保护仓、预计中断风险）、模型池矩阵、路由推荐卡和任务队列。所有初始数据使用可解释的模拟数据，并在 UI 中标注“simulation mode”。

### Secondary View: Model Pool
展示模型分层、官方估算容量、模拟已用、保护仓、当前状态、推荐任务和切换理由。支持按 Pool A/B/C 和状态筛选。

### Secondary View: Route Lab
用户选择任务类型、优先级、工具/视觉需求、预计持续时间和质量要求，界面实时计算推荐模型、备选模型、保护仓影响和预计 runway。点击“Run simulation”只更新本地模拟状态。

### Secondary View: Policy
展示 strict / balanced / emergency 三种调度模式，允许编辑保护仓比例、状态阈值和窗口预算，并提供重置按钮。

## Style Decisions

- 使用浅色工业纸张背景，不采用深色霓虹默认方案。
- 使用固定左侧控制轨和不对称工作台，避免居中堆叠式 SaaS 仪表盘。
- 所有额度值使用 monospace 与明确窗口标签，所有百分比都显示状态解释。
- 当前网站是前端模拟器，不声称连接真实供应商 API；接入真实数据需要后续后端或 API 配置。
- 首屏以连续性状态、保护仓条件和下一条路由为第一信息层，品牌 headline 只做辅助，不做营销主视觉。
- 保护仓是主视觉资产：rail、metric、model bars 和 route card 均必须暴露 reserve line、reserve impact 或 reserve lock。
- `Oxide Copper #C65A3A` 只用于 burn、migration、threshold breach 和 primary simulation action；稳定状态使用 teal，观察状态使用 wheat，保留状态使用 red。
- `NOW / WATCH / MIGRATE / HOLD` 作为统一的 Route Stamp 词汇，Pool chips 与 quota bars 使用同一套工程标注语法。
