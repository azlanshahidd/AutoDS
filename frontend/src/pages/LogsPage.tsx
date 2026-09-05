import { useEffect, useState } from "react";
import { ScrollText, Trash2 } from "lucide-react";
import { PageHeader } from "../components/AppShell";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { StatusBadge, StatusTone } from "../components/ui/StatusBadge";
import { useToast } from "../components/ui/Toast";
import { api, LogRow, ApiError } from "../lib/api";
import { cn } from "../lib/cn";

const rTone: Record<string, StatusTone> = {
  success: "success", partial_failure: "warning", failure: "danger",
};
const tLabel: Record<string, string> = {
  price_stock: "Sync", order_routing: "Orders",
  fulfillment_tracking: "Fulfillment", scout_pull: "Scout",
};
const tStyle: Record<string, string> = {
  price_stock:          "bg-cyan-bg text-cyan",
  order_routing:        "bg-info-bg text-info",
  fulfillment_tracking: "bg-success-bg text-success",
  scout_pull:           "bg-warning-bg text-warning",
};
const filters = [
  { value: undefined,              label: "All" },
  { value: "price_stock",          label: "Sync" },
  { value: "order_routing",        label: "Orders" },
  { value: "fulfillment_tracking", label: "Fulfillment" },
  { value: "scout_pull",           label: "Scout" },  // F09
];

const fmt = (ts: string) =>
  new Date(ts.replace(" ", "T") + "Z").toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });

export function LogsPage() {
  const { showToast } = useToast();
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let c = false;
    async function load() {
      try {
        const { logs } = await api.listLogs(filter);
        if (!c) setLogs(logs ?? []);
      } catch (e) {
        if (!c) showToast(e instanceof ApiError ? e.message : "Failed.", "danger");
      } finally {
        if (!c) setLoading(false);
      }
    }
    setLoading(true);
    load();
    const id = setInterval(load, 8000);
    return () => { c = true; clearInterval(id); };
  }, [filter]); // eslint-disable-line

  async function handleDelete(id: number) {
    setDeletingId(id);
    try {
      await api.deleteLog(id);
      setLogs(p => p.filter(l => l.id !== id));
      showToast("Log entry deleted.", "info");
    } catch (e) { showToast(e instanceof ApiError ? e.message : "Failed.", "danger"); }
    finally { setDeletingId(null); }
  }

  async function handleClear() {
    const label = filter ? tLabel[filter] ?? filter : "all";
    if (!window.confirm(`Clear ${label} logs? This cannot be undone.`)) return;
    setClearing(true);
    try {
      const { deleted } = await api.clearLogs(filter);
      setLogs([]);
      showToast(`Cleared ${deleted} log entr${deleted !== 1 ? "ies" : "y"}.`, "info");
    } catch (e) { showToast(e instanceof ApiError ? e.message : "Failed.", "danger"); }
    finally { setClearing(false); }
  }

  return (
    <div>
      <PageHeader
        title="Logs"
        description="Every sync, routing, and fulfillment run"
        action={
          <div className="flex items-center gap-2">
            {/* Filter tabs */}
            <div className="flex gap-1 rounded-2xl p-1"
              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}>
              {filters.map(f => (
                <button key={f.label} onClick={() => setFilter(f.value)}
                  className={cn("rounded-xl px-4 py-1.5 text-xs font-semibold transition-all",
                    filter === f.value
                      ? "bg-cyan text-white shadow-glow-sm"
                      : "text-ink-4 hover:text-ink-3 hover:bg-surface-2")}>
                  {f.label}
                </button>
              ))}
            </div>
            {/* Clear button */}
            {logs.length > 0 && (
              <Button variant="danger" size="sm" onClick={handleClear} disabled={clearing}>
                <Trash2 size={13} />
                {clearing ? "Clearing..." : filter ? `Clear ${tLabel[filter] ?? filter}` : "Clear all"}
              </Button>
            )}
          </div>
        }
      />
      <div className="p-6">
        <Card>
          {loading ? (
            <div className="flex justify-center py-16">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-surface-3 border-t-cyan" />
            </div>
          ) : logs.length === 0 ? (
            <EmptyState icon={ScrollText} title="No logs yet" description="Run a sync cycle to see activity here." />
          ) : (
            <div className="overflow-x-auto">
              <table className="dt">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Type</th>
                    <th>Result</th>
                    <th>Details</th>
                    <th className="text-right">Delete</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map(l => {
                    const ts = tStyle[l.type] ?? "bg-surface-2 text-ink-4";
                    return (
                      <tr key={l.id}>
                        <td className="whitespace-nowrap text-xs text-ink-4">{fmt(l.run_at)}</td>
                        <td>
                          <span className={cn("rounded-lg px-2 py-0.5 text-xs font-semibold", ts)}>
                            {tLabel[l.type] ?? l.type}
                          </span>
                        </td>
                        <td>
                          <StatusBadge label={l.result.replace(/_/g, " ")} tone={rTone[l.result] ?? "neutral"} />
                        </td>
                        <td className="max-w-xs truncate text-xs text-ink-4" title={l.error_message ?? undefined}>
                          {l.error_message || <span className="text-ink-5">—</span>}
                        </td>
                        <td className="text-right">
                          <Button variant="ghost" size="sm"
                            onClick={() => handleDelete(l.id)}
                            disabled={deletingId === l.id}
                            title="Delete this entry">
                            <Trash2 size={13} className="text-danger" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

