/**
 * Analytics & Business Intelligence page.
 *
 * Sections:
 *   1. Margin alert banner (if any variants below floor)
 *   2. P&L summary stat cards + multi-line SVG chart (revenue / COGS / profit)
 *   3. Funnel bar chart (scout → approve → list → order → ship)
 *   4. Product performance table (sortable, CSV export)
 *   5. Supplier scorecards
 *
 * Charts reuse the same toSmoothPath / toAreaPath / SVG pattern as OverviewPage.
 * All monetary values are clearly labelled as estimates.
 */
import { useEffect, useState, useCallback, useRef } from "react";
import {
  TrendingUp, AlertTriangle, Download, RefreshCw,
  ChevronUp, ChevronDown, ChevronsUpDown, Package,
  Zap, ShoppingCart, Truck, BarChart2,
} from "lucide-react";
import { PageHeader } from "../components/AppShell";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { useToast } from "../components/ui/Toast";
import { StatusBadge } from "../components/ui/StatusBadge";
import {
  api, ApiError,
  AnalyticsSummary, AnalyticsDaySeries,
  AnalyticsProduct, SupplierScorecard,
  AnalyticsFunnel, MarginAlert,
} from "../lib/api";
import { cn } from "../lib/cn";

// ── Date helpers ──────────────────────────────────────────────────────────────

function toInputDate(d: Date) { return d.toISOString().slice(0, 10); }
function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
const fmtUSD = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const fmtPct = (n: number) => `${n.toFixed(1)}%`;

type Range = "7d" | "30d" | "90d" | "custom";

// ── SVG chart helpers (same pattern as OverviewPage) ─────────────────────────

const CW = 560, CH = 180, PAD = 28;

function toSmoothPath(data: number[], w: number, h: number, pad: number, maxVal: number): string {
  if (data.length < 2) return "";
  const pts = data.map((v, i) => ({
    x: pad + (i / (data.length - 1)) * (w - pad * 2),
    y: h - pad - (v / maxVal) * (h - pad * 2),
  }));
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], c = pts[i];
    const cx = (p.x + c.x) / 2;
    d += ` C ${cx} ${p.y}, ${cx} ${c.y}, ${c.x} ${c.y}`;
  }
  return d;
}

function toAreaPath(line: string, w: number, h: number, pad: number): string {
  if (!line) return "";
  return `${line} L ${pad + (w - pad * 2)} ${h - pad} L ${pad} ${h - pad} Z`;
}

// ── P&L multi-line chart ──────────────────────────────────────────────────────

function PLChart({ series }: { series: AnalyticsDaySeries[] }) {
  if (!series.length) return (
    <div className="flex items-center justify-center py-12 text-xs text-ink-5">No data for selected range.</div>
  );

  const revenues = series.map(d => d.revenue);
  const cogs     = series.map(d => d.cogs);
  const profits  = series.map(d => d.grossProfit);
  const dataMax  = Math.max(...revenues, ...cogs, ...profits.map(Math.abs), 1);
  const ceiling  = Math.ceil(dataMax * 1.2) || 1;

  const revPath  = toSmoothPath(revenues, CW, CH, PAD, ceiling);
  const cogPath  = toSmoothPath(cogs,     CW, CH, PAD, ceiling);
  const profPath = toSmoothPath(profits,  CW, CH, PAD, ceiling);
  const revArea  = toAreaPath(revPath,  CW, CH, PAD);
  const profArea = toAreaPath(profPath.replace(/^M/, "M"), CW, CH, PAD);

  const yLabels = Array.from({ length: 5 }, (_, i) => ({
    value: Math.round((1 - i / 4) * ceiling),
    y: CH - PAD - (1 - i / 4) * (CH - PAD * 2),
  }));

  const maxXLabels = 10;
  const xStep = Math.max(1, Math.ceil(series.length / maxXLabels));

  return (
    <svg viewBox={`0 0 ${CW} ${CH + 16}`} className="w-full" style={{ height: CH + 16, overflow: "visible" }}>
      <defs>
        <linearGradient id="revGrad"  x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#06B6D4" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#06B6D4" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="profGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#22C55E" stopOpacity="0.20" />
          <stop offset="100%" stopColor="#22C55E" stopOpacity="0" />
        </linearGradient>
      </defs>

      {yLabels.map(({ y }, i) => (
        <line key={i} x1={PAD} y1={y} x2={CW - PAD} y2={y}
          stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
      ))}
      {yLabels.map(({ value, y }) => (
        <text key={value} x={PAD - 5} y={y + 4} fontSize={9} fill="#5C606B" textAnchor="end">
          ${value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value}
        </text>
      ))}

      {revArea  && <path d={revArea}  fill="url(#revGrad)" />}
      {profArea && <path d={profArea} fill="url(#profGrad)" />}

      {cogPath  && <path d={cogPath}  fill="none" stroke="#EF4444" strokeWidth={1.5} strokeDasharray="4 3" opacity={0.7} />}
      {revPath  && <path d={revPath}  fill="none" stroke="#06B6D4" strokeWidth={2.5} strokeLinecap="round" />}
      {profPath && <path d={profPath} fill="none" stroke="#22C55E" strokeWidth={2}   strokeLinecap="round" />}

      {series.map((d, i) => {
        const x = PAD + (series.length > 1 ? i / (series.length - 1) : 0.5) * (CW - PAD * 2);
        const y = CH - PAD - (d.revenue / ceiling) * (CH - PAD * 2);
        return (
          <g key={i}>
            <circle cx={x} cy={y} r={2.5} fill="#06B6D4" />
            {i % xStep === 0 && (
              <text x={x} y={CH + 3} fontSize={9} fill="#5C606B" textAnchor="middle">
                {d.date.slice(5)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ── Funnel bar chart ──────────────────────────────────────────────────────────

function FunnelChart({ funnel }: { funnel: AnalyticsFunnel | null }) {
  if (!funnel) return <div className="py-10 text-center text-xs text-ink-5">Loading…</div>;

  const { detail } = funnel;
  const stages = [
    { label: "Scouted",       value: detail.totalScouted,  color: "#5C606B" },
    { label: "Pending",       value: detail.pending,        color: "#F59E0B" },
    { label: "Approved",      value: detail.approved,       color: "#06B6D4" },
    { label: "Discarded",     value: detail.discarded,      color: "#EF4444" },
    { label: "Published",     value: detail.published,      color: "#22C55E" },
    { label: "VeRO Blocked",  value: detail.veroBlocked,    color: "#A855F7" },
    { label: "Quality Fail",  value: detail.qualityFailed,  color: "#F97316" },
    { label: "Orders Placed", value: detail.ordersPlaced,   color: "#06B6D4" },
    { label: "Shipped",       value: detail.ordersShipped,  color: "#10B981" },
  ];

  const maxVal = Math.max(...stages.map(s => s.value), 1);

  return (
    <div className="space-y-2.5">
      {stages.map(({ label, value, color }) => {
        const pct = (value / maxVal) * 100;
        return (
          <div key={label} className="flex items-center gap-3">
            <span className="w-28 shrink-0 text-right text-xs text-ink-4">{label}</span>
            <div className="flex-1 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.05)", height: 14 }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${pct}%`, background: color, opacity: value === 0 ? 0.2 : 0.8 }}
              />
            </div>
            <span className="w-10 shrink-0 text-right font-mono text-xs font-semibold text-ink-3">{value}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }: {
  label: string; value: string; sub?: string; accent?: "success" | "danger" | "warning" | "cyan";
}) {
  const colors: Record<string, string> = {
    success: "#22C55E", danger: "#EF4444", warning: "#F59E0B", cyan: "#06B6D4",
  };
  return (
    <div className="flex flex-col gap-1 rounded-2xl px-5 py-4"
      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
      <p className="text-xs font-medium text-ink-5">{label}</p>
      <p className="text-2xl font-bold" style={{ color: accent ? colors[accent] : "#F5F5F7" }}>{value}</p>
      {sub && <p className="text-xs text-ink-5">{sub}</p>}
    </div>
  );
}

// ── Sort helpers for product table ────────────────────────────────────────────

type SortKey = "productTitle" | "supplierType" | "marginPct" | "orderCount" | "estimatedRevenue" | "estimatedProfit" | "currentPrice" | "currentStock" | "daysListed" | "grossProfitPerUnit";
type SortDir = "asc" | "desc";

function SortIcon({ col, active, dir }: { col: string; active: boolean; dir: SortDir }) {
  if (!active) return <ChevronsUpDown size={11} className="text-ink-5 ml-1 inline" />;
  return dir === "asc"
    ? <ChevronUp size={11} className="text-cyan ml-1 inline" />
    : <ChevronDown size={11} className="text-cyan ml-1 inline" />;
}

// ── CSV export ────────────────────────────────────────────────────────────────

function exportCSV(rows: AnalyticsProduct[], filename: string) {
  const headers = [
    "Title", "SKU", "eBay SKU", "Supplier", "Cost", "Shipping", "eBay Fee",
    "List Price", "Stock", "Profit/Unit", "Margin %", "Orders", "Est. Revenue", "Est. Profit", "Days Listed",
  ];
  const lines = [
    headers.join(","),
    ...rows.map(r => [
      `"${r.productTitle.replace(/"/g, '""')}"`,
      r.internalSku, r.ebaySku ?? "",
      r.supplierType,
      r.cost, r.shippingCost, r.ebayFee,
      r.currentPrice, r.currentStock,
      r.grossProfitPerUnit, r.marginPct,
      r.orderCount, r.estimatedRevenue, r.estimatedProfit,
      r.daysListed ?? "",
    ].join(",")),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function exportSupplierCSV(rows: SupplierScorecard[]) {
  const headers = ["Supplier", "Variants", "Avg Margin %", "Total Orders", "Failed Orders", "Failure Rate %", "Avg Days to Ship"];
  const lines = [
    headers.join(","),
    ...rows.map(r => [
      r.supplierType, r.variantCount,
      r.avgMarginPct ?? "", r.totalOrders,
      r.failedOrders, r.failureRate,
      r.avgDaysToShip ?? "",
    ].join(",")),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = "supplier-scorecards.csv"; a.click();
  URL.revokeObjectURL(url);
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function AnalyticsPage() {
  const { showToast } = useToast();

  // Range selector
  const [range,       setRange]       = useState<Range>("30d");
  const [customFrom,  setCustomFrom]  = useState(() => toInputDate(daysAgo(29)));
  const [customTo,    setCustomTo]    = useState(() => toInputDate(new Date()));
  const [showPicker,  setShowPicker]  = useState(false);

  // Data state
  const [summary,  setSummary]  = useState<AnalyticsSummary | null>(null);
  const [products, setProducts] = useState<AnalyticsProduct[]>([]);
  const [suppliers,setSuppliers]= useState<SupplierScorecard[]>([]);
  const [funnel,   setFunnel]   = useState<AnalyticsFunnel | null>(null);
  const [alerts,   setAlerts]   = useState<MarginAlert[]>([]);
  const [floorPct, setFloorPct] = useState(10);
  const [loading,  setLoading]  = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Product table sort
  const [sortKey, setSortKey]   = useState<SortKey>("orderCount");
  const [sortDir, setSortDir]   = useState<SortDir>("desc");
  const [searchQ, setSearchQ]   = useState("");

  // Compute from/to for current range selection
  const { fromDate, toDate } = (() => {
    if (range === "custom") return { fromDate: customFrom, toDate: customTo };
    const to = toInputDate(new Date());
    const days = range === "7d" ? 6 : range === "30d" ? 29 : 89;
    return { fromDate: toInputDate(daysAgo(days)), toDate: to };
  })();

  const loadAll = useCallback(async (from: string, to: string, silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    try {
      const [sum, prod, sup, fun, mar] = await Promise.all([
        api.getAnalyticsSummary(from, to),
        api.getAnalyticsProducts(),
        api.getAnalyticsSuppliers(),
        api.getAnalyticsFunnel(from, to),
        api.getMarginAlerts(),
      ]);
      setSummary(sum);
      setProducts(prod.products);
      setSuppliers(sup.scorecards);
      setFunnel(fun);
      setAlerts(mar.alerts);
      setFloorPct(mar.floorPct);
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Failed to load analytics.", "danger");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [showToast]);

  // Load on mount + on range change
  const prevRange = useRef({ fromDate, toDate });
  useEffect(() => {
    if (prevRange.current.fromDate !== fromDate || prevRange.current.toDate !== toDate) {
      prevRange.current = { fromDate, toDate };
    }
    loadAll(fromDate, toDate);
  }, [fromDate, toDate]); // eslint-disable-line

  // Sort + filter products
  const sortedProducts = [...products]
    .filter(p =>
      !searchQ ||
      p.productTitle.toLowerCase().includes(searchQ.toLowerCase()) ||
      p.internalSku.toLowerCase().includes(searchQ.toLowerCase())
    )
    .sort((a, b) => {
      const av = a[sortKey] ?? 0, bv = b[sortKey] ?? 0;
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === "asc"
        ? (av as number) - (bv as number)
        : (bv as number) - (av as number);
    });

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  function Th({ k, label }: { k: SortKey; label: string }) {
    return (
      <th className="cursor-pointer select-none hover:text-ink-3"
        onClick={() => toggleSort(k)}>
        {label}<SortIcon col={k} active={sortKey === k} dir={sortDir} />
      </th>
    );
  }

  // Range preset button
  function RangeBtn({ r, label }: { r: Range; label: string }) {
    return (
      <button
        type="button"
        onClick={() => { setRange(r); if (r !== "custom") setShowPicker(false); else setShowPicker(true); }}
        className={cn(
          "rounded-lg border px-3 py-1 text-xs font-semibold transition-all",
          range === r
            ? "border-cyan/40 bg-cyan text-white"
            : "text-ink-5 hover:text-ink-3"
        )}
        style={range !== r ? { border: "1px solid rgba(6,182,212,0.2)" } : {}}
      >
        {label}
      </button>
    );
  }

  if (loading) return (
    <div>
      <PageHeader title="Analytics" description="Business intelligence — estimated figures based on current snapshot data" />
      <div className="flex justify-center py-32">
        <div className="h-7 w-7 animate-spin rounded-full border-2 border-surface-3 border-t-cyan" />
      </div>
    </div>
  );

  const t = summary?.totals;

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Business intelligence — estimated figures based on current snapshot data"
        action={
          <Button variant="ghost" size="sm" onClick={() => loadAll(fromDate, toDate, true)} disabled={refreshing}>
            <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
            Refresh
          </Button>
        }
      />

      <div className="space-y-6 p-6">

        {/* ── Margin alert banner ──────────────────────────────────────── */}
        {alerts.length > 0 && (
          <div className="flex items-start gap-3 rounded-2xl px-5 py-4"
            style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)" }}>
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" />
            <div>
              <p className="text-sm font-semibold text-danger">
                {alerts.length} listing{alerts.length !== 1 ? "s" : ""} below {floorPct}% margin floor
              </p>
              <p className="mt-0.5 text-xs text-ink-4">
                {alerts.slice(0, 3).map(a => a.productTitle).join(", ")}
                {alerts.length > 3 && ` and ${alerts.length - 3} more.`}
                {" "}Scroll to Margin Alerts below to review.
              </p>
            </div>
          </div>
        )}

        {/* ── Range selector ───────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2">
          <RangeBtn r="7d"     label="7 days" />
          <RangeBtn r="30d"    label="30 days" />
          <RangeBtn r="90d"    label="90 days" />
          <RangeBtn r="custom" label="Custom" />
          {(range === "custom" || showPicker) && (
            <div className="flex items-center gap-2 ml-1">
              <input type="date" value={customFrom} max={customTo}
                onChange={e => setCustomFrom(e.target.value)}
                className="input text-xs py-1" style={{ width: 130 }} />
              <span className="text-xs text-ink-5">to</span>
              <input type="date" value={customTo} min={customFrom}
                onChange={e => setCustomTo(e.target.value)}
                className="input text-xs py-1" style={{ width: 130 }} />
            </div>
          )}
          {summary?.note && (
            <span className="ml-auto text-xs text-ink-5 italic">{summary.note}</span>
          )}
        </div>

        {/* ── P&L stat cards ───────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard label="Est. Revenue"     value={fmtUSD(t?.revenue ?? 0)}     accent="cyan" />
          <StatCard label="Est. COGS"        value={fmtUSD(t?.cogs ?? 0)}        accent="danger" />
          <StatCard label="Est. Gross Profit" value={fmtUSD(t?.grossProfit ?? 0)} accent={(t?.grossProfit ?? 0) >= 0 ? "success" : "danger"} />
          <StatCard label="Gross Margin"     value={fmtPct(t?.marginPct ?? 0)}   accent={(t?.marginPct ?? 0) >= (t?.marginFloor ?? 10) ? "success" : "warning"} />
          <StatCard label="Total Orders"     value={String(t?.ordersTotal ?? 0)} />
          <StatCard label="Variants Listed"  value={String(t?.variantsListed ?? 0)} />
        </div>

        {/* ── P&L chart ────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold text-ink-3">
                Revenue vs COGS vs Gross Profit
              </CardTitle>
              <div className="flex items-center gap-4 text-xs">
                <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-5 rounded-full" style={{ background: "#06B6D4" }} />Revenue</span>
                <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-5 rounded-full" style={{ background: "#EF4444" }} />COGS</span>
                <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-5 rounded-full" style={{ background: "#22C55E" }} />Profit</span>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <PLChart series={summary?.series ?? []} />
          </CardContent>
        </Card>

        {/* ── Funnel + Supplier scorecards side by side ─────────────────── */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">

          {/* Funnel */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold text-ink-3 flex items-center gap-2">
                  <BarChart2 size={14} className="text-cyan" />
                  Listing Funnel
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <FunnelChart funnel={funnel} />
              {funnel && (
                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  {[
                    { label: "Approval rate",  value: funnel.detail.totalScouted
                        ? fmtPct((funnel.detail.approved / funnel.detail.totalScouted) * 100) : "—" },
                    { label: "Listing rate",   value: funnel.detail.approved
                        ? fmtPct((funnel.detail.published / funnel.detail.approved) * 100) : "—" },
                    { label: "Conversion",     value: funnel.detail.published
                        ? fmtPct((funnel.detail.ordersPlaced / funnel.detail.published) * 100) : "—" },
                  ].map(({ label, value }) => (
                    <div key={label} className="rounded-xl py-2.5"
                      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
                      <p className="text-lg font-bold text-ink">{value}</p>
                      <p className="text-xs text-ink-5">{label}</p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Supplier scorecards */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold text-ink-3 flex items-center gap-2">
                  <Zap size={14} className="text-cyan" />
                  Supplier Scorecards
                </CardTitle>
                {suppliers.length > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => exportSupplierCSV(suppliers)}>
                    <Download size={12} />CSV
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {suppliers.length === 0 ? (
                <p className="py-8 text-center text-xs text-ink-5">No supplier data yet.</p>
              ) : (
                <div className="space-y-3">
                  {suppliers.map(s => (
                    <div key={s.supplierType} className="rounded-xl px-4 py-3.5 space-y-2.5"
                      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="flex h-7 w-7 items-center justify-center rounded-lg"
                            style={{ background: "rgba(6,182,212,0.12)" }}>
                            <Zap size={12} className="text-cyan" />
                          </div>
                          <span className="font-semibold text-sm text-ink">{s.supplierType}</span>
                        </div>
                        <StatusBadge
                          label={s.failureRate > 20 ? "High failure" : s.failureRate > 5 ? "Some failures" : "Healthy"}
                          tone={s.failureRate > 20 ? "danger" : s.failureRate > 5 ? "warning" : "success"}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                        {[
                          ["Variants listed", s.variantCount],
                          ["Total orders",    s.totalOrders],
                          ["Placed orders",   s.placedOrders],
                          ["Failed orders",   s.failedOrders],
                          ["Failure rate",    s.failureRate !== null ? fmtPct(s.failureRate) : "—"],
                          ["Avg margin",      s.avgMarginPct !== null ? fmtPct(s.avgMarginPct) : "—"],
                          ["Avg ship time",   s.avgDaysToShip !== null ? `${s.avgDaysToShip}d` : "—"],
                        ].map(([label, val]) => (
                          <div key={label as string} className="flex items-center justify-between">
                            <span className="text-ink-5">{label}</span>
                            <span className="font-semibold text-ink-3">{val}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Product performance table ─────────────────────────────────── */}
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-sm font-semibold text-ink-3 flex items-center gap-2">
                <Package size={14} className="text-cyan" />
                Product Performance
                <span className="ml-1 text-xs font-normal text-ink-5">({sortedProducts.length} listings)</span>
              </CardTitle>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={searchQ}
                  onChange={e => setSearchQ(e.target.value)}
                  placeholder="Search title or SKU…"
                  className="input text-xs py-1.5"
                  style={{ width: 200 }}
                />
                <Button variant="ghost" size="sm"
                  onClick={() => exportCSV(sortedProducts, `products-${fromDate}-${toDate}.csv`)}>
                  <Download size={12} />CSV
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {sortedProducts.length === 0 ? (
              <p className="py-8 text-center text-xs text-ink-5">
                {products.length === 0 ? "No listed products yet." : "No results match your search."}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="dt text-xs">
                  <thead>
                    <tr>
                      <Th k="productTitle"     label="Product" />
                      <Th k="supplierType"     label="Supplier" />
                      <Th k="currentPrice"     label="Price" />
                      <Th k="grossProfitPerUnit" label="Profit/Unit" />
                      <Th k="marginPct"        label="Margin %" />
                      <Th k="currentStock"     label="Stock" />
                      <Th k="orderCount"       label="Orders" />
                      <Th k="estimatedRevenue" label="Est. Revenue" />
                      <Th k="estimatedProfit"  label="Est. Profit" />
                      <Th k="daysListed"       label="Days Listed" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedProducts.map(p => {
                      const marginOk = p.marginPct >= floorPct;
                      return (
                        <tr key={p.internalSku}>
                          <td>
                            <div>
                              <p className="font-semibold text-ink leading-snug max-w-xs truncate" title={p.productTitle}>
                                {p.productTitle}
                              </p>
                              <p className="text-ink-5 font-mono">{p.internalSku}</p>
                            </div>
                          </td>
                          <td className="text-ink-4">{p.supplierType}</td>
                          <td className="font-mono text-ink">{fmtUSD(p.currentPrice)}</td>
                          <td className={cn("font-mono font-semibold",
                            p.grossProfitPerUnit >= 0 ? "text-success" : "text-danger")}>
                            {fmtUSD(p.grossProfitPerUnit)}
                          </td>
                          <td>
                            <span className={cn("font-semibold", marginOk ? "text-success" : "text-danger")}>
                              {fmtPct(p.marginPct)}
                            </span>
                            {!marginOk && (
                              <AlertTriangle size={10} className="ml-1 inline text-danger" />
                            )}
                          </td>
                          <td className="font-mono text-ink-4">{p.currentStock}</td>
                          <td className="font-mono font-semibold text-ink">{p.orderCount}</td>
                          <td className="font-mono text-ink-3">{fmtUSD(p.estimatedRevenue)}</td>
                          <td className={cn("font-mono font-semibold",
                            p.estimatedProfit >= 0 ? "text-success" : "text-danger")}>
                            {fmtUSD(p.estimatedProfit)}
                          </td>
                          <td className="text-ink-5">
                            {p.daysListed !== null ? `${p.daysListed}d` : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Margin Alerts ─────────────────────────────────────────────── */}
        {alerts.length > 0 && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold text-danger flex items-center gap-2">
                  <AlertTriangle size={14} />
                  Margin Alerts — below {floorPct}% floor
                  <span className="ml-1 rounded-full px-2 py-0.5 text-xs font-semibold"
                    style={{ background: "rgba(239,68,68,0.12)", color: "#EF4444" }}>
                    {alerts.length}
                  </span>
                </CardTitle>
                <Button variant="ghost" size="sm" onClick={() => {
                  const lines = [
                    ["Title","SKU","Supplier","Cost","Ship","Fee","Price","Profit","Margin%","Last Sync"].join(","),
                    ...alerts.map(a => [
                      `"${a.productTitle.replace(/"/g,'""')}"`,
                      a.internalSku, a.supplierType,
                      a.cost, a.shippingCost, a.ebayFee,
                      a.currentPrice, a.grossProfit, a.marginPct,
                      a.lastSyncedAt ?? "",
                    ].join(",")),
                  ];
                  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
                  const u = URL.createObjectURL(blob);
                  const a2 = document.createElement("a"); a2.href=u; a2.download="margin-alerts.csv"; a2.click();
                  URL.revokeObjectURL(u);
                }}>
                  <Download size={12} />CSV
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="dt text-xs">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Supplier</th>
                      <th>Cost</th>
                      <th>Ship</th>
                      <th>eBay Fee</th>
                      <th>List Price</th>
                      <th>Profit/Unit</th>
                      <th>Margin %</th>
                      <th>Last Sync</th>
                    </tr>
                  </thead>
                  <tbody>
                    {alerts.map(a => (
                      <tr key={a.internalSku}>
                        <td>
                          <p className="font-semibold text-ink max-w-xs truncate" title={a.productTitle}>{a.productTitle}</p>
                          <p className="font-mono text-ink-5">{a.internalSku}</p>
                        </td>
                        <td className="text-ink-4">{a.supplierType}</td>
                        <td className="font-mono text-ink-3">{fmtUSD(a.cost)}</td>
                        <td className="font-mono text-ink-3">{fmtUSD(a.shippingCost)}</td>
                        <td className="font-mono text-ink-3">{fmtUSD(a.ebayFee)}</td>
                        <td className="font-mono text-ink">{fmtUSD(a.currentPrice)}</td>
                        <td className={cn("font-mono font-semibold", a.grossProfit >= 0 ? "text-warning" : "text-danger")}>
                          {fmtUSD(a.grossProfit)}
                        </td>
                        <td className="font-semibold text-danger">{fmtPct(a.marginPct)}</td>
                        <td className="text-ink-5 text-xs">
                          {a.lastSyncedAt
                            ? new Date(a.lastSyncedAt.replace(" ","T")+"Z").toLocaleDateString(undefined,{month:"short",day:"numeric"})
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

      </div>
    </div>
  );
}
