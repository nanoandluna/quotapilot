/* Mineral Signal: a calm, paper-toned research infrastructure console. Keep risk legible, protect the reserve, and make every routing decision explainable. */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Bell,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  Command,
  FlaskConical,
  Gauge,
  Layers3,
  LockKeyhole,
  Menu,
  MoreHorizontal,
  PanelLeft,
  Play,
  Plus,
  RefreshCw,
  Route,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Timer,
  TrendingDown,
  Workflow,
  X,
  Zap,
} from "lucide-react";

type Pool = "A" | "B" | "C";
type State = "GREEN" | "YELLOW" | "ORANGE" | "RED";

type Model = {
  id: string;
  label: string;
  provider: string;
  pool: Pool;
  used: number;
  capacity: number;
  reserved: number;
  state: State;
  role: string;
  fit: string;
  trend: number;
  color: string;
};

const initialModels: Model[] = [
  { id: "flash", label: "DeepSeek V4 Flash", provider: "OpenCode Go", pool: "A", used: 23, capacity: 100, reserved: 15, state: "GREEN", role: "吞吐池", fit: "预处理 / 日志 / 低风险脚本", trend: -8, color: "#2D8F83" },
  { id: "luna", label: "GPT 5.6 Luna", provider: "OpenCode Go", pool: "A", used: 38, capacity: 100, reserved: 15, state: "GREEN", role: "快速通用", fit: "短代码 / 文档 / 轻量分析", trend: -4, color: "#5A7D9A" },
  { id: "kimi", label: "Kimi K2.7 Code", provider: "OpenCode Go", pool: "B", used: 47, capacity: 100, reserved: 25, state: "YELLOW", role: "代码主力", fit: "测试 / 局部重构 / 实验脚本", trend: -13, color: "#C28A33" },
  { id: "deepseek", label: "DeepSeek V4 Pro", provider: "OpenCode Go", pool: "B", used: 63, capacity: 100, reserved: 25, state: "ORANGE", role: "复杂实验", fit: "长上下文 / 多文件 / 训练管线", trend: -21, color: "#C65A3A" },
  { id: "grok", label: "Grok 4.5", provider: "OpenCode Go", pool: "C", used: 34, capacity: 100, reserved: 30, state: "GREEN", role: "稀缺 Agent", fit: "多步骤工具链 / 交互原型", trend: -6, color: "#766B8F" },
  { id: "glm", label: "GLM-5.2", provider: "OpenCode Go", pool: "C", used: 54, capacity: 100, reserved: 30, state: "ORANGE", role: "中文第二意见", fit: "中文技术审查 / 复杂说明", trend: -17, color: "#A06548" },
];

const taskOptions = [
  { id: "preprocess", label: "数据预处理与日志整理", risk: "T0", model: "flash", need: "高容量池", estimate: "低" },
  { id: "code", label: "新增实验函数与测试", risk: "T1", model: "kimi", need: "代码主力池", estimate: "中" },
  { id: "pipeline", label: "多文件训练管线修改", risk: "T2", model: "deepseek", need: "复杂实验池", estimate: "高" },
  { id: "agent", label: "多步骤 Agent 原型", risk: "T2", model: "grok", need: "稀缺 Agent 池", estimate: "高" },
  { id: "review", label: "论文统计结论审查", risk: "T3", model: "plus", need: "研究判断池", estimate: "极高" },
];

const stateMeta: Record<State, { label: string; className: string; dot: string }> = {
  GREEN: { label: "NOW", className: "status-green", dot: "bg-[#2D8F83]" },
  YELLOW: { label: "WATCH", className: "status-yellow", dot: "bg-[#C28A33]" },
  ORANGE: { label: "MIGRATE", className: "status-orange", dot: "bg-[#C65A3A]" },
  RED: { label: "HOLD", className: "status-red", dot: "bg-[#9B3F39]" },
};

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function LogoMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "logo-wrap logo-wrap-compact" : "logo-wrap"} aria-label="QuotaPilot">
      <img src="/manus-storage/quotapilot-mark_506a6e34.png" alt="" className="logo-mark" />
      {!compact && <span className="wordmark">QUOTAPILOT</span>}
    </div>
  );
}

function PoolBadge({ pool }: { pool: Pool }) {
  return <span className={`pool-badge pool-${pool}`}>POOL {pool}</span>;
}

function ModelRow({ model, onSelect }: { model: Model; onSelect: (model: Model) => void }) {
  const state = stateMeta[model.state];
  return (
    <button className="model-row" onClick={() => onSelect(model)} aria-label={`查看 ${model.label}`}>
      <div className="model-row-main">
        <span className="model-swatch" style={{ backgroundColor: model.color }} />
        <div className="model-name-block">
          <div className="model-title-line">
            <span className="model-label">{model.label}</span>
            <PoolBadge pool={model.pool} />
          </div>
          <span className="model-fit">{model.fit}</span>
        </div>
      </div>
      <div className="model-usage">
        <div className="usage-line">
          <span>{model.used}% used</span>
          <span className={model.trend < -15 ? "text-oxide" : "text-muted-strong"}>{model.trend}% / 24h</span>
        </div>
        <div className="usage-track">
          <span className="usage-reserve" style={{ left: `${100 - model.reserved}%` }} />
          <span className="usage-fill" style={{ width: `${model.used}%`, backgroundColor: model.color }} />
        </div>
      </div>
      <div className={`status-pill ${state.className}`}>
        <span className={`status-dot ${state.dot}`} />
        {state.label}
      </div>
      <ChevronDown className="row-chevron" size={15} />
    </button>
  );
}

export default function Home() {
  const [activeView, setActiveView] = useState("overview");
  const [models, setModels] = useState(initialModels);
  const [selectedModel, setSelectedModel] = useState<Model | null>(null);
  const [selectedTask, setSelectedTask] = useState("pipeline");
  const [priority, setPriority] = useState("P1");
  const [mode, setMode] = useState("balanced");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [reserveLock, setReserveLock] = useState(true);
  const [simulationCount, setSimulationCount] = useState(8);

  const task = taskOptions.find((item) => item.id === selectedTask) ?? taskOptions[2];
  const recommendedModel = models.find((item) => item.id === task.model);
  const totalUsed = Math.round(models.reduce((sum, model) => sum + model.used, 0) / models.length);
  const protectedPercent = Math.round(models.reduce((sum, model) => sum + model.reserved, 0) / models.length);
  const orangeCount = models.filter((model) => model.state === "ORANGE" || model.state === "RED").length;
  const runway = useMemo(() => (task.risk === "T3" ? "4h 18m" : task.risk === "T2" ? "6h 42m" : "11h 08m"), [task.risk]);

  const navItems = [
    { id: "overview", label: "连续性总览", icon: Gauge, count: "06" },
    { id: "pool", label: "模型额度池", icon: Layers3, count: "18" },
    { id: "route", label: "Route Lab", icon: Route, count: "LAB" },
    { id: "policy", label: "调度策略", icon: SlidersHorizontal, count: "03" },
  ];

  const handleSimulate = () => {
    const next = Math.min(99, simulationCount + 1);
    setSimulationCount(next);
    setModels((current) => current.map((model) => (model.id === task.model && task.model !== "plus" ? { ...model, used: Math.min(96, model.used + 2), trend: model.trend - 1 } : model)));
    toast.success("Simulation queued", { description: `${task.label} 已进入本地模拟队列，不会调用真实 API。` });
  };

  const handleReset = () => {
    setModels(initialModels);
    setSimulationCount(8);
    toast("Simulation reset", { description: "已恢复到演示数据起点。" });
  };

  return (
    <div className="dashboard-shell">
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-topline">
          <LogoMark />
          <button className="icon-button mobile-close" onClick={() => setSidebarOpen(false)} aria-label="关闭侧栏"><X size={18} /></button>
        </div>

        <button className="workspace-switcher" onClick={() => toast("Workspace switcher", { description: "多项目工作区将在后续版本开放。" })}>
          <span className="workspace-avatar">N</span>
          <span className="workspace-copy"><strong>Neural Systems</strong><small>个人研究空间</small></span>
          <ChevronDown size={15} />
        </button>

        <div className="nav-section-label">CONTROL ROOM</div>
        <nav className="side-nav" aria-label="主导航">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={`nav-item ${activeView === item.id ? "nav-item-active" : ""}`} onClick={() => { setActiveView(item.id); setSidebarOpen(false); }}>
                <Icon size={17} strokeWidth={1.8} />
                <span>{item.label}</span>
                <em>{item.count}</em>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-divider" />
        <div className="nav-section-label">RESEARCH WINDOWS</div>
        <div className="window-list">
          <button className="window-item window-item-active"><span className="window-dot dot-copper" /><span><b>Go · Shared pool</b><small>5h / week / month</small></span><ArrowUpRight size={14} /></button>
          <button className="window-item" onClick={() => toast("Plus connection", { description: "ChatGPT Plus 模型以人工审查池的身份显示。" })}><span className="window-dot dot-slate" /><span><b>Plus · Reasoning</b><small>Medium / High</small></span><ArrowUpRight size={14} /></button>
        </div>

        <div className="sidebar-foot">
          <div className="mini-status"><span className="live-dot" /><span>Simulation mode</span><span className="mini-status-key">⌘ K</span></div>
          <button className="profile-row" onClick={() => toast("Profile", { description: "研究员账户设置将在后续版本开放。" })}><span className="profile-avatar">LY</span><span><b>Lin Y.</b><small>Graduate Researcher</small></span><MoreHorizontal size={17} /></button>
        </div>
      </aside>

      {sidebarOpen && <button className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-label="关闭侧栏" />}

      <main className="main-canvas">
        <header className="topbar">
          <button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="打开侧栏"><Menu size={20} /></button>
          <div className="breadcrumb"><span>NEURAL SYSTEMS</span><span className="slash">/</span><b>{navItems.find((item) => item.id === activeView)?.label.toUpperCase()}</b></div>
          <div className="topbar-actions">
            <span className="last-sync"><span className="sync-dot" /> Synced 2m ago</span>
            <button className="icon-button" aria-label="帮助" onClick={() => toast("QuotaPilot", { description: "一个用于研究模型额度连续性的前端模拟器。" })}><CircleHelp size={17} /></button>
            <button className="icon-button" aria-label="通知" onClick={() => toast("No new alerts", { description: "当前没有新的系统警报。" })}><Bell size={17} /></button>
            <button className="avatar-button" aria-label="打开账户菜单">LY</button>
          </div>
        </header>

        <div className="content-frame">
          {activeView === "overview" && (
            <>
              <section className="hero-block">
                <div className="hero-copy">
                  <div className="eyebrow"><span className="eyebrow-rule" /> CONTINUITY DASHBOARD <span className="sim-chip">SIMULATION</span></div>
                  <h1>Keep the next run<br /><span>moving, on purpose.</span></h1>
                  <p>QuotaPilot 把额度、保护仓和消耗速度压缩成一个可执行的研究连续性信号。</p>
                  <div className="hero-decision-line"><span className="decision-square" /> 2 pools need a route decision <ArrowUpRight size={13} /></div>
                </div>
                <div className="hero-aside">
                  <div className="hero-aside-label">NEXT EXPERIMENT RUNWAY</div>
                  <div className="runway-number">{runway}</div>
                  <div className="runway-caption"><span className="status-dot bg-[#2D8F83]" /> {orangeCount > 1 ? "迁移建议已触发" : "所有主力池可用"}<ArrowUpRight size={14} /></div>
                  <div className="reserve-chip"><LockKeyhole size={12} /> RESERVE 23% LOCKED</div>
                </div>
              </section>

              <section className="continuity-rail" aria-label="连续性轨道">
                <div className="rail-head"><div><span className="section-kicker">RUNWAY SIGNAL</span><strong>5h window / shared value pool</strong></div><div className="rail-value-wrap"><span className="reserve-chip"><LockKeyhole size={11} /> protected below 23%</span><span className="rail-value">$8.42 <small>of $12</small></span></div></div>
                <div className="rail-track"><span className="rail-marker marker-start" /><span className="rail-progress" style={{ width: "70%" }} /><span className="rail-marker marker-now" style={{ left: "70%" }} /><span className="rail-reserve" style={{ left: "75%", width: "17%" }} /><span className="rail-marker marker-reset" style={{ left: "92%" }} /></div>
                <div className="rail-labels"><span>09:00 START</span><span className="rail-now">NOW · 14:32</span><span>18:00 RESET / RESERVE 23% LOCKED</span></div>
              </section>

              <section className="metric-grid">
                <div className="metric-card metric-card-accent"><div className="metric-label"><span>ACTIVE WINDOW</span><Timer size={15} /></div><div className="metric-value">$3.58</div><div className="metric-foot"><span className="trend-up"><ArrowUpRight size={13} /> 29.8% remaining</span><span>5h</span></div></div>
                <div className="metric-card metric-card-reserve"><div className="metric-label"><span>PROTECTED RESERVE</span><LockKeyhole size={15} /></div><div className="metric-value">{protectedPercent}<small>%</small></div><div className="reserve-mini-track"><span style={{ width: `${protectedPercent}%` }} /></div><div className="metric-foot"><span className="trend-neutral"><ShieldCheck size={13} /> lock enabled</span><span>policy</span></div></div>
                <div className="metric-card"><div className="metric-label"><span>MODEL POOLS AT RISK</span><AlertTriangle size={15} /></div><div className="metric-value">{orangeCount}<small>/ 6</small></div><div className="metric-foot"><span className="trend-down"><TrendingDown size={13} /> 1 migrated today</span><span>status</span></div></div>
                <div className="metric-card metric-card-dark"><div className="metric-label"><span>QUEUE SIMULATIONS</span><Activity size={15} /></div><div className="metric-value">{String(simulationCount).padStart(2, "0")}</div><div className="metric-foot"><span className="trend-light"><CheckCircle2 size={13} /> local only</span><span>runs</span></div></div>
              </section>

              <section className="dashboard-grid">
                <div className="panel model-pool-panel">
                  <div className="panel-heading"><div><div className="section-kicker">MODEL POOL / 06 ACTIVE</div><h2>Capacity by model</h2></div><div className="panel-actions"><button className="filter-button" onClick={() => toast("Filter", { description: "模型筛选已在 Pool 视图中展开。" })}>All pools <ChevronDown size={14} /></button><button className="icon-button small" onClick={handleReset} aria-label="重置模拟"><RefreshCw size={15} /></button></div></div>
                  <div className="pool-summary"><span><i className="legend-dot green" /> stable</span><span><i className="legend-dot yellow" /> observe</span><span><i className="legend-dot orange" /> migrate</span><span className="pool-summary-note"><LockKeyhole size={11} /> RESERVE LINE {protectedPercent}% / LOCKED</span></div>
                  <div className="model-list">{models.map((model) => <ModelRow key={model.id} model={model} onSelect={setSelectedModel} />)}</div>
                  <button className="panel-footer-action" onClick={() => setActiveView("pool")}>View full model pool <ArrowUpRight size={15} /></button>
                </div>

                <div className="panel route-panel">
                  <div className="panel-heading"><div><div className="section-kicker">NEXT BEST ROUTE</div><h2>Route recommendation</h2></div><span className="route-status-stamp">{recommendedModel?.state === "ORANGE" ? "MIGRATE" : "NOW"}</span></div>
                  <div className="route-input-block"><label htmlFor="task-select">TASK TYPE</label><div className="select-wrap"><select id="task-select" value={selectedTask} onChange={(event) => setSelectedTask(event.target.value)}>{taskOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select><ChevronDown size={15} /></div></div>
                  <div className="priority-row"><div><span className="route-label">PRIORITY</span><strong>{priority}</strong></div><div className="priority-segments">{["P0", "P1", "P2", "P3"].map((item) => <button key={item} className={priority === item ? "priority-active" : ""} onClick={() => setPriority(item)}>{item}</button>)}</div></div>
                  <div className="route-card"><div className="route-card-top"><div className="route-model-icon" style={{ backgroundColor: recommendedModel?.color ?? "#C65A3A" }}>{task.model === "plus" ? <Sparkles size={17} /> : <Zap size={17} />}</div><div><span className="route-label">RECOMMENDED MODEL</span><h3>{task.model === "plus" ? "ChatGPT Plus · Sol High" : recommendedModel?.label}</h3></div><span className="fit-score">92 <small>FIT</small></span></div><div className="route-reason"><Check size={14} /><span>{task.risk} · {task.need} · 预计成本 {task.estimate}</span></div><div className="route-meter"><div className="meter-label"><span>continuity fit</span><b>92%</b></div><div className="meter-track"><span style={{ width: "92%" }} /></div></div></div>
                  <div className="route-alternates"><span className="route-label">FALLBACK CHAIN</span><div className="fallback-row"><span>01</span><b>{task.risk === "T0" ? "GPT 5.6 Luna" : task.risk === "T3" ? "Sol Medium" : "Kimi K2.7 Code"}</b><ArrowDownRight size={14} /><b>{task.risk === "T0" ? "MiMo V2.5" : "MiniMax M3"}</b></div></div>
                  <button className="primary-action" onClick={handleSimulate}><Play size={15} fill="currentColor" /> Run route simulation <span>⌘ ↵</span></button>
                  <p className="simulation-note"><CircleHelp size={13} /> Simulation only — no real provider calls are made.</p>
                </div>
              </section>
            </>
          )}

          {activeView === "pool" && (
            <section className="view-section"><div className="view-intro"><div><div className="eyebrow"><span className="eyebrow-rule" /> MODEL POOL</div><h1>Every model has a role.<br /><span>Every reserve has a reason.</span></h1><p>按容量、风险和保护仓查看当前模拟中的模型资产。点击一行查看路由证据。</p></div><button className="secondary-action" onClick={handleReset}><RefreshCw size={15} /> Reset simulation</button></div><div className="pool-detail-grid">{models.map((model) => <div key={model.id} className="pool-detail-card" onClick={() => setSelectedModel(model)}><div className="pool-detail-header"><span className="model-swatch" style={{ backgroundColor: model.color }} /><div><h3>{model.label}</h3><span>{model.provider} · {model.role}</span></div><PoolBadge pool={model.pool} /></div><div className="big-percent">{model.used}<small>% used</small></div><div className="large-track"><span style={{ width: `${model.used}%`, backgroundColor: model.color }} /><i style={{ left: `${100 - model.reserved}%` }} /></div><div className="pool-detail-meta"><span><b>{model.reserved}%</b> reserve</span><span className={stateMeta[model.state].className}>{stateMeta[model.state].label}</span></div><p>{model.fit}</p></div>)}</div></section>
          )}

          {activeView === "route" && (
            <section className="view-section route-lab-view"><div className="view-intro"><div><div className="eyebrow"><span className="eyebrow-rule" /> ROUTE LAB</div><h1>Make the next call<br /><span>before the last one.</span></h1><p>调整任务参数，观察路由、保护仓和预计 runway 如何变化。所有操作均为本地模拟。</p></div><div className="lab-run-chip"><span className="live-dot" /> local simulation</div></div><div className="route-lab-grid"><div className="panel lab-controls"><div className="section-kicker">TASK CONTEXT</div><h2>Define the workload</h2><div className="field-group"><label>任务类型</label><div className="task-option-grid">{taskOptions.map((option) => <button key={option.id} className={selectedTask === option.id ? "task-option active" : "task-option"} onClick={() => setSelectedTask(option.id)}><span>{option.risk}</span><b>{option.label}</b><small>{option.need}</small></button>)}</div></div><div className="field-group"><div className="field-label-row"><label>优先级</label><strong>{priority}</strong></div><input className="range-input" type="range" min="0" max="3" value={["P0", "P1", "P2", "P3"].indexOf(priority)} onChange={(event) => setPriority(["P0", "P1", "P2", "P3"][Number(event.target.value)])} /><div className="range-labels"><span>P0 critical</span><span>P3 exploratory</span></div></div><div className="field-group"><div className="field-label-row"><label>调度模式</label><strong>{mode}</strong></div><div className="mode-switcher">{["strict", "balanced", "emergency"].map((item) => <button key={item} className={mode === item ? "mode-active" : ""} onClick={() => setMode(item)}>{item}</button>)}</div></div></div><div className="panel lab-result"><div className="result-top"><div><div className="section-kicker">ROUTER OUTPUT</div><h2>Best path right now</h2></div><span className="route-status-stamp">SIMULATED</span></div><div className="result-hero"><span className="result-index">01</span><div><span className="route-label">PRIMARY ROUTE</span><h3>{task.model === "plus" ? "ChatGPT Plus · Sol High" : recommendedModel?.label}</h3><p>{task.need} · {task.risk} risk · {priority} priority</p></div><div className="result-score">92<small>fit</small></div></div><div className="decision-stack"><div className="decision-row"><span className="decision-icon decision-good"><CheckCircle2 size={16} /></span><span>保护仓满足任务预算</span><b>PASS</b></div><div className="decision-row"><span className="decision-icon decision-warn"><AlertTriangle size={16} /></span><span>预计在窗口重置前持续 {runway}</span><b>WATCH</b></div><div className="decision-row"><span className="decision-icon decision-good"><ShieldCheck size={16} /></span><span>后备链不会触碰稀缺池保护线</span><b>PASS</b></div></div><button className="primary-action" onClick={handleSimulate}><Play size={15} fill="currentColor" /> Run route simulation</button></div></div></section>
          )}

          {activeView === "policy" && (
            <section className="view-section"><div className="view-intro"><div><div className="eyebrow"><span className="eyebrow-rule" /> POLICY</div><h1>Protect the runway.<br /><span>Spend with intent.</span></h1><p>策略参数只影响前端模拟器，不会改变真实供应商额度。</p></div><button className={`reserve-toggle ${reserveLock ? "toggle-on" : ""}`} onClick={() => setReserveLock((value) => !value)}><span className="toggle-knob" /> reserve lock {reserveLock ? "on" : "off"}</button></div><div className="policy-grid"><div className="panel policy-panel"><div className="section-kicker">OPERATING MODE</div><h2>Choose a safety posture</h2><div className="policy-modes">{[{ id: "strict", title: "Strict", desc: "正式实验与论文主结果。额度不足就排队。", icon: LockKeyhole }, { id: "balanced", title: "Balanced", desc: "默认模式。低风险任务自动迁移。", icon: SlidersHorizontal }, { id: "emergency", title: "Emergency", desc: "保持探索性流水线，但结果标记 provisional。", icon: Zap }].map((item) => { const Icon = item.icon; return <button key={item.id} className={`policy-mode ${mode === item.id ? "policy-mode-active" : ""}`} onClick={() => setMode(item.id)}><Icon size={18} /><span><b>{item.title}</b><small>{item.desc}</small></span><span className="radio-dot" /></button>; })}</div></div><div className="panel policy-panel"><div className="section-kicker">RESERVE ALLOCATION</div><h2>Protected capacity</h2><div className="reserve-visual"><img src="/manus-storage/reserve-core-diagram_2c108796.png" alt="" /><div><strong>{protectedPercent}%</strong><span>average reserve</span></div></div><div className="reserve-bars"><div><span>Pool A</span><b>15%</b><i><em style={{ width: "15%" }} /></i></div><div><span>Pool B</span><b>25%</b><i><em style={{ width: "25%" }} /></i></div><div><span>Pool C</span><b>30%</b><i><em style={{ width: "30%" }} /></i></div></div><button className="panel-footer-action" onClick={() => toast("Policy saved", { description: "本地策略已保存到当前会话。" })}>Save local policy <Check size={15} /></button></div></div></section>
          )}

          <section className="bottom-strip"><div className="queue-heading"><div><div className="section-kicker">RECENT QUEUE</div><h2>Research tasks in motion</h2></div><span className="queue-count">{simulationCount} simulations</span></div><div className="queue-list"><div className="queue-row"><span className="queue-icon queue-icon-green"><CheckCircle2 size={16} /></span><div><b>Feature extraction notebook</b><small>DeepSeek V4 Flash · completed 02m ago</small></div><span className="queue-state state-done">DONE</span></div><div className="queue-row"><span className="queue-icon queue-icon-orange"><Workflow size={16} /></span><div><b>Training pipeline refactor</b><small>DeepSeek V4 Pro → Kimi K2.7 Code · migrating</small></div><span className="queue-state state-migrate">MIGRATE</span></div><div className="queue-row"><span className="queue-icon queue-icon-yellow"><Clock3 size={16} /></span><div><b>Reviewer response synthesis</b><small>ChatGPT Plus · scheduled after reset window</small></div><span className="queue-state state-hold">HOLD</span></div></div><button className="panel-footer-action" onClick={() => toast("Queue", { description: "任务队列详情将在后续版本开放。" })}>Open task queue <ArrowUpRight size={15} /></button></section>
        </div>
      </main>

      {selectedModel && <div className="detail-overlay" onClick={() => setSelectedModel(null)}><div className="detail-drawer" onClick={(event) => event.stopPropagation()}><div className="drawer-head"><div><span className="section-kicker">MODEL DETAIL</span><h2>{selectedModel.label}</h2></div><button className="icon-button" onClick={() => setSelectedModel(null)} aria-label="关闭详情"><X size={18} /></button></div><div className="drawer-state"><span className="model-swatch" style={{ backgroundColor: selectedModel.color }} /><PoolBadge pool={selectedModel.pool} /><span className={`status-pill ${stateMeta[selectedModel.state].className}`}><span className={`status-dot ${stateMeta[selectedModel.state].dot}`} /> {stateMeta[selectedModel.state].label}</span></div><div className="drawer-metric"><span>USED CAPACITY</span><strong>{selectedModel.used}%</strong><div className="large-track"><span style={{ width: `${selectedModel.used}%`, backgroundColor: selectedModel.color }} /><i style={{ left: `${100 - selectedModel.reserved}%` }} /></div></div><div className="drawer-grid"><div><span>ROLE</span><b>{selectedModel.role}</b></div><div><span>RESERVE</span><b>{selectedModel.reserved}% locked</b></div><div><span>24H BURN</span><b>{Math.abs(selectedModel.trend)}% down</b></div><div><span>ROUTE FIT</span><b>{selectedModel.fit}</b></div></div><div className="drawer-note"><ShieldCheck size={17} /><p>{selectedModel.state === "ORANGE" ? "建议迁移普通任务，保护剩余容量给复杂实验。" : "当前容量足够承接分配给它的默认任务。"}</p></div><button className="primary-action" onClick={() => { setSelectedModel(null); setActiveView("route"); }}>Open Route Lab <ArrowUpRight size={15} /></button></div></div>}
    </div>
  );
}
