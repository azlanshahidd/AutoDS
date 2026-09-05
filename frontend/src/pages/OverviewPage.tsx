import { useEffect, useState, useCallback, useRef } from "react";
import {
  Package, ShoppingCart, AlertTriangle, Zap, ShieldAlert,
  Activity,
  ArrowUpRight, ScrollText,
  Radar,
  CheckCircle2, Circle, ChevronRight,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/Card";
import { StatCard } from "../components/ui/StatCard";
import { StatusBadge, StatusTone } from "../components/ui/StatusBadge";
import { Toggle } from "../components/ui/Toggle";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { useToast } from "../components/ui/Toast";
import { api, OverviewStats, OrderRow, LogRow, ApiError } from "../lib/api";
import { useNotifications } from "../lib/notificationContext";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(ts: string | null) {
  if (!ts) return "Never";
  return new Date(ts.replace(" ", "T") + "Z").toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function fmtShort(ts: string) {
  return new Date(ts.replace(" ", "T") + "Z").toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good Morning";
  if (h < 18) return "Good Afternoon";
  return "Good Evening";
}

// F07: full order status → tone + label mapping (must match OrdersPage)
const orderTone: Record<string, StatusTone> = {
  pending:                     "neutral",
  submitted:                   "info",
  shipped:                     "warning",
  fulfilled:                   "success",
  failed:                      "danger",
  skipped_auto_order_disabled: "neutral",
  cancelled:                   "danger",
};
const orderLabel: Record<string, string> = {
  pending:                     "Pending",
  submitted:                   "Submitted",
  shipped:                     "Shipped",
  fulfilled:                   "Fulfilled",
  failed:                      "Failed",
  skipped_auto_order_disabled: "Logged only",
  cancelled:                   "Cancelled",
};

// ── Job result tone map (used by Job Status panel) ───────────────────────────

const toneMap: Record<string, StatusTone> = {
  success: "success", partial_failure: "warning", failure: "danger",
};

// ── Chart helpers ─────────────────────────────────────────────────────────────

const CHART_W = 520;
const CHART_H = 180;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function toSmoothPath(data: number[], w: number, h: number, pad = 24, maxVal?: number): string {
  if (data.length < 2) return "";
  const max = maxVal ?? (Math.max(...data, 1) * 1.15);
  const pts = data.map((v, i) => ({
    x: pad + (i / (data.length - 1)) * (w - pad * 2),
    y: h - pad - (v / max) * (h - pad * 2),
  }));
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], c = pts[i];
    const cpX = (p.x + c.x) / 2;
    d += ` C ${cpX} ${p.y}, ${cpX} ${c.y}, ${c.x} ${c.y}`;
  }
  return d;
}

function toAreaPath(linePath: string, data: number[], w: number, h: number, pad = 24): string {
  if (!linePath || data.length < 2) return "";
  const lastX = pad + (w - pad * 2);
  const firstX = pad;
  const baseline = h - pad;
  return `${linePath} L ${lastX} ${baseline} L ${firstX} ${baseline} Z`;
}

interface AreaChartProps {
  successData: number[]; // syncs OK per day
  failedData:  number[]; // syncs failed per day
  labels:      string[];
}

function AreaChart({ successData, failedData, labels }: AreaChartProps) {
  const pad = 24;

  // ── Y-axis: enforce a minimum ceiling so scale always looks clean ────────
  const dataMax = Math.max(...successData, ...failedData, 0);
  const ceiling = Math.max(dataMax, 4);       // at least 4 distinct levels
  const chartMax = Math.ceil(ceiling * 1.2);  // 20% headroom, whole number

  const iPath = toSmoothPath(successData, CHART_W, CHART_H, pad, chartMax);
  const oPath = toSmoothPath(failedData,  CHART_W, CHART_H, pad, chartMax);
  const iArea = toAreaPath(iPath, successData, CHART_W, CHART_H, pad);
  const oArea = toAreaPath(oPath, failedData,  CHART_W, CHART_H, pad);

  // 5 clean integer Y labels: chartMax → 0
  const yLabels = Array.from({ length: 5 }, (_, i) => {
    const pct = i / 4;
    return {
      value: Math.round((1 - pct) * chartMax),
      y: CHART_H - pad - (1 - pct) * (CHART_H - pad * 2),
    };
  });

  // Dot positions (success line)
  const dots = successData.map((v, i) => ({
    x: pad + (successData.length > 1 ? i / (successData.length - 1) : 0.5) * (CHART_W - pad * 2),
    y: CHART_H - pad - (v / chartMax) * (CHART_H - pad * 2),
  }));

  // ── X-axis: thin labels so they never overlap ────────────────────────────
  const maxXLabels = 10;
  const xStep = Math.max(1, Math.ceil(labels.length / maxXLabels));

  return (
    <svg viewBox={`0 0 ${CHART_W} ${CHART_H + 14}`} className="w-full"
      style={{ height: `${CHART_H + 14}px`, overflow: "visible" }}>
      <defs>
        <linearGradient id="incomeGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#06B6D4" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#06B6D4" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="outcomeGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#EF4444" stopOpacity="0.20" />
          <stop offset="100%" stopColor="#EF4444" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Grid lines */}
      {yLabels.map(({ y }, i) => (
        <line key={i} x1={pad} y1={y} x2={CHART_W - pad} y2={y}
          stroke="rgba(255,255,255,0.07)" strokeWidth={1} />
      ))}

      {/* Y-axis labels */}
      {yLabels.map(({ value, y }) => (
        <text key={value} x={pad - 4} y={y + 4}
          fontSize={10} fill="#5C606B" textAnchor="end">{value}</text>
      ))}

      {/* Areas */}
      {oArea && <path d={oArea} fill="url(#outcomeGrad)" />}
      {iArea && <path d={iArea} fill="url(#incomeGrad)" />}

      {/* Lines */}
      {oPath && <path d={oPath} fill="none" stroke="#EF4444" strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round" opacity={0.7} />}
      {iPath && <path d={iPath} fill="none" stroke="#06B6D4" strokeWidth={2.5}
        strokeLinecap="round" strokeLinejoin="round" />}

      {/* Dots + X labels — only render label every xStep points */}
      {dots.map((pt, i) => (
        <g key={i}>
          <circle cx={pt.x} cy={pt.y} r={3} fill="#06B6D4" />
          {i % xStep === 0 && (
            <text x={pt.x} y={CHART_H + 2} fontSize={10} fill="#5C606B" textAnchor="middle">
              {labels[i] ?? ""}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

// ── Donut ring ────────────────────────────────────────────────────────────────

function DonutRing({ pct }: { pct: number }) {
  const r = 44, cx = 56, cy = 56;
  const circ = 2 * Math.PI * r;
  const clamped = Math.min(100, Math.max(0, pct));
  const dash = (clamped / 100) * circ;
  return (
    <svg width={112} height={112} style={{ flexShrink: 0 }}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#2A2C34" strokeWidth={10} />
      <circle cx={cx} cy={cy} r={r} fill="none"
        stroke="#06B6D4" strokeWidth={10} strokeLinecap="round"
        strokeDasharray={`${dash} ${circ}`}
        strokeDashoffset={circ * 0.25}
        style={{ filter: "drop-shadow(0 0 6px rgba(6,182,212,0.5))" }}
      />
      <text x={cx} y={cy + 1} textAnchor="middle" dominantBaseline="middle"
        fontSize={18} fontWeight={700} fill="#F5F5F7">{clamped}%</text>
    </svg>
  );
}

// ── Quick-action card ─────────────────────────────────────────────────────────

function ActionCard({ icon: Icon, line1, line2, iconBg, iconColor, to }: {
  icon: typeof Package; line1: string; line2: string;
  iconBg: string; iconColor: string; to: string;
}) {
  return (
    <NavLink to={to} className="action-card flex flex-1 flex-col gap-3" style={{ textDecoration: "none" }}>
      <div className="icon-chip" style={{ background: iconBg, width: 40, height: 40, borderRadius: 10 }}>
        <Icon size={18} style={{ color: iconColor }} strokeWidth={1.8} />
      </div>
      <div>
        <p style={{ fontSize: "12px", fontWeight: 500, color: "#C8CCDA", lineHeight: 1.3 }}>{line1}</p>
        <p style={{ fontSize: "12px", fontWeight: 500, color: "#5C606B", lineHeight: 1.3 }}>{line2}</p>
      </div>
    </NavLink>
  );
}

// ── derive chart data from logs for any date range ───────────────────────────

type ChartRange = "Week" | "Month" | "Year" | "Custom";

/** Build per-day bucket arrays between fromDate and toDate (inclusive). */
function buildChartData(
  logs: LogRow[],
  fromDate: Date,
  toDate: Date,
): { successData: number[]; failedData: number[]; labels: string[] } {
  const labels: string[] = [];
  const successData: number[] = [];
  const failedData:  number[] = [];

  // Normalise to midnight UTC for clean date comparisons
  const from = new Date(fromDate); from.setHours(0, 0, 0, 0);
  const to   = new Date(toDate);   to.setHours(23, 59, 59, 999);

  // Count total days so we can decide label granularity
  const totalDays = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;

  // If range > 60 days, bucket by week instead of day to keep chart readable
  const byWeek = totalDays > 60;

  if (!byWeek) {
    // Daily buckets
    for (let d = 0; d < totalDays; d++) {
      const date = new Date(from);
      date.setDate(from.getDate() + d);
      const dateStr = date.toISOString().slice(0, 10);

      // Short label: "Mon 3" for month range, just "Mon" for week
      const dayName = DAYS[date.getDay() === 0 ? 6 : date.getDay() - 1];
      labels.push(totalDays <= 7 ? dayName : `${dayName} ${date.getDate()}`);

      const dayLogs = logs.filter(l => l.run_at.slice(0, 10) === dateStr);
      successData.push(dayLogs.filter(l => l.result === "success").length);
      failedData.push( dayLogs.filter(l => l.result === "failure" || l.result === "partial_failure").length);
    }
  } else {
    // Weekly buckets for Year / long custom ranges
    let cursor = new Date(from);
    while (cursor <= to) {
      const weekEnd = new Date(cursor);
      weekEnd.setDate(cursor.getDate() + 6);
      if (weekEnd > to) weekEnd.setTime(to.getTime());

      const weekStr = `${cursor.toLocaleString("default", { month: "short" })} ${cursor.getDate()}`;
      labels.push(weekStr);

      const weekLogs = logs.filter(l => {
        const d = l.run_at.slice(0, 10);
        return d >= cursor.toISOString().slice(0, 10) && d <= weekEnd.toISOString().slice(0, 10);
      });
      successData.push(weekLogs.filter(l => l.result === "success").length);
      failedData.push( weekLogs.filter(l => l.result === "failure" || l.result === "partial_failure").length);

      cursor.setDate(cursor.getDate() + 7);
    }
  }

  return { successData, failedData, labels };
}

/** Compute fromDate / toDate for a preset range */
function rangeToDateWindow(range: Exclude<ChartRange, "Custom">): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date();
  if (range === "Week") {
    from.setDate(to.getDate() - 6);
  } else if (range === "Month") {
    from.setDate(to.getDate() - 29);
  } else {
    from.setDate(to.getDate() - 364);
  }
  return { from, to };
}

/** Format a Date as YYYY-MM-DD for <input type="date"> */
function toInputDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Human-readable range label for the chart title */
function rangeLabel(range: ChartRange, from: Date, to: Date): string {
  if (range === "Week")  return "This Week";
  if (range === "Month") return "Last 30 Days";
  if (range === "Year")  return "Last 365 Days";
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${fmt(from)} – ${fmt(to)}`;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function OverviewPage() {
  const { showToast } = useToast();
  const { push: pushNotification } = useNotifications();
  const prevFailedRef = useRef(0);
  const [stats,   setStats]   = useState<OverviewStats | null>(null);
  const [orders,  setOrders]  = useState<OrderRow[]>([]);
  const [logs,    setLogs]    = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  // F25 + F26: track whether the most recent background poll succeeded
  const [pollOk, setPollOk]   = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [chartRange, setChartRange] = useState<ChartRange>("Week");
  const [customFrom, setCustomFrom] = useState<string>(() => toInputDate((() => { const d = new Date(); d.setDate(d.getDate() - 29); return d; })()));
  const [customTo,   setCustomTo]   = useState<string>(() => toInputDate(new Date()));
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const first = useRef(true);
  // Onboarding checklist
  const [setupStatus, setSetupStatus] = useState<{
    ebayConfigured: boolean; supplierConnected: boolean; aiProviderConfigured: boolean;
  } | null>(null);
  const [checklistDismissed, setChecklistDismissed] = useState(
    () => localStorage.getItem("onboarding_dismissed") === "true"
  );

  const load = useCallback(async () => {
    try {
      const [overviewData, ordersData, logsData] = await Promise.all([
        api.getOverview(),
        api.listOrders(),
        api.listLogs(),
      ]);
      setStats({ ...overviewData, activeAlerts: overviewData.activeAlerts ?? [] });
      setOrders(ordersData.orders ?? []);
      setLogs(logsData.logs ?? []);
      setPollOk(true);  // F25+F26: mark poll healthy

      // Push notification when new job failures appear since last poll
      const newFailed = overviewData.failedJobsLast24h ?? 0;
      if (newFailed > prevFailedRef.current && prevFailedRef.current >= 0) {
        pushNotification(
          `${newFailed} job failure${newFailed !== 1 ? "s" : ""} in the last 24h — check Logs.`,
          "danger"
        );
      }
      prevFailedRef.current = newFailed;
      // F02: only clear the initial loading spinner once — not on every poll
      if (first.current) { first.current = false; setLoading(false); }
    } catch (err) {
      setPollOk(false); // F25+F26: mark poll unhealthy
      if (first.current) {
        showToast(err instanceof ApiError ? err.message : "Failed to load.", "danger");
        first.current = false;
        setLoading(false);
      }
      // Background poll failures are surfaced via the stale-data banner (F25)
      // rather than repeat toasts.
    }
  }, []); // eslint-disable-line

  useEffect(() => {
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load]);

  // Fetch setup status once on mount (not on every poll)
  useEffect(() => {
    api.getSetupStatus()
      .then(s => setSetupStatus(s))
      .catch(() => { /* non-fatal */ });
  }, []);

  async function applyToggle(next: boolean) {
    setToggling(true);
    try {
      const { enabled } = await api.setAutoOrderEnabled(next);
      setStats(p => p ? { ...p, autoOrderEnabled: enabled } : p);
      showToast(enabled ? "Auto-order enabled." : "Auto-order disabled.", enabled ? "success" : "info");
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed.", "danger");
    } finally { setToggling(false); setConfirm(false); }
  }

  const alerts  = stats?.activeAlerts ?? [];
  const failed  = stats?.failedJobsLast24h ?? 0;
  const tracked = stats?.productsTracked ?? 0;
  const ordersToday    = stats?.ordersReceivedToday ?? 0;
  const ordersPlaced   = stats?.ordersPlacedToday   ?? 0;

  // ── Chart date window ───────────────────────────────────────────────────
  const chartWindow = chartRange === "Custom"
    ? { from: new Date(customFrom), to: new Date(customTo) }
    : rangeToDateWindow(chartRange);

  // F03: detect invalid custom range (from > to)
  const customRangeInvalid =
    chartRange === "Custom" && new Date(customFrom) > new Date(customTo);

  // ── Chart data: derived from real logs ──────────────────────────────────
  const { successData, failedData, labels } = buildChartData(
    logs,
    customRangeInvalid ? new Date() : chartWindow.from,
    customRangeInvalid ? new Date() : chartWindow.to,
  );
  const totalSuccess = successData.reduce((a, b) => a + b, 0);
  const totalFailed  = failedData.reduce((a, b) => a + b, 0);
  const totalRuns    = totalSuccess + totalFailed;

  // F05: donut ring success rate uses a fixed 7-day window, independent of
  // the chart range selector so it doesn't change when the user switches tabs.
  const donutWindow = rangeToDateWindow("Week");
  const { successData: donutSuccess, failedData: donutFailed } =
    buildChartData(logs, donutWindow.from, donutWindow.to);
  const donutTotal   = donutSuccess.reduce((a,b)=>a+b,0) + donutFailed.reduce((a,b)=>a+b,0);
  const donutSuccess7 = donutSuccess.reduce((a,b)=>a+b,0);
  const successRate  = donutTotal > 0
    ? Math.round((donutSuccess7 / donutTotal) * 100)
    : 100;

  // ── Recent orders (last 5) ──────────────────────────────────────────────
  const recentOrders = orders.slice(0, 5);

  // ── Initials + color for order avatar ──────────────────────────────────
  const avatarColors = ["#06B6D4", "#8B5CF6", "#22C55E", "#38BDF8", "#F59E0B"];
  function initials(id: string) {
    return id.slice(-4).toUpperCase();
  }

  return (
    <div style={{ padding: "24px", minHeight: "100%", background: "#111318" }}>

      {/* ── Greeting ─────────────────────────────────────────────── */}
      <div className="mb-6 flex items-end justify-between">
        <div>
          <p style={{ fontSize: "13px", color: "#9297A5", marginBottom: "4px" }}>{greeting()}</p>
          <h1 style={{ fontSize: "24px", fontWeight: 700, color: "#F5F5F7", letterSpacing: "-0.02em", lineHeight: 1 }}>
            Welcome to CoreDash
          </h1>
          <p style={{ fontSize: "13px", color: "#5C606B", marginTop: "4px" }}>
            Here's what's happening with your automation today.
          </p>
        </div>
        {/* F26: badge colour reflects actual poll health */}
        <div className="flex items-center gap-2 rounded-full px-3 py-1.5"
          style={{
            background: pollOk ? "rgba(34,197,94,0.08)"  : "rgba(245,158,11,0.08)",
            border:     pollOk ? "1px solid rgba(34,197,94,0.18)" : "1px solid rgba(245,158,11,0.18)",
          }}>
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
              style={{ background: pollOk ? "#22C55E" : "#F59E0B" }} />
            <span className="relative inline-flex h-2 w-2 rounded-full"
              style={{ background: pollOk ? "#22C55E" : "#F59E0B" }} />
          </span>
          <span style={{ fontSize: "12px", fontWeight: 500, color: pollOk ? "#22C55E" : "#F59E0B" }}>
            {pollOk ? "Live · every 8s" : "Reconnecting…"}
          </span>
        </div>
      </div>

      {/* F25: stale-data warning when background polls are failing */}
      {!pollOk && !loading && (
        <div className="mb-4 flex items-center gap-3 rounded-2xl px-5 py-3"
          style={{ background: "rgba(245,158,11,0.07)", border: "1px solid rgba(245,158,11,0.18)" }}>
          <AlertTriangle size={14} className="shrink-0" style={{ color: "#F59E0B" }} />
          <p style={{ fontSize: "12px", color: "#F59E0B" }}>
            Cannot reach the server — showing last known data. Retrying every 8 seconds.
          </p>
        </div>
      )}

      {/* ── Onboarding checklist — shown until dismissed or fully complete ── */}
      {setupStatus && !checklistDismissed && (
        !(setupStatus.ebayConfigured && setupStatus.supplierConnected && setupStatus.aiProviderConfigured)
      ) && (
        <div className="mb-6 rounded-2xl overflow-hidden"
          style={{ border: "1px solid rgba(6,182,212,0.20)", background: "rgba(6,182,212,0.05)" }}>
          <div className="flex items-center justify-between px-5 py-3"
            style={{ borderBottom: "1px solid rgba(6,182,212,0.12)" }}>
            <p style={{ fontSize: "13px", fontWeight: 600, color: "#F5F5F7" }}>
              Setup checklist
            </p>
            <button
              onClick={() => {
                setChecklistDismissed(true);
                localStorage.setItem("onboarding_dismissed", "true");
              }}
              style={{ fontSize: "11px", color: "#5C606B" }}
              className="hover:text-ink-3 transition-colors"
            >
              Dismiss
            </button>
          </div>
          <div className="flex flex-col gap-0 divide-y" style={{ divideColor: "rgba(255,255,255,0.04)" }}>
            {[
              {
                done: setupStatus.ebayConfigured,
                label: "eBay API credentials",
                hint: "Add your Client ID, Client Secret and Refresh Token",
                to: "/settings",
              },
              {
                done: setupStatus.supplierConnected,
                label: "Supplier connected",
                hint: "Add and test a CJ or CSV supplier",
                to: "/suppliers",
              },
              {
                done: setupStatus.aiProviderConfigured,
                label: "AI provider connected",
                hint: "Add an OpenAI-compatible, Gemini or Cohere provider",
                to: "/ai-providers",
              },
            ].map(({ done, label, hint, to }) => (
              <NavLink
                key={label}
                to={to}
                className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-white/[0.03]"
                style={{ textDecoration: "none" }}
              >
                {done
                  ? <CheckCircle2 size={16} style={{ color: "#22C55E", flexShrink: 0 }} />
                  : <Circle      size={16} style={{ color: "#3A3D47",  flexShrink: 0 }} />}
                <div className="flex-1">
                  <p style={{ fontSize: "12px", fontWeight: 600, color: done ? "#5C606B" : "#C8CCDA",
                    textDecoration: done ? "line-through" : "none" }}>
                    {label}
                  </p>
                  {!done && (
                    <p style={{ fontSize: "11px", color: "#5C606B", marginTop: "1px" }}>{hint}</p>
                  )}
                </div>
                {!done && <ChevronRight size={14} style={{ color: "#3A3D47", flexShrink: 0 }} />}
              </NavLink>
            ))}
          </div>
        </div>
      )}

      {/* ── Alert banner ─────────────────────────────────────────── */}
      {alerts.length > 0 && (
        <div className="mb-6 flex items-start gap-3 rounded-2xl px-5 py-4"
          style={{ background: "rgba(239,68,68,0.07)", border: "1px solid rgba(239,68,68,0.18)" }}>
          <AlertTriangle size={15} className="mt-0.5 shrink-0" style={{ color: "#EF4444" }} />
          <div>
            <p style={{ fontSize: "13px", fontWeight: 600, color: "#EF4444" }}>
              {alerts.length} job{alerts.length > 1 ? "s" : ""} failing repeatedly
            </p>
            <p style={{ fontSize: "12px", color: "rgba(239,68,68,0.65)", marginTop: "2px" }}>
              Check Logs for details.
            </p>
          </div>
        </div>
      )}

      {/* ── 4 Stat cards ─────────────────────────────────────────── */}
      <div className="mb-6 grid grid-cols-4 gap-5">
        <StatCard
          label="Products Tracked"
          value={loading ? "—" : tracked}
          icon={Package}
          tone="cyan"
        />
        <StatCard
          label="Orders Today"
          value={loading ? "—" : ordersToday}
          icon={ShoppingCart}
          tone="green"
          changeDir={ordersPlaced > 0 ? "up" : ordersToday > 0 ? "neutral" : "neutral"}
          change={
            ordersPlaced > 0
              ? `${ordersPlaced} placed`
              : ordersToday > 0
                ? `${ordersToday} received`
                : "None yet"
          }
        />
        <StatCard
          label="Failed Jobs (24h)"
          value={loading ? "—" : failed}
          icon={AlertTriangle}
          tone={failed > 0 ? "red" : "amber"}
          changeDir={failed > 0 ? "down" : "neutral"}
          change={failed > 0 ? `${failed} need attention` : "All clear"}
        />

        {/* Auto-Order — glows orange gradient when active, dark when off */}
        <div
          className="relative overflow-hidden rounded-2xl p-5 transition-all duration-300"
          style={{
            background: stats?.autoOrderEnabled
              ? "linear-gradient(135deg,#0891B2 0%,#22D3EE 55%,#06B6D4 100%)"
              : "linear-gradient(145deg,#1C1D24 0%,#191A20 100%)",
            border: stats?.autoOrderEnabled
              ? "none"
              : "1px solid rgba(255,255,255,0.06)",
            boxShadow: stats?.autoOrderEnabled
              ? "0 8px 32px rgba(6,182,212,0.35), 0 2px 8px rgba(0,0,0,0.4)"
              : "0 4px 24px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.04)",
          }}
        >
          {/* Decorative glow blobs — only visible when active */}
          {stats?.autoOrderEnabled && (
            <>
              <div className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full"
                style={{ background: "rgba(255,255,255,0.10)" }} />
              <div className="pointer-events-none absolute -bottom-4 -left-4 h-16 w-16 rounded-full"
                style={{ background: "rgba(255,255,255,0.07)" }} />
            </>
          )}

          <div className="relative flex h-full flex-col justify-between" style={{ minHeight: "100px" }}>
            {/* Top row: label + icon */}
            <div className="flex items-center justify-between">
              <p style={{
                fontSize: "11px", fontWeight: 600,
                textTransform: "uppercase", letterSpacing: "0.06em",
                color: stats?.autoOrderEnabled ? "rgba(255,255,255,0.75)" : "#5C606B",
              }}>
                Auto-Order
              </p>
              <div
                className="flex h-11 w-11 items-center justify-center rounded-xl transition-all duration-300"
                style={{
                  background: stats?.autoOrderEnabled
                    ? "rgba(255,255,255,0.15)"
                    : "rgba(245,158,11,0.12)",
                }}
              >
                <Activity size={18} strokeWidth={1.8} style={{
                  color: stats?.autoOrderEnabled ? "#fff" : "#F59E0B",
                }} />
              </div>
            </div>

            {/* Big value */}
            <p style={{
              fontSize: "32px", fontWeight: 700, lineHeight: 1,
              letterSpacing: "-0.02em", marginTop: "12px",
              color: stats?.autoOrderEnabled ? "#fff" : "#F5F5F7",
            }}>
              {loading ? "—" : stats?.autoOrderEnabled ? "Active" : "Paused"}
            </p>

            {/* Delta badge */}
            <div style={{ marginTop: "12px" }}>
              {stats?.autoOrderEnabled ? (
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: "4px",
                  fontSize: "11px", fontWeight: 700,
                  padding: "2px 10px", borderRadius: "9999px",
                  background: "rgba(255,255,255,0.18)",
                  color: "#fff",
                }}>
                  <Activity size={9} strokeWidth={2.5} />
                  Live
                </span>
              ) : (
                <span className="delta-neutral">Off</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Quick-action row ─────────────────────────────────────── */}
      <div className="mb-6 flex gap-5">
        <ActionCard icon={Package}    line1="Products" line2={loading ? "…" : `${tracked} tracked`}
          iconBg="rgba(6,182,212,0.14)" iconColor="#06B6D4" to="/products" />
        <ActionCard icon={ShoppingCart} line1="Orders" line2={loading ? "…" : `${orders.length} total`}
          iconBg="rgba(56,189,248,0.12)" iconColor="#38BDF8" to="/orders" />
        <ActionCard icon={Radar}      line1="Scouted" line2="Review items"
          iconBg="rgba(139,92,246,0.12)" iconColor="#8B5CF6" to="/scouted" />
        <ActionCard icon={ScrollText} line1="Logs" line2={loading ? "…" : `${logs.length} entries`}
          iconBg="rgba(34,197,94,0.12)" iconColor="#22C55E" to="/logs" />
      </div>

      {/* ── Two-column layout ─────────────────────────────────────── */}
      <div className="grid gap-5" style={{ gridTemplateColumns: "1fr 340px" }}>

        {/* ════ LEFT ════ */}
        <div className="flex flex-col gap-5">

          {/* Chart card */}
          <Card>
            <CardContent style={{ padding: "24px 24px 20px" }}>
              <div className="mb-5 flex items-start justify-between gap-4">
                <div>
                  <p className="metric-label">Job Runs — {rangeLabel(chartRange, chartWindow.from, chartWindow.to)}</p>
                  <p style={{ fontSize: "36px", fontWeight: 700, color: "#F5F5F7", letterSpacing: "-0.02em", lineHeight: 1, marginTop: "8px" }}>
                    {loading ? "—" : totalRuns}
                    <span style={{ fontSize: "14px", fontWeight: 500, color: "#5C606B", marginLeft: "8px" }}>
                      runs
                    </span>
                  </p>
                </div>
                <div className="flex items-center gap-3 flex-wrap justify-end">
                  {/* Legend */}
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1.5" style={{ fontSize: "12px", color: "#9297A5" }}>
                      <span className="h-2 w-2 rounded-full" style={{ background: "#06B6D4", flexShrink: 0 }} />
                      Success
                    </span>
                    <span className="flex items-center gap-1.5" style={{ fontSize: "12px", color: "#9297A5" }}>
                      <span className="h-2 w-2 rounded-full" style={{ background: "#EF4444", flexShrink: 0 }} />
                      Failed
                    </span>
                  </div>

                  {/* Preset range pills */}
                  <div className="flex items-center rounded-full p-0.5"
                    style={{ background: "#1A1B21", border: "1px solid rgba(255,255,255,0.07)" }}>
                    {(["Week", "Month", "Year"] as const).map(r => (
                      <button key={r} onClick={() => { setChartRange(r); setShowCustomPicker(false); }} style={{
                        padding: "4px 12px", borderRadius: "9999px", fontSize: "11px", fontWeight: 600,
                        cursor: "pointer", border: "none", transition: "all 150ms ease",
                        background: chartRange === r ? "#06B6D4" : "transparent",
                        color:      chartRange === r ? "#fff"    : "#5C606B",
                        boxShadow:  chartRange === r ? "0 0 10px rgba(6,182,212,0.35)" : "none",
                      }}>{r}</button>
                    ))}
                    {/* Custom toggle */}
                    <button
                      onClick={() => { setChartRange("Custom"); setShowCustomPicker(true); }}
                      style={{
                        padding: "4px 12px", borderRadius: "9999px", fontSize: "11px", fontWeight: 600,
                        cursor: "pointer", border: "none", transition: "all 150ms ease",
                        background: chartRange === "Custom" ? "#06B6D4" : "transparent",
                        color:      chartRange === "Custom" ? "#fff"    : "#5C606B",
                        boxShadow:  chartRange === "Custom" ? "0 0 10px rgba(6,182,212,0.35)" : "none",
                      }}
                    >
                      Custom
                    </button>
                  </div>

                  {/* Custom date picker — slides in when Custom is active */}
                  {chartRange === "Custom" && (
                    <div
                      className="flex items-center gap-2 rounded-xl px-3 py-2"
                      style={{
                        background: "#1A1B21",
                        border: "1px solid rgba(6,182,212,0.30)",
                        boxShadow: "0 0 0 1px rgba(6,182,212,0.10)",
                      }}
                    >
                      <span style={{ fontSize: "11px", color: "#5C606B", fontWeight: 500 }}>From</span>
                      <input
                        type="date"
                        value={customFrom}
                        max={customTo}
                        onChange={e => setCustomFrom(e.target.value)}
                        style={{
                          background: "transparent",
                          border: "none",
                          outline: "none",
                          fontSize: "12px",
                          color: "#C8CCDA",
                          fontFamily: "inherit",
                          cursor: "pointer",
                          colorScheme: "dark",
                        }}
                      />
                      <span style={{ fontSize: "11px", color: "#5C606B", fontWeight: 500 }}>To</span>
                      <input
                        type="date"
                        value={customTo}
                        min={customFrom}
                        max={toInputDate(new Date())}
                        onChange={e => setCustomTo(e.target.value)}
                        style={{
                          background: "transparent",
                          border: "none",
                          outline: "none",
                          fontSize: "12px",
                          color: "#C8CCDA",
                          fontFamily: "inherit",
                          cursor: "pointer",
                          colorScheme: "dark",
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
              {loading
                ? <div className="flex items-center justify-center" style={{ height: `${CHART_H}px` }}>
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-surface-3 border-t-cyan" />
                  </div>
                : customRangeInvalid
                  ? (
                    /* F03: invalid custom range — from > to */
                    <div className="flex items-center justify-center gap-2" style={{ height: `${CHART_H}px` }}>
                      <AlertTriangle size={16} style={{ color: "#F59E0B" }} />
                      <p style={{ fontSize: "13px", color: "#F59E0B" }}>
                        "From" date must be before "To" date.
                      </p>
                    </div>
                  )
                : <AreaChart successData={successData} failedData={failedData} labels={labels} />
              }
            </CardContent>
          </Card>

          {/* Recent orders */}
          <Card>
            <CardHeader>
              <CardTitle>Recent Orders</CardTitle>
              <NavLink to="/orders" style={{ fontSize: "12px", fontWeight: 500, color: "#06B6D4", textDecoration: "none" }}>
                See all →
              </NavLink>
            </CardHeader>
            <CardContent style={{ padding: "0 24px 8px" }}>
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-surface-3 border-t-cyan" />
                </div>
              ) : recentOrders.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8">
                  <ShoppingCart size={20} style={{ color: "#3A3D47" }} />
                  <p style={{ fontSize: "13px", color: "#5C606B" }}>No orders yet</p>
                </div>
              ) : (
                recentOrders.map((order, i) => (
                  <div key={order.ebay_order_id} className="tx-row">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                      style={{ background: avatarColors[i % avatarColors.length] + "22", color: avatarColors[i % avatarColors.length] }}>
                      {initials(order.ebay_order_id)}
                    </div>
                    <div className="flex flex-1 flex-col" style={{ gap: "4px" }}>
                      <p style={{ fontSize: "13px", fontWeight: 500, color: "#C8CCDA" }}>
                        {order.ebay_order_id}
                      </p>
                      <p style={{ fontSize: "11px", color: "#5C606B" }}>
                        {order.supplier_type} · {fmtShort(order.created_at)}
                      </p>
                    </div>
                    <StatusBadge label={orderLabel[order.status] ?? order.status.replace(/_/g, " ")} tone={orderTone[order.status] ?? "neutral"} />
                  </div>
                ))
              )}

            </CardContent>
          </Card>
        </div>

        {/* ════ RIGHT ════ */}
        <div className="flex flex-col gap-5">

          {/* Auto-order toggle — top of right column */}
          <Card>
            <CardContent style={{ padding: "20px 24px" }}>
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-300"
                    style={{
                      background: stats?.autoOrderEnabled ? "rgba(6,182,212,0.15)" : "rgba(255,255,255,0.05)",
                      boxShadow:  stats?.autoOrderEnabled ? "0 0 16px rgba(6,182,212,0.25)" : "none",
                    }}>
                    <Zap size={18} strokeWidth={1.8}
                      style={{ color: stats?.autoOrderEnabled ? "#06B6D4" : "#5C606B" }} />
                  </div>
                  <div>
                    <p style={{ fontSize: "13px", fontWeight: 600, color: "#C8CCDA" }}>Auto-order</p>
                    <p style={{ fontSize: "11px", color: "#5C606B", marginTop: "2px" }}>
                      {stats?.autoOrderEnabled ? "Live — placing orders" : "Off — read-only"}
                    </p>
                  </div>
                </div>
                <Toggle
                  checked={stats?.autoOrderEnabled ?? false}
                  onChange={n => n ? setConfirm(true) : applyToggle(false)}
                  disabled={loading || toggling}
                />
              </div>
            </CardContent>
          </Card>

          {/* Donut ring — success rate (fixed 7-day window, F05) */}
          <Card>
            <CardContent style={{ padding: "20px 24px" }}>
              <p className="metric-label" style={{ marginBottom: "4px" }}>Job Success Rate</p>
              <p style={{ fontSize: "11px", color: "#5C606B", marginBottom: "12px" }}>Last 7 days</p>
              <div className="flex items-center gap-5">
                <DonutRing pct={loading ? 0 : successRate} />
                <div className="flex flex-col gap-3">
                  <div>
                    <p style={{ fontSize: "11px", fontWeight: 600, color: "#5C606B",
                      textTransform: "uppercase", letterSpacing: "0.05em" }}>Successful</p>
                    <p style={{ fontSize: "18px", fontWeight: 700, color: "#22C55E", marginTop: "2px" }}>
                      {loading ? "—" : donutSuccess7}
                    </p>
                  </div>
                  <div>
                    <p style={{ fontSize: "11px", fontWeight: 600, color: "#5C606B",
                      textTransform: "uppercase", letterSpacing: "0.05em" }}>Total Runs</p>
                    <p style={{ fontSize: "18px", fontWeight: 700, color: "#9297A5", marginTop: "2px" }}>
                      {loading ? "—" : donutTotal}
                    </p>
                  </div>
                </div>
              </div>
              <div className="progress-bar mt-5">
                <div className="progress-fill" style={{ width: loading ? "0%" : `${successRate}%` }} />
              </div>
            </CardContent>
          </Card>

          {/* Job status panel (replaces bills) */}
          <Card>
            <CardHeader>
              <CardTitle>Job Status</CardTitle>
              <NavLink to="/logs" style={{ fontSize: "12px", color: "#06B6D4", textDecoration: "none" }}>
                View logs →
              </NavLink>
            </CardHeader>
            <CardContent style={{ padding: "16px 24px" }}>
              {[
                {
                  label: "Product Sync",
                  icon:  Package,
                  color: "#06B6D4",
                  run:   stats?.lastSyncRun ?? null,
                },
                {
                  label: "Order Routing",
                  icon:  ShoppingCart,
                  color: "#8B5CF6",
                  run:   stats?.lastOrderRoutingRun ?? null,
                },
                {
                  label: "Fulfillment",
                  icon:  ArrowUpRight,
                  color: "#22C55E",
                  run:   stats?.lastFulfillmentRun ?? null,
                },
              ].map(({ label, icon: JobIcon, color, run }, i) => {
                const t: StatusTone = run ? (toneMap[run.result] ?? "neutral") : "neutral";
                return (
                  <div key={i} className="flex items-center justify-between"
                    style={{ height: "48px", borderBottom: i < 2 ? "1px solid rgba(255,255,255,0.05)" : "none" }}>
                    <div className="flex items-center gap-3">
                      <div className="icon-chip" style={{ background: color + "1A", width: 36, height: 36, borderRadius: 10 }}>
                        <JobIcon size={15} style={{ color }} strokeWidth={1.8} />
                      </div>
                      <div>
                        <p style={{ fontSize: "13px", fontWeight: 500, color: "#C8CCDA" }}>{label}</p>
                        {run && (
                          <p style={{ fontSize: "11px", color: "#5C606B" }}>{fmt(run.runAt)}</p>
                        )}
                      </div>
                    </div>
                    {run
                      ? <StatusBadge label={run.result.replace(/_/g, " ")} tone={t} />
                      : <StatusBadge label="Never run" tone="neutral" />
                    }
                  </div>
                );
              })}
            </CardContent>
          </Card>

        </div>
      </div>

      {/* ── Confirm modal ─────────────────────────────────────────── */}
      <Modal open={confirm} onClose={() => setConfirm(false)}
        title="Enable auto-order?" description="This places real orders and updates live eBay listings.">
        <div className="flex items-start gap-3 rounded-xl p-4"
          style={{ background: "rgba(245,158,11,0.07)", border: "1px solid rgba(245,158,11,0.18)" }}>
          <ShieldAlert size={15} className="mt-0.5 shrink-0" style={{ color: "#F59E0B" }} />
          <p style={{ fontSize: "13px", color: "#9297A5" }}>
            Test with auto-order off first. Changes take effect immediately without restart.
          </p>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirm(false)}>Cancel</Button>
          <Button onClick={() => applyToggle(true)} disabled={toggling}>
            {toggling ? "Enabling…" : "Yes, enable"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
