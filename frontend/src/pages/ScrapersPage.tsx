import { useEffect, useState } from "react";
import {
  Radar, Plus, Trash2, RefreshCw, AlertTriangle,
  CheckCircle2, XCircle, HelpCircle, X,
} from "lucide-react";
import { PageHeader } from "../components/AppShell";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { StatusBadge, StatusTone } from "../components/ui/StatusBadge";
import { useToast } from "../components/ui/Toast";
import { api, Scraper, ApiError } from "../lib/api";
import { cn } from "../lib/cn";

// ── Status config ─────────────────────────────────────────────────────────────

const statusCfg: Record<
  Scraper["status"],
  { label: string; tone: StatusTone; Icon: typeof CheckCircle2 }
> = {
  connected: { label: "Connected", tone: "success", Icon: CheckCircle2 },
  failed:    { label: "Failed",    tone: "danger",  Icon: XCircle },
  untested:  { label: "Untested",  tone: "neutral", Icon: HelpCircle },
};

// ── Connect modal ─────────────────────────────────────────────────────────────

function ConnectModal({
  open,
  onClose,
  onConnected,
}: {
  open: boolean;
  onClose: () => void;
  onConnected: (s: Scraper) => void;
}) {
  const [token,   setToken]   = useState("");
  const [name,    setName]    = useState("");
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    if (!open) { setToken(""); setName(""); setError(null); }
  }, [open]);

  async function handleConnect() {
    if (!token.trim()) { setError("Paste the connection token from the scraper dashboard."); return; }
    setLoading(true); setError(null);
    try {
      const { scraper } = await api.connectScraper(token.trim(), name.trim() || undefined);
      onConnected(scraper);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to connect.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Connect scraper"
      description="Paste the connection token from the scraper's API Keys page."
      className="max-w-lg"
    >
      <div className="space-y-4">
        {/* Token field */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-3">Connection token</label>
          <textarea
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="sct_…"
            rows={3}
            autoFocus
            spellCheck={false}
            className="input resize-none font-mono text-sm"
          />
          <p className="text-xs text-ink-5">
            Generated in Scout dashboard → API Keys → Generate key.
          </p>
        </div>

        {/* Optional name override */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-3">
            Name <span className="text-ink-5">(optional — defaults to the scraper's hostname)</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Scout — production"
            className="input"
          />
        </div>

        {error && (
          <div
            className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm text-danger"
            style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)" }}
          >
            <AlertTriangle size={14} className="shrink-0" />{error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleConnect} disabled={loading}>
            {loading
              ? <><RefreshCw size={13} className="animate-spin" />Connecting...</>
              : <><Radar size={13} />Connect</>}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(ts: string) {
  return new Date(ts.replace(" ", "T") + "Z").toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function ScrapersPage() {
  const { showToast } = useToast();
  const [scrapers,     setScrapers]     = useState<Scraper[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [connectOpen,  setConnectOpen]  = useState(false);
  const [testingId,    setTestingId]    = useState<number | null>(null);

  const coreUrl = window.location.origin;

  useEffect(() => {
    api.listScrapers()
      .then(({ scrapers }) => setScrapers(scrapers ?? []))
      .catch(e => showToast(e instanceof ApiError ? e.message : "Failed to load.", "danger"))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line

  function onConnected(s: Scraper) {
    setScrapers(prev => {
      const idx = prev.findIndex(x => x.id === s.id);
      return idx >= 0 ? prev.map(x => x.id === s.id ? s : x) : [...prev, s];
    });
    showToast(
      s.status === "connected"
        ? `${s.name} connected successfully.`
        : `${s.name} saved — connection test failed. Check the token and try again.`,
      s.status === "connected" ? "success" : "danger"
    );
  }

  async function handleTest(s: Scraper) {
    setTestingId(s.id);
    try {
      const { scraper } = await api.testScraper(s.id);
      setScrapers(prev => prev.map(x => x.id === s.id ? scraper : x));
      showToast(
        scraper.status === "connected" ? `${s.name} — connected.` : `${s.name} — test failed.`,
        scraper.status === "connected" ? "success" : "danger"
      );
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Test failed.", "danger");
    } finally {
      setTestingId(null);
    }
  }

  async function handleDisconnect(s: Scraper) {
    if (!window.confirm(`Disconnect "${s.name}"? Core will stop pulling from it.`)) return;
    try {
      await api.disconnectScraper(s.id);
      setScrapers(prev => prev.filter(x => x.id !== s.id));
      showToast(`${s.name} disconnected.`, "info");
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "Failed.", "danger");
    }
  }

  return (
    <div>
      <PageHeader
        title="Scrapers"
        description="Connect scraping services that push trending candidates to Core"
        action={
          <Button onClick={() => setConnectOpen(true)}>
            <Plus size={14} />Connect scraper
          </Button>
        }
      />

      <div className="space-y-4 p-6">

        {/* How it works */}
        <div
          className="flex items-start gap-3 rounded-lg px-4 py-3"
          style={{ background: "rgba(6,182,212,0.07)", border: "1px solid rgba(6,182,212,0.18)" }}
        >
          <Radar size={14} className="mt-0.5 shrink-0 text-cyan" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-cyan">One token, instant connection</p>
            <p className="text-xs leading-relaxed text-cyan/70">
              Go to your scraper (e.g. Scout) → <strong>API Keys</strong> → Generate key →
              copy the connection token → click <strong>Connect scraper</strong> and paste it here.
              Core starts pulling automatically — no URL, no separate API key field.
            </p>
          </div>
        </div>

        {/* Scrapers table */}
        <Card>
          {loading ? (
            <div className="flex justify-center py-16">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-surface-3 border-t-cyan" />
            </div>
          ) : scrapers.length === 0 ? (
            <div className="flex flex-col items-center gap-4 py-16 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2">
                <Radar size={22} className="text-ink-5" />
              </div>
              <div>
                <p className="font-semibold text-ink">No scrapers connected</p>
                <p className="mt-1 text-sm text-ink-4">
                  Paste a connection token from Scout or any other scraper to get started.
                </p>
              </div>
              <Button onClick={() => setConnectOpen(true)}>
                <Plus size={14} />Connect scraper
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="dt">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>URL</th>
                    <th>Status</th>
                    <th>Last tested</th>
                    <th>Connected</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {scrapers.map(s => {
                    const sc = statusCfg[s.status];
                    return (
                      <tr key={s.id}>
                        <td>
                          <div className="flex items-center gap-2.5">
                            <div className={cn(
                              "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl",
                              s.status === "connected" ? "bg-success-bg"
                                : s.status === "failed" ? "bg-danger-bg" : "bg-surface-3"
                            )}>
                              <sc.Icon size={14} className={cn(
                                s.status === "connected" ? "text-success"
                                  : s.status === "failed" ? "text-danger" : "text-ink-5"
                              )} />
                            </div>
                            <span className="font-semibold text-ink">{s.name}</span>
                          </div>
                        </td>
                        <td>
                          <span
                            className="block max-w-[220px] truncate font-mono text-xs text-ink-4"
                            title={s.baseUrl}
                          >
                            {s.baseUrl}
                          </span>
                        </td>
                        <td>
                          <StatusBadge
                            label={sc.label}
                            tone={sc.tone}
                            pulse={s.status === "connected"}
                          />
                        </td>
                        <td className="text-xs text-ink-4">
                          {s.lastTestedAt ? fmt(s.lastTestedAt) : "Never"}
                        </td>
                        <td className="text-xs text-ink-5">{fmt(s.createdAt)}</td>
                        <td>
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost" size="sm"
                              onClick={() => handleTest(s)}
                              disabled={testingId === s.id}
                              title="Test connection"
                            >
                              <RefreshCw size={13} className={testingId === s.id ? "animate-spin" : ""} />
                              Test
                            </Button>
                            <Button
                              variant="ghost" size="sm"
                              onClick={() => handleDisconnect(s)}
                              title="Disconnect"
                            >
                              <X size={13} className="text-danger" />
                              Disconnect
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* How push works — same key, both directions */}
        <Card>
          <CardHeader><CardTitle>How the key is used</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-ink-4">
              The connection token you paste here covers <strong className="text-ink-3">both</strong> directions:
            </p>
            <div className="space-y-2 text-xs text-ink-4">
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 font-bold text-cyan">→</span>
                <p><strong className="text-ink-3">Pull</strong> — Core calls <code className="rounded bg-surface-2 px-1 text-cyan">GET /api/v1/scout-trends</code> on the scraper, using the same key as <code className="rounded bg-surface-2 px-1">Authorization: Bearer</code>.</p>
              </div>
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 font-bold text-cyan">←</span>
                <p><strong className="text-ink-3">Push</strong> — The scraper can also call <code className="rounded bg-surface-2 px-1 text-cyan">POST {coreUrl}/api/scouted</code> on Core with the same key. No extra setup.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <ConnectModal
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        onConnected={onConnected}
      />
    </div>
  );
}
