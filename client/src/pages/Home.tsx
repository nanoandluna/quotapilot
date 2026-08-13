import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bell,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  CloudCog,
  Database,
  FileDown,
  FileUp,
  FlaskConical,
  Gauge,
  History,
  Layers3,
  LockKeyhole,
  Menu,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Route,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Users,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";

type View = "overview" | "pool" | "history" | "route" | "tasks" | "ledger" | "team" | "policy";
type Priority = "P0" | "P1" | "P2" | "P3";
type RateScenario = "none" | "rate_limit" | "quota_low" | "timeout" | "context_overflow";

const STATE_COPY: Record<string, { label: string; tone: string }> = {
  GREEN: { label: "READY", tone: "status-green" },
  YELLOW: { label: "WATCH", tone: "status-yellow" },
  ORANGE: { label: "PROTECT", tone: "status-orange" },
  DRAIN_PROTECTION: { label: "DRAIN", tone: "status-orange" },
  RED: { label: "HOLD", tone: "status-red" },
};

const TASK_PRESETS: Array<{
  id: string;
  label: string;
  taskClass: "formal_experiment" | "experiment_pipeline" | "development" | "convenience";
  priority: Priority;
  resultClass: "official" | "fallback" | "exploratory" | "recovery";
  requirements: Record<string, number | boolean>;
  estimatedCost: number;
}> = [
  { id: "formal", label: "正式实验 / 最终验证", taskClass: "formal_experiment", priority: "P0", resultClass: "official", requirements: { code: 8, reasoning: 9, reliability: 9, research: 8 }, estimatedCost: 0.8 },
  { id: "pipeline", label: "训练管线 / 多文件代码", taskClass: "experiment_pipeline", priority: "P1", resultClass: "official", requirements: { code: 9, longContext: 8, toolUse: 7 }, estimatedCost: 0.32 },
  { id: "analysis", label: "日志分析 / 数据预处理", taskClass: "development", priority: "P2", resultClass: "exploratory", requirements: { code: 6, speed: 8 }, estimatedCost: 0.08 },
  { id: "convenience", label: "摘要 / 格式化 / 简单脚本", taskClass: "convenience", priority: "P3", resultClass: "exploratory", requirements: { speed: 7, chinese: 6 }, estimatedCost: 0.02 },
];

function formatUsd(value: unknown, digits = 2) {
  const parsed = Number(value ?? 0);
  return `$${Number.isFinite(parsed) ? parsed.toFixed(digits) : "0.00"}`;
}

function formatDate(value: Date | string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatReset(value: Date | string | null | undefined) {
  if (!value) return "未设置";
  const ms = new Date(value).getTime() - Date.now();
  if (ms <= 0) return "待刷新";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
}

function LogoMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "logo-wrap logo-wrap-compact" : "logo-wrap"} aria-label="QuotaPilot">
      <img src="/manus-storage/quotapilot-mark_506a6e34.png" alt="" className="logo-mark" />
      {!compact && <span className="wordmark">QUOTAPILOT</span>}
    </div>
  );
}

function StatePill({ state }: { state?: string | null }) {
  const meta = STATE_COPY[state ?? "GREEN"] ?? STATE_COPY.GREEN;
  return <span className={`status-pill ${meta.tone}`}><span className="status-dot" />{meta.label}</span>;
}

function EmptyState({ icon: Icon, title, body, action }: { icon: typeof Database; title: string; body: string; action?: React.ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={20} /></span><div><strong>{title}</strong><p>{body}</p></div>{action}</div>;
}

export default function Home() {
  const { user, loading, isAuthenticated, logout } = useAuth();
  const [activeView, setActiveView] = useState<View>("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [selectedPreset, setSelectedPreset] = useState("pipeline");
  const [priority, setPriority] = useState<Priority>("P1");
  const [mode, setMode] = useState<"strict" | "balanced" | "emergency">("balanced");
  const [rateScenario, setRateScenario] = useState<RateScenario>("none");
  const [importOpen, setImportOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [taskTitle, setTaskTitle] = useState("训练管线代码审查");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"researcher" | "reviewer" | "viewer" | "admin">("researcher");
  const [candidateModelByDecision, setCandidateModelByDecision] = useState<Record<number, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const bootstrap = trpc.quota.bootstrap.useMutation({
    onSuccess: result => setWorkspaceId(result.workspaceId),
    onError: error => toast.error("工作区初始化失败", { description: error.message }),
  });
  const activeWorkspaceId = workspaceId ?? bootstrap.data?.workspaceId ?? null;
  const dashboard = trpc.quota.dashboard.useQuery({ workspaceId: activeWorkspaceId ?? 0 }, { enabled: Boolean(activeWorkspaceId), refetchInterval: 60_000 });
  const utils = trpc.useUtils();
  const importUsage = trpc.quota.importUsage.useMutation({
    onSuccess: result => {
      toast.success("历史消耗已导入", { description: `已写入 ${result.accepted} 条用量事件。` });
      setImportOpen(false);
      if (activeWorkspaceId) utils.quota.dashboard.invalidate({ workspaceId: activeWorkspaceId });
    },
    onError: error => toast.error("导入未完成", { description: error.message }),
  });
  const createTask = trpc.quota.createTask.useMutation({
    onSuccess: result => {
      const decisionCopy = {
        ADMIT: "任务已通过预算准入，等待执行队列处理。",
        RESERVE: "该任务已从共享窗口锁定预算。",
        MIGRATE: "任务已暂停：请在 Route Lab 选择能力仍合格的低成本模型后再恢复。",
        QUEUE: "任务已排队：动态保护仓优先服务 P0/P1，窗口恢复后再准入。",
        HOLD: "任务已暂停：共享窗口不足，等待重置或人工调整预算。",
      } as const;
      toast.success(result.reserved ? "额度已预留" : `路由决策：${result.admission}`, { description: decisionCopy[result.admission] });
      setTaskOpen(false);
      if (activeWorkspaceId) utils.quota.dashboard.invalidate({ workspaceId: activeWorkspaceId });
    },
    onError: error => toast.error("任务未入队", { description: error.message }),
  });
  const recordAttempt = trpc.quota.recordAttempt.useMutation({
    onSuccess: result => {
      toast.success("执行账本已结算", { description: `任务已标记为 ${result.taskStatus}；预留状态为 ${result.reservationStatus}。` });
      if (activeWorkspaceId) utils.quota.dashboard.invalidate({ workspaceId: activeWorkspaceId });
    },
    onError: error => toast.error("账本结算未完成", { description: error.message }),
  });
  const acknowledgeAlert = trpc.quota.acknowledgeAlert.useMutation({
    onSuccess: () => {
      toast.success("告警已确认");
      if (activeWorkspaceId) utils.quota.dashboard.invalidate({ workspaceId: activeWorkspaceId });
    },
    onError: error => toast.error("无法确认告警", { description: error.message }),
  });
  const actOnRouteDecision = trpc.quota.actOnRouteDecision.useMutation({
    onSuccess: result => {
      toast.success("路由决策已处理", { description: `任务 #${result.taskId} 当前状态为 ${result.status}。` });
      if (activeWorkspaceId) utils.quota.dashboard.invalidate({ workspaceId: activeWorkspaceId });
    },
    onError: error => toast.error("路由决策未处理", { description: error.message }),
  });
  const inviteMember = trpc.quota.inviteMember.useMutation({
    onSuccess: result => {
      toast.success("邀请记录已建立", { description: `有效至 ${formatDate(result.expiresAt)}；目前需要手动发送邀请链接或邮件。` });
      setInviteOpen(false);
      setInviteEmail("");
    },
    onError: error => toast.error("无法建立邀请", { description: error.message }),
  });

  useEffect(() => {
    if (user && !activeWorkspaceId && !bootstrap.isPending) bootstrap.mutate();
  }, [user, activeWorkspaceId, bootstrap.isPending]);

  const data = dashboard.data;
  const fiveHourBudget = data?.budgets.find(item => item.window === "five_hour");
  const openCodeConnection = data?.connections.find(item => item.provider === "opencode_go");
  const availableUsd = fiveHourBudget ? Math.max(0, Number(fiveHourBudget.limitUsd) - Number(fiveHourBudget.consumedUsd) - Number(fiveHourBudget.reservedUsd)) : 0;
  const reserveUsd = Number(fiveHourBudget?.dynamicReserveUsd ?? 0);
  const activeReservations = data?.reservations ?? [];
  const activeAlerts = data?.alerts.filter(alert => !alert.acknowledgedAt) ?? [];
  const latestDecisionByTask = new Map((data?.decisions ?? []).map(decision => [decision.taskId, decision]));
  const selected = TASK_PRESETS.find(item => item.id === selectedPreset) ?? TASK_PRESETS[1];
  const routeModel = useMemo(() => {
    const models = data?.models ?? [];
    const requirements = selected.requirements;
    const candidates = models.filter(model => Object.entries(requirements).every(([key, value]) => typeof value !== "number" || Number((model.capability as Record<string, number>)[key] ?? 0) >= value));
    return [...(candidates.length ? candidates : models)].sort((a, b) => {
      const aScore = Number((a.capability as Record<string, number>).reliability ?? 0) * 2 + Number((a.capability as Record<string, number>).code ?? 0) - Number(a.scarcityFactor) * 3;
      const bScore = Number((b.capability as Record<string, number>).reliability ?? 0) * 2 + Number((b.capability as Record<string, number>).code ?? 0) - Number(b.scarcityFactor) * 3;
      return bScore - aScore;
    })[0];
  }, [data?.models, selected]);
  const routeSteps = useMemo(() => {
    if (rateScenario === "rate_limit") return ["429 / RATE_LIMIT 已识别", "遵守 Retry-After 并把并发上限下调", "缩小输出和 Agent steps；任务保持原模型队列", "若冷却后仍失败，记录 fallback 候选"]; 
    if (rateScenario === "quota_low") return ["共享窗口进入 DRAIN_PROTECTION", "检查 P0/P1 预留，冻结 P2/P3 高成本调用", "先压缩上下文与任务范围", "仅在能力仍满足时迁移到较低成本模型"]; 
    if (rateScenario === "timeout") return ["TIMEOUT 已识别", "确认工具调用幂等状态", "无副作用任务采用指数退避重试", "持续超时才触发 provider 熔断与替代路由"]; 
    if (rateScenario === "context_overflow") return ["CONTEXT_OVERFLOW 已识别", "提取相关文件和函数级上下文", "压缩引用，限制输出长度", "重新评估模型上下文能力后再尝试"]; 
    return ["能力硬约束筛选模型", "核对任务预算与共享窗口可用金额", "核对 P0/P1 预留和模型并发上限", "创建可审计 attempt，不调用真实 provider"]; 
  }, [rateScenario]);

  const navItems: Array<{ id: View; label: string; icon: typeof Gauge }> = [
    { id: "overview", label: "连续性总览", icon: Gauge },
    { id: "pool", label: "模型能力池", icon: Layers3 },
    { id: "history", label: "消耗历史", icon: History },
    { id: "route", label: "Route Lab", icon: Route },
    { id: "tasks", label: "任务队列", icon: Workflow },
    { id: "ledger", label: "实验账本", icon: FileDown },
    { id: "team", label: "团队权限", icon: Users },
    { id: "policy", label: "调度策略", icon: SlidersHorizontal },
  ];

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !activeWorkspaceId) return;
    if (!/\.(csv|json)$/i.test(file.name)) return toast.error("文件格式不支持", { description: "请选择 CSV 或 JSON 文件。" });
    if (file.size > 4_000_000) return toast.error("文件过大", { description: "当前版本限制 4 MB，以保证导入能在请求时限内完成。" });
    const content = await file.text();
    importUsage.mutate({ workspaceId: activeWorkspaceId, filename: file.name, mimeType: file.name.endsWith(".json") ? "application/json" : "text/csv", content });
    event.target.value = "";
  };

  const submitTask = () => {
    if (!activeWorkspaceId) return;
    createTask.mutate({
      workspaceId: activeWorkspaceId,
      title: taskTitle,
      priority,
      taskClass: selected.taskClass,
      routeMode: mode,
      resultClass: priority === "P0" ? "official" : selected.resultClass,
      estimatedCostUsd: selected.estimatedCost,
      taskBudgetUsd: Math.max(selected.estimatedCost * 2, 0.1),
      requestedModelId: routeModel?.modelId,
      requirements: selected.requirements,
      experimentId: priority === "P0" ? "formal-run" : undefined,
    });
  };
  const settleAttempt = (attempt: NonNullable<typeof data>["attempts"][number]) => {
    if (!activeWorkspaceId || !data) return;
    const task = data.tasks.find(item => item.id === attempt.taskId);
    const isFallback = attempt.actualModelId !== attempt.requestedModelId;
    recordAttempt.mutate({
      workspaceId: activeWorkspaceId,
      taskId: attempt.taskId,
      attemptId: attempt.id,
      actualModelId: attempt.actualModelId || attempt.requestedModelId || "manual-ledger-entry",
      actualCostUsd: Number(attempt.estimatedCostUsd),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      status: "completed",
      fallback: isFallback,
      fallbackReason: isFallback ? "manual" : undefined,
      resultClass: isFallback ? "fallback" : task?.resultClass === "official" ? "official" : task?.resultClass || "exploratory",
    });
  };

  return (
    <div className="dashboard-shell qv2-shell">
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-topline"><LogoMark /><button className="icon-button mobile-close" onClick={() => setSidebarOpen(false)} aria-label="关闭侧栏"><X size={18} /></button></div>
        <div className="workspace-switcher workspace-static"><span className="workspace-avatar">Q</span><span className="workspace-copy"><strong>{data?.workspace?.name ?? "QuotaPilot V2"}</strong><small>{data?.workspace ? "共享预算 · 实验账本" : "等待研究工作区"}</small></span><ChevronDown size={15} /></div>
        <div className="nav-section-label">CONTROL ROOM</div>
        <nav className="side-nav" aria-label="QuotaPilot V2 导航">
          {navItems.map(item => { const Icon = item.icon; return <button key={item.id} className={`nav-item ${activeView === item.id ? "nav-item-active" : ""}`} onClick={() => { setActiveView(item.id); setSidebarOpen(false); }}><Icon size={17} strokeWidth={1.8} /><span>{item.label}</span>{item.id === "tasks" && <em>{data?.tasks.filter(task => ["queued", "reserved", "running"].includes(task.status)).length ?? "—"}</em>}</button>; })}
        </nav>
        <div className="sidebar-divider" />
        <div className="nav-section-label">RESOURCE DOMAINS</div>
        <div className="window-list">
          <button className="window-item window-item-active" onClick={() => setActiveView("pool")}><span className="window-dot dot-copper" /><span><b>OpenCode Go · Shared</b><small>5h / week / month</small></span><ArrowRight size={14} /></button>
          <button className="window-item" onClick={() => setActiveView("policy")}><span className="window-dot dot-slate" /><span><b>ChatGPT Plus · Rescue</b><small>人工审查，不自动路由</small></span><ArrowRight size={14} /></button>
        </div>
        <div className="sidebar-foot">
          <div className="mini-status"><span className={openCodeConnection?.secretState === "configured" ? "live-dot" : "pending-dot"} /><span>{openCodeConnection?.secretState === "configured" ? "Scheduled sync ready" : "Sync pending keys"}</span></div>
          {isAuthenticated ? <button className="profile-row" onClick={logout}><span className="profile-avatar">{user?.name?.slice(0, 1).toUpperCase() || "R"}</span><span><b>{user?.name || "Researcher"}</b><small>已登录 · 退出</small></span><MoreHorizontal size={17} /></button> : <button className="profile-row" onClick={startLogin}><span className="profile-avatar">→</span><span><b>连接研究工作区</b><small>登录后启用数据库</small></span><MoreHorizontal size={17} /></button>}
        </div>
      </aside>
      {sidebarOpen && <button className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-label="关闭侧栏" />}

      <main className="main-canvas">
        <header className="topbar"><button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="打开侧栏"><Menu size={20} /></button><div className="breadcrumb"><span>QUOTAPILOT V2</span><span className="slash">/</span><b>{navItems.find(item => item.id === activeView)?.label.toUpperCase()}</b></div><div className="topbar-actions"><span className="last-sync"><span className={dashboard.isFetching ? "sync-dot spinning" : "sync-dot"} /> {openCodeConnection?.lastSyncAt ? `同步于 ${formatDate(openCodeConnection.lastSyncAt)}` : "等待真实数据"}</span><button className="icon-button" aria-label="帮助" onClick={() => toast("QuotaPilot V2", { description: "共享预算优先；ChatGPT Plus 只作为人工研究救援通道。" })}><CircleHelp size={17} /></button><button className="icon-button" aria-label="通知" onClick={() => setActiveView("ledger")}><Bell size={17} /></button><button className="avatar-button" aria-label="账户">{user?.name?.slice(0, 1).toUpperCase() || "Q"}</button></div></header>

        <div className="content-frame">
          {!isAuthenticated && <section className="auth-callout"><LockKeyhole size={18} /><div><strong>{loading ? "正在检查受保护工作区" : "连接账户后启用 V2 工作区"}</strong><p>{loading ? "控制台结构已可浏览；身份确认完成后将加载你的共享预算和实验账本。" : "共享预算、上传文件、任务预留、账本和团队权限均由受保护数据库支持。"}</p></div><button className="secondary-action" onClick={startLogin}>登录并初始化</button></section>}
          {isAuthenticated && bootstrap.isPending && <section className="auth-callout"><RefreshCw className="spinning" size={18} /><div><strong>正在初始化个人研究工作区</strong><p>仅创建工作区、默认预算政策和模型能力注册表，不会调用外部 provider。</p></div></section>}

          {activeView === "overview" && <>
            <section className="hero-block qv2-hero"><div className="hero-copy"><div className="eyebrow"><span className="eyebrow-rule" /> QUOTA-AWARE RESEARCH SCHEDULER <span className="sim-chip">V2 / DB-BACKED</span></div><h1>Budget is shared.<br /><span>Continuity is protected.</span></h1><p>额度不再按模型虚构余额，而是由共享预算、任务预留、动态保护仓和结果账本共同调度。</p><div className="hero-decision-line"><span className="decision-square" /> {activeReservations.length} 个活跃预留正保护 P0/P1 任务 <ArrowRight size={13} /></div></div><div className="hero-aside"><div className="hero-aside-label">NEXT WINDOW RESET</div><div className="runway-number">{formatReset(fiveHourBudget?.resetAt)}</div><div className="runway-caption"><StatePill state={fiveHourBudget?.state} /><span>共享窗口可用 {formatUsd(availableUsd)}</span></div><div className="reserve-chip"><LockKeyhole size={12} /> DYNAMIC RESERVE {formatUsd(reserveUsd)}</div></div></section>
            <section className="continuity-rail"><div className="rail-head"><div><span className="section-kicker">SHARED BUDGET / FIVE HOUR</span><strong>{fiveHourBudget ? `${formatUsd(fiveHourBudget.consumedUsd)} 已消耗 · ${formatUsd(fiveHourBudget.limitUsd)} 上限` : "登录后加载共享窗口"}</strong></div><div className="rail-value-wrap"><StatePill state={fiveHourBudget?.state} /><span className="rail-value">{formatUsd(availableUsd)} <small>available</small></span></div></div><div className="rail-track"><span className="rail-marker marker-start" /><span className="rail-progress" style={{ width: `${fiveHourBudget ? Math.min(100, (Number(fiveHourBudget.consumedUsd) / Number(fiveHourBudget.limitUsd)) * 100) : 0}%` }} /><span className="rail-reserve" style={{ left: `${fiveHourBudget ? Math.max(0, 100 - (reserveUsd / Number(fiveHourBudget.limitUsd)) * 100) : 100}%`, width: `${fiveHourBudget ? Math.min(100, (reserveUsd / Number(fiveHourBudget.limitUsd)) * 100) : 0}%` }} /></div><div className="rail-labels"><span>WINDOW START</span><span className="rail-now">RESERVED {formatUsd(Number(fiveHourBudget?.reservedUsd ?? 0))}</span><span>RESET {formatReset(fiveHourBudget?.resetAt)}</span></div></section>
            <section className="metric-grid"><div className="metric-card metric-card-accent"><div className="metric-label"><span>AVAILABLE BUDGET</span><Gauge size={15} /></div><div className="metric-value">{formatUsd(availableUsd)}</div><div className="metric-foot"><span>共享窗口余量</span><span>5h</span></div></div><div className="metric-card metric-card-reserve"><div className="metric-label"><span>DYNAMIC RESERVE</span><LockKeyhole size={15} /></div><div className="metric-value">{formatUsd(reserveUsd)}</div><div className="reserve-mini-track"><span style={{ width: `${fiveHourBudget ? Math.min(100, (reserveUsd / Number(fiveHourBudget.limitUsd)) * 100) : 0}%` }} /></div><div className="metric-foot"><span>预留 + 阶段保护</span><span>policy</span></div></div><div className="metric-card"><div className="metric-label"><span>ACTIVE RESERVATIONS</span><ShieldCheck size={15} /></div><div className="metric-value">{String(activeReservations.length).padStart(2, "0")}</div><div className="metric-foot"><span>P0/P1 锁定额度</span><span>ledger</span></div></div><div className="metric-card metric-card-dark"><div className="metric-label"><span>PROVIDER SYNC</span><CloudCog size={15} /></div><div className="metric-value">{openCodeConnection?.secretState === "configured" ? "ON" : "OFF"}</div><div className="metric-foot"><span>{openCodeConnection?.secretState === "configured" ? "待部署 Heartbeat" : "等待 API keys"}</span><span>15m</span></div></div></section>
            {activeAlerts.length > 0 && <section className="alert-rack" aria-label="未确认预算告警">{activeAlerts.slice(0, 3).map(alert => <div key={alert.id} className={`alert-item alert-${alert.severity}`}><AlertTriangle size={16} /><div><b>{alert.title}</b><span>{alert.message}</span></div><button disabled={!activeWorkspaceId || acknowledgeAlert.isPending} onClick={() => activeWorkspaceId && acknowledgeAlert.mutate({ workspaceId: activeWorkspaceId, alertId: alert.id })}>Confirm</button></div>)}</section>}
            <section className="dashboard-grid"><div className="panel model-pool-panel"><div className="panel-heading"><div><div className="section-kicker">CAPABILITY REGISTRY</div><h2>Model role, cost & scarcity</h2></div><button className="filter-button" onClick={() => setActiveView("pool")}>View registry <ArrowRight size={14} /></button></div>{data?.models.length ? <div className="model-list">{data.models.slice(0, 6).map(model => { const pool = Number(model.scarcityFactor) <= .4 ? "A" : Number(model.scarcityFactor) <= .75 ? "B" : "C"; const cap = model.capability as Record<string, number>; return <button className="model-row" key={model.id} onClick={() => setActiveView("pool")}><div className="model-row-main"><span className="model-swatch" style={{ backgroundColor: pool === "A" ? "#2d8f83" : pool === "B" ? "#c28a33" : "#c65a3a" }} /><div className="model-name-block"><div className="model-title-line"><span className="model-label">{model.displayName}</span><span className={`pool-badge pool-${pool}`}>POOL {pool}</span></div><span className="model-fit">Code {cap.code} · Reason {cap.reasoning} · Reliability {cap.reliability}</span></div></div><div className="model-usage"><div className="usage-line"><span>scarcity {Number(model.scarcityFactor).toFixed(2)}</span><span>×{model.maxConcurrency}</span></div><div className="usage-track"><span className="usage-fill" style={{ width: `${Number(model.scarcityFactor) * 100}%`, backgroundColor: pool === "A" ? "#2d8f83" : pool === "B" ? "#c28a33" : "#c65a3a" }} /></div></div><span className="row-chevron">›</span></button>; })}</div> : <EmptyState icon={Layers3} title="尚未建立能力注册表" body="登录后将自动写入 OpenCode Go 的初始模型政策。" />}</div><div className="panel route-panel"><div className="panel-heading"><div><div className="section-kicker">NEXT BEST ROUTE</div><h2>Capability before cost</h2></div><StatePill state={fiveHourBudget?.state} /></div><div className="route-card"><div className="route-card-top"><div className="route-model-icon"><Zap size={17} /></div><div><span className="route-label">CANDIDATE MODEL</span><h3>{routeModel?.displayName ?? "等待能力注册表"}</h3></div><span className="fit-score">{routeModel ? "V2" : "—"}<small>FIT</small></span></div><div className="route-reason"><CheckCircle2 size={14} /><span>先满足能力阈值，再检查预算、预留、并发与稀缺性。</span></div><div className="route-meter"><div className="meter-label"><span>task budget</span><b>{formatUsd(selected.estimatedCost)}</b></div><div className="meter-track"><span style={{ width: `${Math.min(100, (selected.estimatedCost / Math.max(availableUsd, .01)) * 100)}%` }} /></div></div></div><button className="primary-action" onClick={() => setActiveView("route")}><Route size={15} /> Open Route Lab <span>⌘ ↵</span></button><p className="simulation-note"><CircleHelp size={13} /> 自动任务只使用 API provider；ChatGPT Plus 仅作为人工研究救援。</p></div></section>
          </>}

          {activeView === "pool" && <section className="view-section"><div className="view-intro"><div><div className="eyebrow"><span className="eyebrow-rule" /> MODEL CAPABILITY MATRIX</div><h1>Abilities are explicit.<br /><span>Scarcity is deliberate.</span></h1><p>模型目录来自数据库注册表；未来同步会以 provider 目录为源，而非以静态请求数假装独立余额。</p></div><button className="secondary-action" onClick={() => dashboard.refetch()}><RefreshCw size={15} /> Refresh registry</button></div><div className="capability-table panel"><div className="capability-head"><span>MODEL</span><span>CODE</span><span>REASON</span><span>CONTEXT</span><span>AGENT</span><span>RELIABLE</span><span>SCARCITY</span><span>CONC.</span></div>{data?.models.map(model => { const cap = model.capability as Record<string, number>; return <div className="capability-row" key={model.id}><b>{model.displayName}</b><span>{cap.code}</span><span>{cap.reasoning}</span><span>{cap.longContext}</span><span>{cap.agent}</span><span>{cap.reliability}</span><span className={Number(model.scarcityFactor) >= .75 ? "text-oxide" : "text-teal"}>{Number(model.scarcityFactor).toFixed(2)}</span><span>×{model.maxConcurrency}</span></div>; })}</div></section>}

          {activeView === "history" && <section className="view-section"><div className="view-intro"><div><div className="eyebrow"><span className="eyebrow-rule" /> USAGE HISTORY</div><h1>Every cost has<br /><span>a recorded source.</span></h1><p>上传 CSV 或 JSON 后，系统会保存原始文件引用、导入批次、事件时间、模型、token 字段和成本字段。</p></div><button className="primary-action compact-action" onClick={() => setImportOpen(true)}><FileUp size={15} /> Import CSV / JSON</button></div><section className="history-grid"><div className="panel history-chart-panel"><div className="panel-heading"><div><div className="section-kicker">30 DAY USAGE EVENTS</div><h2>Cost trail</h2></div><span className="history-total">{formatUsd(data?.events.reduce((sum, event) => sum + Number(event.actualCostUsd ?? event.estimatedCostUsd), 0) ?? 0)} total</span></div>{data?.events.length ? <div className="history-bars">{data.events.slice(0, 18).reverse().map(event => { const cost = Number(event.actualCostUsd ?? event.estimatedCostUsd); return <div className="history-bar-item" key={event.id} title={`${event.modelId} · ${formatUsd(cost, 4)}`}><i style={{ height: `${Math.max(8, Math.min(100, cost * 320))}%` }} /><span>{new Date(event.occurredAt).getDate()}</span></div>; })}</div> : <EmptyState icon={History} title="暂无历史消耗数据" body="导入 CSV/JSON 后，这里将显示模型日成本和共享窗口燃烧率。" action={<button className="secondary-action" onClick={() => setImportOpen(true)}>导入历史</button>} />}</div><div className="panel import-schema-panel"><div className="section-kicker">IMPORT CONTRACT</div><h2>CSV / JSON fields</h2><p>至少提供 `occurred_at`、`provider`、`model_id` 与 `actual_cost_usd` 或 `estimated_cost_usd`。token 字段可选，但建议保留以供成本审计。</p><code>occurred_at, provider, model_id, input_tokens, output_tokens, actual_cost_usd, external_ref</code><button className="panel-footer-action" onClick={() => setImportOpen(true)}>Open import <ArrowRight size={15} /></button></div></section></section>}

          {activeView === "route" && <section className="view-section route-lab-view"><div className="view-intro"><div><div className="eyebrow"><span className="eyebrow-rule" /> ROUTE LAB / FAILURE DOMAINS</div><h1>Degrade the task<br /><span>before the model.</span></h1><p>Route Lab 先缩小上下文、输出、工具与 Agent 步数；切换模型和排队是更后面的动作。</p></div><div className="lab-run-chip"><span className="pending-dot" /> local policy simulation</div></div><div className="route-lab-grid"><div className="panel lab-controls"><div className="section-kicker">TASK CONTEXT</div><h2>Define a budgeted workload</h2><div className="field-group"><label>任务类型</label><div className="task-option-grid">{TASK_PRESETS.map(item => <button key={item.id} className={selectedPreset === item.id ? "task-option active" : "task-option"} onClick={() => { setSelectedPreset(item.id); setPriority(item.priority); }}><span>{item.priority}</span><b>{item.label}</b><small>{formatUsd(item.estimatedCost)} estimate</small></button>)}</div></div><div className="field-group"><div className="field-label-row"><label>优先级</label><strong>{priority}</strong></div><div className="priority-segments">{(["P0", "P1", "P2", "P3"] as Priority[]).map(item => <button key={item} className={priority === item ? "priority-active" : ""} onClick={() => setPriority(item)}>{item}</button>)}</div></div><div className="field-group"><div className="field-label-row"><label>调度模式</label><strong>{mode}</strong></div><div className="mode-switcher">{(["strict", "balanced", "emergency"] as const).map(item => <button key={item} className={mode === item ? "mode-active" : ""} onClick={() => setMode(item)}>{item}</button>)}</div></div><div className="field-group"><label>限流 / 失败场景</label><select className="route-select" value={rateScenario} onChange={event => setRateScenario(event.target.value as RateScenario)}><option value="none">无故障 · 正常准入</option><option value="rate_limit">429 · RATE_LIMIT</option><option value="quota_low">QUOTA · 共享预算低</option><option value="timeout">TIMEOUT · 上游超时</option><option value="context_overflow">CONTEXT_OVERFLOW · 上下文溢出</option></select></div></div><div className="panel lab-result"><div className="result-top"><div><div className="section-kicker">ROUTER OUTPUT</div><h2>Execution guard</h2></div><span className="route-status-stamp">SIMULATED</span></div><div className="result-hero"><span className="result-index">01</span><div><span className="route-label">PRIMARY CANDIDATE</span><h3>{routeModel?.displayName ?? "No matching model"}</h3><p>{priority} · {selected.label} · {formatUsd(selected.estimatedCost)} estimate</p></div><div className="result-score">{mode === "strict" ? "P" : "V"}<small>2</small></div></div><div className="decision-stack">{routeSteps.map((step, index) => <div className="decision-row" key={step}><span className={`decision-icon ${index === 0 && rateScenario !== "none" ? "decision-warn" : "decision-good"}`}>{index + 1}</span><span>{step}</span><b>{index === routeSteps.length - 1 ? "NEXT" : "PASS"}</b></div>)}</div><button className="primary-action" onClick={() => toast.success("路由模拟已完成", { description: "已生成本地决策链；不会调用 provider，也不会消耗额度。" })}><Play size={15} fill="currentColor" /> Run scenario <span>local</span></button></div></div></section>}

          {activeView === "tasks" && <section className="view-section"><div className="view-intro"><div><div className="eyebrow"><span className="eyebrow-rule" /> REAL TASK QUEUE</div><h1>Reserve before<br /><span>the run begins.</span></h1><p>P0/P1 在进入队列时需先通过共享预算可用性检查并创建额度预留；无法预留时保持暂停，不会静默降级。</p></div><button className="primary-action compact-action" disabled={!workspaceId} onClick={() => setTaskOpen(true)}><Plus size={15} /> Create budgeted task</button></div><div className="panel task-table"><div className="task-table-head"><span>TASK</span><span>PRIORITY</span><span>MODE</span><span>BUDGET</span><span>RESULT CLASS</span><span>STATUS</span><span>ROUTE ACTION</span></div>{data?.tasks.length ? data.tasks.map(task => { const decision = latestDecisionByTask.get(task.id); return <div className="task-table-row" key={task.id}><div><b>{task.title}</b><small>{task.requestedModelId || "router candidate"} · {task.experimentId || "no experiment id"}</small></div><span className={`priority-tag priority-${task.priority}`}>{task.priority}</span><span>{task.routeMode}</span><span>{formatUsd(task.estimatedCostUsd, 3)} / {formatUsd(task.taskBudgetUsd, 2)}</span><span>{task.resultClass}</span><span className={`queue-state state-${task.status}`}>{task.status}</span>{!decision ? <span className="handoff-mark">—</span> : decision.actedAt ? <span className="handoff-mark">{decision.selectedModelId ? `→ ${decision.selectedModelId}` : "processed"}</span> : decision.admissionDecision === "MIGRATE" ? <div className="task-action-stack"><select value={candidateModelByDecision[decision.id] ?? ""} onChange={event => setCandidateModelByDecision(current => ({ ...current, [decision.id]: event.target.value }))}><option value="">选择迁移模型</option>{data.models.map(model => <option key={model.id} value={model.modelId}>{model.displayName}</option>)}</select><button className="decision-action" disabled={!activeWorkspaceId || !candidateModelByDecision[decision.id] || actOnRouteDecision.isPending} onClick={() => activeWorkspaceId && actOnRouteDecision.mutate({ workspaceId: activeWorkspaceId, decisionId: decision.id, action: "migrate", candidateModelId: candidateModelByDecision[decision.id] })}>Migrate</button></div> : decision.admissionDecision === "QUEUE" ? <button className="decision-action" disabled={!activeWorkspaceId || actOnRouteDecision.isPending} onClick={() => activeWorkspaceId && actOnRouteDecision.mutate({ workspaceId: activeWorkspaceId, decisionId: decision.id, action: "queue" })}>Queue</button> : decision.admissionDecision === "HOLD" ? <div className="task-action-stack"><button className="decision-action muted-action" disabled={!activeWorkspaceId || actOnRouteDecision.isPending} onClick={() => activeWorkspaceId && actOnRouteDecision.mutate({ workspaceId: activeWorkspaceId, decisionId: decision.id, action: "hold" })}>Hold</button><button className="decision-action" disabled={!activeWorkspaceId || actOnRouteDecision.isPending} onClick={() => activeWorkspaceId && actOnRouteDecision.mutate({ workspaceId: activeWorkspaceId, decisionId: decision.id, action: "manual_handoff" })}>Handoff</button></div> : <span className="handoff-mark">{decision.admissionDecision}</span>}</div>; }) : <EmptyState icon={Workflow} title="队列为空" body="创建 P0/P1 任务后，QuotaPilot 将锁定预算并写入首个 attempt。" action={<button className="secondary-action" disabled={!workspaceId} onClick={() => setTaskOpen(true)}>创建任务</button>} />}</div></section>}
          {activeView === "tasks" && data?.decisions.length ? <section className="panel task-decision-summary"><div className="panel-heading"><div><div className="section-kicker">TASK ROUTE SUMMARY</div><h2>Admission decisions</h2></div><span className="history-total">{data.decisions.length} recent</span></div>{data.decisions.slice(0, 5).map(decision => <div className="task-decision-line" key={decision.id}><span className={`decision-pill decision-${decision.admissionDecision.toLowerCase()}`}>{decision.admissionDecision}</span><span>{decision.requiresHumanHandoff ? "需要人工交接" : decision.recommendedAction}</span><small>{decision.reason}</small>{decision.actedAt ? <span className="handoff-mark">{decision.selectedModelId ? `已迁移 · ${decision.selectedModelId}` : "已处理"}</span> : decision.admissionDecision === "MIGRATE" ? <div className="task-action-stack"><select value={candidateModelByDecision[decision.id] ?? ""} onChange={event => setCandidateModelByDecision(current => ({ ...current, [decision.id]: event.target.value }))}><option value="">选择候选模型</option>{data.models.map(model => <option key={model.id} value={model.modelId}>{model.displayName}</option>)}</select><button className="decision-action" disabled={!activeWorkspaceId || !candidateModelByDecision[decision.id] || actOnRouteDecision.isPending} onClick={() => activeWorkspaceId && actOnRouteDecision.mutate({ workspaceId: activeWorkspaceId, decisionId: decision.id, action: "migrate", candidateModelId: candidateModelByDecision[decision.id] })}>迁移并排队</button></div> : decision.admissionDecision === "QUEUE" ? <button className="decision-action" disabled={!activeWorkspaceId || actOnRouteDecision.isPending} onClick={() => activeWorkspaceId && actOnRouteDecision.mutate({ workspaceId: activeWorkspaceId, decisionId: decision.id, action: "queue" })}>继续排队</button> : decision.admissionDecision === "HOLD" ? <div className="task-action-stack"><button className="decision-action muted-action" disabled={!activeWorkspaceId || actOnRouteDecision.isPending} onClick={() => activeWorkspaceId && actOnRouteDecision.mutate({ workspaceId: activeWorkspaceId, decisionId: decision.id, action: "hold" })}>保持暂停</button><button className="decision-action" disabled={!activeWorkspaceId || actOnRouteDecision.isPending} onClick={() => activeWorkspaceId && actOnRouteDecision.mutate({ workspaceId: activeWorkspaceId, decisionId: decision.id, action: "manual_handoff" })}>人工交接</button></div> : <span className="handoff-mark">无需操作</span>}</div>)}</section> : null}

          {activeView === "ledger" && <section className="view-section"><div className="view-intro"><div><div className="eyebrow"><span className="eyebrow-rule" /> EXPERIMENT LEDGER</div><h1>Never lose the<br /><span>route of a result.</span></h1><p>账本区分 requested model、actual model、fallback reason、成本、quota state、run id 与 result class，保护科研结果纯度。</p></div><button className="secondary-action" onClick={() => dashboard.refetch()}><RefreshCw size={15} /> Refresh ledger</button></div><div className="panel ledger-table"><div className="ledger-head"><span>ATTEMPT</span><span>REQUESTED → ACTUAL</span><span>STATE</span><span>EST. COST</span><span>RESULT CLASS</span><span>ACTION</span></div>{data?.attempts.length ? data.attempts.map(attempt => <div className="ledger-row" key={attempt.id}><span>#{attempt.taskId}.{attempt.attemptNumber}</span><span>{attempt.requestedModelId || "—"} <ArrowRight size={12} /> {attempt.actualModelId || "—"}</span><span>{attempt.status}</span><span>{formatUsd(attempt.estimatedCostUsd, 4)}</span><span className={`result-class result-${attempt.resultClass}`}>{attempt.fallback ? attempt.fallbackReason || attempt.resultClass : attempt.resultClass}</span><button className="ledger-settle" disabled={!activeWorkspaceId || recordAttempt.isPending || attempt.status === "completed" || attempt.status === "failed" || attempt.status === "cancelled"} onClick={() => settleAttempt(attempt)}>{attempt.status === "queued" || attempt.status === "running" ? "Settle" : "Closed"}</button></div>) : <EmptyState icon={FileDown} title="暂无实验 attempt" body="真实任务创建后，每一次调度、预留和 fallback 都会在此留下不可变证据。" />}</div><div className="ledger-note"><ShieldCheck size={17} /><span>“Settle” 仅记录本地/人工账本结算，不会调用 provider；模型切换的 P0 结果将保持 fallback / recovery 身份，不能自动并入 official run。</span></div><section className="panel decision-history"><div className="panel-heading"><div><div className="section-kicker">ROUTE DECISION HISTORY</div><h2>Why the queue moved</h2></div><span className="history-total">{data?.decisions.length ?? 0} records</span></div>{data?.decisions.length ? <div className="decision-history-list">{data.decisions.slice(0, 8).map(decision => <div className="decision-history-row" key={decision.id}><span className={`decision-pill decision-${decision.admissionDecision.toLowerCase()}`}>{decision.admissionDecision}</span><div><b>{decision.reason}</b><small>available {formatUsd(decision.availableUsd, 3)} · reserve {formatUsd(decision.dynamicReserveUsd, 3)} · estimate {formatUsd(decision.estimatedCostUsd, 3)}</small></div>{decision.actedAt ? <span className="handoff-mark">{decision.selectedModelId ? `已迁移 · ${decision.selectedModelId}` : "已处理"}</span> : decision.admissionDecision === "MIGRATE" ? <div className="decision-controls"><select value={candidateModelByDecision[decision.id] ?? ""} onChange={event => setCandidateModelByDecision(current => ({ ...current, [decision.id]: event.target.value }))}><option value="">选择迁移模型</option>{data.models.map(model => <option key={model.id} value={model.modelId}>{model.displayName}</option>)}</select><button className="decision-action" disabled={!activeWorkspaceId || !candidateModelByDecision[decision.id] || actOnRouteDecision.isPending} onClick={() => activeWorkspaceId && actOnRouteDecision.mutate({ workspaceId: activeWorkspaceId, decisionId: decision.id, action: "migrate", candidateModelId: candidateModelByDecision[decision.id] })}>确认迁移</button></div> : decision.admissionDecision === "QUEUE" ? <button className="decision-action" disabled={!activeWorkspaceId || actOnRouteDecision.isPending} onClick={() => activeWorkspaceId && actOnRouteDecision.mutate({ workspaceId: activeWorkspaceId, decisionId: decision.id, action: "queue" })}>继续排队</button> : decision.admissionDecision === "HOLD" ? <div className="decision-controls"><button className="decision-action muted-action" disabled={!activeWorkspaceId || actOnRouteDecision.isPending} onClick={() => activeWorkspaceId && actOnRouteDecision.mutate({ workspaceId: activeWorkspaceId, decisionId: decision.id, action: "hold" })}>保持暂停</button><button className="decision-action" disabled={!activeWorkspaceId || actOnRouteDecision.isPending} onClick={() => activeWorkspaceId && actOnRouteDecision.mutate({ workspaceId: activeWorkspaceId, decisionId: decision.id, action: "manual_handoff" })}>人工交接</button></div> : <span className="handoff-mark">无需操作</span>}</div>)}</div> : <EmptyState icon={Route} title="暂无 route decision" body="创建预算任务后，准入阈值、建议动作与人工接管要求会在此留存。" />}</section></section>}

          {activeView === "team" && <section className="view-section"><div className="view-intro"><div><div className="eyebrow"><span className="eyebrow-rule" /> TEAM & ACCESS</div><h1>Research continuity<br /><span>needs clear authority.</span></h1><p>owner、admin、researcher、reviewer 与 viewer 按最小权限管理预算策略、导入、任务和结果审查。</p></div><button className="primary-action compact-action" disabled={!workspaceId} onClick={() => setInviteOpen(true)}><Users size={15} /> Invite member</button></div><div className="team-grid"><div className="panel"><div className="section-kicker">MEMBERS</div><h2>Workspace roles</h2>{data?.workspace ? <div className="member-card"><span className="profile-avatar">{user?.name?.slice(0, 1).toUpperCase() || "R"}</span><div><b>{user?.name || "Current researcher"}</b><small>Workspace owner · full budget and policy authority</small></div><span className="role-stamp">OWNER</span></div> : <EmptyState icon={Users} title="等待账户连接" body="登录后会建立个人工作区和成员记录。" />}</div><div className="panel"><div className="section-kicker">ROLE POLICY</div><h2>Operational boundaries</h2><div className="role-list"><span><b>OWNER / ADMIN</b><small>连接、策略、成员、调度设置</small></span><span><b>RESEARCHER</b><small>导入、创建任务、申请预留</small></span><span><b>REVIEWER</b><small>审阅 ledger、确认告警</small></span><span><b>VIEWER</b><small>只读预算与结果</small></span></div></div></div></section>}

          {activeView === "policy" && <section className="view-section"><div className="view-intro"><div><div className="eyebrow"><span className="eyebrow-rule" /> V2 POLICY</div><h1>Shared value pool.<br /><span>Dynamic protection.</span></h1><p>动态保护仓=研究阶段底线 + P0/P1 承诺 + burn-risk buffer；它不等于给每个模型划一块虚假的独立余额。</p></div><button className="secondary-action" onClick={() => setActiveView("route")}><Route size={15} /> Test policy</button></div><div className="policy-grid"><div className="panel policy-panel"><div className="section-kicker">BUDGET MODEL</div><h2>Three coordinated layers</h2><div className="policy-modes static-policy"><div className="policy-mode policy-mode-active"><Database size={18} /><span><b>Provider Budget</b><small>5h / week / month shared USD windows</small></span></div><div className="policy-mode"><Layers3 size={18} /><span><b>Model Cost & Scarcity</b><small>cost, capability, availability, concurrency</small></span></div><div className="policy-mode"><Workflow size={18} /><span><b>Task Budget & Reservation</b><small>P0/P1 lock capacity before queue admission</small></span></div></div></div><div className="panel policy-panel"><div className="section-kicker">SCHEDULED SYNC</div><h2>Configuration boundary</h2><div className="connection-card"><CloudCog size={20} /><div><b>{openCodeConnection?.secretState === "configured" ? "Credentials configured" : "Credentials not configured"}</b><small>{openCodeConnection?.secretState === "configured" ? "Deploy the site, then enable the 15-minute Heartbeat job." : "历史导入、队列和账本可用；提供 API keys 后再启用真实同步。"}</small></div></div><div className="policy-copy"><span>Default cadence</span><b>15 min / idempotent</b><span>Execution</span><b>scheduled HTTP job</b><span>ChatGPT Plus</span><b>manual rescue lane</b></div></div></div></section>}
        </div>
      </main>

      {importOpen && <div className="detail-overlay" onClick={() => setImportOpen(false)}><div className="dialog-card" onClick={event => event.stopPropagation()}><div className="drawer-head"><div><span className="section-kicker">USAGE IMPORT</span><h2>Bring your history in</h2></div><button className="icon-button" onClick={() => setImportOpen(false)}><X size={18} /></button></div><p>支持 CSV 或 JSON。系统会校验最小字段、去重 `external_ref`，并将原始文件保存在工作区私有存储中。</p><div className="import-drop" onClick={() => fileRef.current?.click()}><FileUp size={24} /><b>{importUsage.isPending ? "正在解析并写入…" : "选择 CSV / JSON 文件"}</b><small>最大 4 MB；不接受 Excel 或压缩包。</small></div><input ref={fileRef} className="sr-only" type="file" accept=".csv,.json,text/csv,application/json" onChange={handleUpload} /><code>required: occurred_at, provider, model_id, actual_cost_usd | estimated_cost_usd</code></div></div>}
      {taskOpen && <div className="detail-overlay" onClick={() => setTaskOpen(false)}><div className="dialog-card" onClick={event => event.stopPropagation()}><div className="drawer-head"><div><span className="section-kicker">BUDGETED TASK</span><h2>Reserve before queueing</h2></div><button className="icon-button" onClick={() => setTaskOpen(false)}><X size={18} /></button></div><label className="dialog-label">任务名称<input value={taskTitle} onChange={event => setTaskTitle(event.target.value)} /></label><label className="dialog-label">任务预设<select value={selectedPreset} onChange={event => { const next = TASK_PRESETS.find(item => item.id === event.target.value) ?? TASK_PRESETS[1]; setSelectedPreset(next.id); setPriority(next.priority); }} >{TASK_PRESETS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label className="dialog-label">优先级<div className="priority-segments">{(["P0", "P1", "P2", "P3"] as Priority[]).map(item => <button key={item} className={priority === item ? "priority-active" : ""} onClick={() => setPriority(item)}>{item}</button>)}</div></label><div className="task-reservation-preview"><LockKeyhole size={16} /><span>{priority === "P0" || priority === "P1" ? `${formatUsd(selected.estimatedCost)} 将从 5h 共享窗口预留。` : "P2/P3 进入队列但不锁定 P0/P1 保护额度。"}</span></div><button className="primary-action" disabled={createTask.isPending} onClick={submitTask}><CheckCircle2 size={15} /> {createTask.isPending ? "正在写入…" : "Create task & reservation"}</button></div></div>}
      {inviteOpen && <div className="detail-overlay" onClick={() => setInviteOpen(false)}><div className="dialog-card" onClick={event => event.stopPropagation()}><div className="drawer-head"><div><span className="section-kicker">WORKSPACE INVITE</span><h2>Define the role first</h2></div><button className="icon-button" onClick={() => setInviteOpen(false)}><X size={18} /></button></div><label className="dialog-label">成员邮箱<input type="email" placeholder="researcher@example.edu" value={inviteEmail} onChange={event => setInviteEmail(event.target.value)} /></label><label className="dialog-label">角色<select value={inviteRole} onChange={event => setInviteRole(event.target.value as typeof inviteRole)}><option value="researcher">Researcher</option><option value="reviewer">Reviewer</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select></label><p className="dialog-muted">当前版本会写入待发送的邀请记录；自动邮件将在通知渠道配置后启用。</p><button className="primary-action" disabled={!inviteEmail || inviteMember.isPending} onClick={() => workspaceId && inviteMember.mutate({ workspaceId, email: inviteEmail, role: inviteRole })}><Users size={15} /> Create pending invite</button></div></div>}
    </div>
  );
}
